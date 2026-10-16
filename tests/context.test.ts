import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildContext, groupIntoTurns, todayIn } from "@/harness/context";
import { saveMemory, forgetMemory } from "@/harness/memory";
import { makeUser } from "./helpers";

let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const NOW = new Date("2026-10-16T12:00:00Z");

describe("buildContext", () => {
  it("renders the date in the user's timezone", () => {
    // 01:00 UTC on the 17th is still the 16th in Buenos Aires (UTC-3).
    expect(todayIn("America/Argentina/Buenos_Aires", new Date("2026-10-17T01:00:00Z"))).toBe("2026-10-16");
    expect(todayIn("UTC", new Date("2026-10-17T01:00:00Z"))).toBe("2026-10-17");
  });

  it("includes active memories, excludes forgotten and other conversations' memories", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    const other = await db.conversation.create({ data: { userId: u.userId } });
    await saveMemory({ userId: u.userId, scope: "USER", key: "reply_language", content: "Spanish" });
    await saveMemory({ userId: u.userId, scope: "USER", key: "home_city", content: "Córdoba" });
    await forgetMemory({ userId: u.userId, conversationId: u.conversationId, key: "home_city" });
    await saveMemory({ userId: u.userId, scope: "CONVERSATION", conversationId: other.id, key: "length", content: "answers under ten words" });
    await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "hi" } });

    const ctx = await buildContext({ userId: u.userId, conversationId: u.conversationId, now: NOW, promptVersion: "v2" });
    const system = ctx.messages[0]!.content;

    expect(system).toContain("reply_language: Spanish");
    expect(system).not.toContain("Córdoba");
    expect(system).not.toContain("answers under ten words");
    expect(system).toContain("Today is 2026-10-16");
    expect(ctx.includedMemoryIds).toHaveLength(1);
  });

  it("shows overdue tasks in the snapshot and points to list_tasks for the rest", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    await db.task.createMany({
      data: [
        { userId: u.userId, title: "Late proposal", dueDate: new Date("2026-10-14T00:00:00Z") },
        { userId: u.userId, title: "Someday task" },
      ],
    });
    await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "hi" } });
    const ctx = await buildContext({ userId: u.userId, conversationId: u.conversationId, now: NOW, promptVersion: "v2" });
    const system = ctx.messages[0]!.content;
    expect(system).toMatch(/Late proposal \(due 2026-10-14 OVERDUE\)/);
    expect(system).not.toContain("Someday task");
    expect(system).toContain("1 more open tasks");
  });

  it("drops whole old turns when over budget, never orphaning tool results", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    const long = "x".repeat(2000); // ~500 tokens
    for (let i = 0; i < 6; i++) {
      await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: `question ${i} ${long}` } });
      await db.message.create({
        data: { conversationId: u.conversationId, role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "list_tasks", arguments: "{}" }] },
      });
      await db.message.create({ data: { conversationId: u.conversationId, role: "tool", content: '{"ok":true,"data":[]}', toolCallId: `c${i}`, toolName: "list_tasks" } });
      await db.message.create({ data: { conversationId: u.conversationId, role: "assistant", content: `answer ${i}` } });
    }
    await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "current question" } });

    const ctx = await buildContext({ userId: u.userId, conversationId: u.conversationId, now: NOW, promptVersion: "v2", budget: 3500 });
    const history = ctx.messages.slice(1);

    expect(history.at(-1)).toMatchObject({ role: "user", content: "current question" });
    expect(ctx.droppedMessages.length).toBeGreaterThan(0);
    expect(ctx.droppedMessages.length % 4).toBe(0); // whole turns only

    // Every tool message is preceded by the assistant message that called it.
    const calledIds = new Set<string>();
    for (const m of history) {
      if (m.role === "assistant") m.toolCalls?.forEach((c) => calledIds.add(c.id));
      if (m.role === "tool") expect(calledIds.has(m.toolCallId)).toBe(true);
    }
    expect(history[0]!.role).toBe("user");
  });

  it("always includes the current message even if it alone exceeds the budget", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "y".repeat(40_000) } });
    const ctx = await buildContext({ userId: u.userId, conversationId: u.conversationId, now: NOW, promptVersion: "v2", budget: 2000 });
    expect(ctx.messages).toHaveLength(2);
  });

  it("uses the summary and skips messages it covers", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    const old = await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "old message" } });
    await db.conversation.update({ where: { id: u.conversationId }, data: { summary: "User prefers mornings.", summarizedThroughSeq: old.seq } });
    await db.message.create({ data: { conversationId: u.conversationId, role: "user", content: "new message" } });

    const ctx = await buildContext({ userId: u.userId, conversationId: u.conversationId, now: NOW, promptVersion: "v2" });
    expect(ctx.messages[0]!.content).toContain("<summary>\nUser prefers mornings.");
    expect(ctx.messages.map((m) => m.content)).not.toContain("old message");
    expect(ctx.messages.at(-1)!.content).toBe("new message");
  });

  it("refuses to build context for a conversation the user does not own", async () => {
    const a = await makeUser();
    const b = await makeUser();
    cleanup = async () => {
      await a.cleanup();
      await b.cleanup();
    };
    await expect(buildContext({ userId: a.userId, conversationId: b.conversationId, now: NOW, promptVersion: "v2" })).rejects.toThrow();
  });
});

describe("groupIntoTurns", () => {
  it("starts a new turn at every user message", () => {
    const m = (role: "user" | "assistant" | "tool") => ({ role }) as never;
    const turns = groupIntoTurns([m("user"), m("assistant"), m("tool"), m("assistant"), m("user"), m("assistant")]);
    expect(turns.map((t) => t.length)).toEqual([4, 2]);
  });
});
