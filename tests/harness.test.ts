import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runTurn } from "@/harness/harness";
import { callTool, ModelError, say, ScriptedModel, type ScriptStep } from "@/harness/model";
import { detectUnbackedClaims } from "@/harness/claims";
import { makeUser } from "./helpers";

let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const NOW = new Date("2026-10-16T12:00:00Z");

async function setup() {
  const u = await makeUser("Sam");
  cleanup = u.cleanup;
  return u;
}

describe("runTurn", () => {
  it("runs a tool, feeds the result back, and stores messages and a trace", async () => {
    const u = await setup();
    const model = new ScriptedModel([
      callTool("create_task", { title: "Call Lena", due_date: "2026-10-23" }),
      (req) => {
        const toolMsg = req.messages.at(-1)!;
        expect(toolMsg.role).toBe("tool");
        expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: true });
        return { content: "Added “Call Lena” for Friday, Oct 23.", toolCalls: [] };
      },
    ]);

    const r = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "Remind me to call Lena next Friday", model, now: NOW });

    expect(r.reply).toContain("Call Lena");
    expect(r.trace.toolCalls).toMatchObject([{ name: "create_task", ok: true }]);
    expect(r.trace.unbackedClaims).toEqual([]);
    expect(await db.task.count({ where: { userId: u.userId } })).toBe(1);

    const roles = (await db.message.findMany({ where: { conversationId: u.conversationId }, orderBy: { seq: "asc" } })).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(await db.turnTrace.count({ where: { conversationId: u.conversationId } })).toBe(1);
  });

  it("passes tool failures to the model and flags a reply that claims success anyway", async () => {
    const u = await setup();
    const model = new ScriptedModel([
      callTool("complete_task", { task_id: "nope" }),
      (req) => {
        expect(JSON.parse(req.messages.at(-1)!.content)).toMatchObject({ ok: false, code: "not_found" });
        // A misbehaving model that ignores the failure:
        return { content: "Done! I've marked it as done.", toolCalls: [] };
      },
    ]);
    const r = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "Mark the report done", model, now: NOW });
    expect(r.trace.unbackedClaims).toEqual(["complete_task"]);
    const trace = await db.turnTrace.findFirstOrThrow({ where: { conversationId: u.conversationId } });
    expect(trace.unbackedClaims).toEqual(["complete_task"]);
  });

  it("stops at the step limit with an honest reply listing only real actions", async () => {
    const u = await setup();
    const loop: ScriptStep[] = Array.from({ length: 5 }, (_, i) => callTool("search_notes", { query: `attempt ${i}` }));
    const model = new ScriptedModel([callTool("create_task", { title: "Real task" }), ...loop]);
    const r = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "go", model, now: NOW });
    expect(r.trace.error).toBe("step_limit");
    expect(r.reply).toContain("create_task");
    expect(r.reply).not.toContain("search_notes");
  });

  it("retries a retryable model error once, then answers without inventing actions", async () => {
    const u = await setup();
    let calls = 0;
    const failing = { name: "flaky", complete: async () => { calls++; throw new ModelError("HTTP 503", true); } };
    const r = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "hi", model: failing, now: NOW });
    expect(calls).toBe(2);
    expect(r.reply).toMatch(/Nothing was changed/);
    expect(r.trace.error).toContain("503");
  });

  it("a retried request with the same requestId replays the reply without calling the model", async () => {
    const u = await setup();
    const requestId = randomUUID();
    const first = await runTurn({
      userId: u.userId,
      conversationId: u.conversationId,
      text: "Add task Pay rent",
      requestId,
      model: new ScriptedModel([callTool("create_task", { title: "Pay rent" }), say("Added “Pay rent”.")]),
      now: NOW,
    });
    const retry = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "Add task Pay rent", requestId, model: new ScriptedModel([]), now: NOW });

    expect(retry.replayed).toBe(true);
    expect(retry.reply).toBe(first.reply);
    expect(await db.task.count({ where: { userId: u.userId } })).toBe(1);
    expect(await db.message.count({ where: { conversationId: u.conversationId, role: "user" } })).toBe(1);
  });

  it("resuming an interrupted turn does not repeat its side effects", async () => {
    const u = await setup();
    const requestId = randomUUID();
    // First attempt: the task is created, then the model call crashes the process (non-retryable).
    let step = 0;
    const crashing = {
      name: "crashing",
      complete: async () => {
        if (step++ === 0) return { content: "", toolCalls: [{ id: "c1", name: "create_task", arguments: JSON.stringify({ title: "Pay rent" }) }] };
        throw new Error("process killed");
      },
    };
    await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "Add task Pay rent", requestId, model: crashing, now: NOW });
    // Simulate a crash that lost the final reply: remove everything after the user message.
    const userMsg = await db.message.findUniqueOrThrow({ where: { requestId } });
    await db.message.deleteMany({ where: { conversationId: u.conversationId, seq: { gt: userMsg.seq }, role: "assistant", content: { contains: "went wrong" } } });

    const retry = await runTurn({
      userId: u.userId,
      conversationId: u.conversationId,
      text: "Add task Pay rent",
      requestId,
      model: new ScriptedModel([callTool("create_task", { title: "Pay rent" }), say("Added “Pay rent”.")]),
      now: NOW,
    });

    expect(retry.trace.toolCalls).toMatchObject([{ name: "create_task", ok: true, deduplicated: true }]);
    expect(await db.task.count({ where: { userId: u.userId } })).toBe(1);
  });

  it("summarizes turns that fall out of the context window", async () => {
    const u = await setup();
    const long = "z".repeat(3000);
    for (let i = 0; i < 4; i++) {
      await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: `old ${i} ${long}` } });
      await db.message.create({ data: { conversationId: u.conversationId, role: "assistant", content: `reply ${i}` } });
    }
    const model = new ScriptedModel([say("Here you go."), say("User discussed four older topics.")]);
    const r = await runTurn({ userId: u.userId, conversationId: u.conversationId, text: "new", model, now: NOW, budget: 3500 });

    expect(r.trace.droppedMessageCount).toBeGreaterThan(0);
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: u.conversationId } });
    expect(conv.summary).toBe("User discussed four older topics.");
    expect(conv.summarizedThroughSeq).not.toBeNull();
    // The summarizer got the dropped messages, not the kept ones.
    expect(model.requests[1]!.messages[1]!.content).toContain("old 0");
    expect(model.requests[1]!.messages[1]!.content).not.toContain("user: new");
  });

  it("rejects a conversation that belongs to someone else", async () => {
    const u = await setup();
    const other = await makeUser();
    try {
      await expect(runTurn({ userId: u.userId, conversationId: other.conversationId, text: "hi", model: new ScriptedModel([say("x")]), now: NOW })).rejects.toThrow();
      expect(await db.message.count({ where: { conversationId: other.conversationId } })).toBe(0);
    } finally {
      await other.cleanup();
    }
  });
});

describe("detectUnbackedClaims", () => {
  it("flags claims without a matching successful call, in English and Spanish", () => {
    expect(detectUnbackedClaims("I've added the task.", [])).toEqual(["create_task"]);
    expect(detectUnbackedClaims("Listo, agregué la tarea.", [])).toEqual(["create_task"]);
    expect(detectUnbackedClaims("I've added the task.", [{ name: "create_task", ok: true }])).toEqual([]);
    expect(detectUnbackedClaims("I've added the task.", [{ name: "create_task", ok: false }])).toEqual(["create_task"]);
    expect(detectUnbackedClaims("Got it, I'll remember that.", [])).toEqual(["remember"]);
    expect(detectUnbackedClaims("You have 3 tasks due this week.", [])).toEqual([]);
  });
});
