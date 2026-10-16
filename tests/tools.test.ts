import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { executeToolCall, toolSpecs } from "@/harness/tools";
import { call, makeUser, toolCtx } from "./helpers";

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup() {
  const u = await makeUser();
  cleanups.push(u.cleanup);
  return { ...u, ctx: await toolCtx(u.userId, u.conversationId) };
}

describe("tool validation", () => {
  it("exposes JSON schemas generated from the same zod schemas used to validate", () => {
    const create = toolSpecs.find((t) => t.name === "create_task")!;
    expect(create.parameters).toMatchObject({ type: "object", required: ["title"] });
  });

  it("rejects unknown tools, bad JSON and invalid arguments without side effects", async () => {
    const { ctx, userId } = await setup();
    expect(await executeToolCall(ctx, call("delete_everything", {}))).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(await executeToolCall(ctx, call("create_task", "{not json"))).toMatchObject({ ok: false, code: "invalid_arguments" });

    const bad = await executeToolCall(ctx, call("create_task", { title: "x", due_date: "next friday" }));
    expect(bad).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(!bad.ok && bad.error).toContain("due_date");

    expect(await executeToolCall(ctx, call("create_task", { title: "x", due_date: "2026-02-30" }))).toMatchObject({ ok: false });
    expect(await db.task.count({ where: { userId } })).toBe(0);
  });
});

describe("create_task", () => {
  it("creates a task with a due date", async () => {
    const { ctx, userId } = await setup();
    const r = await executeToolCall(ctx, call("create_task", { title: "Call Lena", due_date: "2026-10-23" }));
    expect(r).toMatchObject({ ok: true, data: { title: "Call Lena", due: "2026-10-23" } });
    expect(await db.task.count({ where: { userId } })).toBe(1);
  });

  it("the same call repeated in one turn runs once (idempotency key)", async () => {
    const { ctx, userId } = await setup();
    const args = { title: "Call Lena", due_date: "2026-10-23" };
    const first = await executeToolCall(ctx, call("create_task", args));
    // Same arguments, keys in a different order, different tool call id.
    const second = await executeToolCall(ctx, call("create_task", { due_date: "2026-10-23", title: "Call Lena" }));

    expect(first.ok && first.deduplicated).toBeFalsy();
    expect(second).toMatchObject({ ok: true, deduplicated: true });
    expect(await db.task.count({ where: { userId } })).toBe(1);
  });

  it("concurrent identical calls still create exactly one task", async () => {
    const { ctx, userId } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => executeToolCall(ctx, call("create_task", { title: "Race" }))));
    expect(await db.task.count({ where: { userId } })).toBe(1);
    // Exactly one call did the work; the rest were deduplicated or told it was in progress.
    expect(results.filter((r) => r.ok && !r.deduplicated)).toHaveLength(1);
  });

  it("refuses an open duplicate from a later message and says why", async () => {
    const { ctx, userId, conversationId } = await setup();
    await executeToolCall(ctx, call("create_task", { title: "Send invoice" }));
    const later = await toolCtx(userId, conversationId);
    const r = await executeToolCall(later, call("create_task", { title: "send INVOICE" }));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(await db.task.count({ where: { userId } })).toBe(1);
  });

  it("a refused call does not block a corrected retry", async () => {
    const { ctx, userId } = await setup();
    const refused = await executeToolCall(ctx, call("create_task", { title: "Plan", goal_id: "does-not-exist" }));
    expect(refused).toMatchObject({ ok: false, code: "not_found" });
    expect(await db.toolExecution.count({ where: { userId } })).toBe(0);

    const ok = await executeToolCall(ctx, call("create_task", { title: "Plan" }));
    expect(ok.ok).toBe(true);
  });

  it("cannot attach a task to another user's goal", async () => {
    const { ctx } = await setup();
    const other = await makeUser();
    cleanups.push(other.cleanup);
    const goal = await db.goal.create({ data: { userId: other.userId, title: "Not yours" } });
    expect(await executeToolCall(ctx, call("create_task", { title: "x", goal_id: goal.id }))).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("complete_task", () => {
  it("completes the user's task and is idempotent when already done", async () => {
    const { ctx, userId } = await setup();
    const task = await db.task.create({ data: { userId, title: "Report" } });
    expect(await executeToolCall(ctx, call("complete_task", { task_id: task.id }))).toMatchObject({ ok: true });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("DONE");

    const later = await toolCtx(userId, ctx.conversationId);
    expect(await executeToolCall(later, call("complete_task", { task_id: task.id }))).toMatchObject({ ok: true, data: { alreadyDone: true } });
  });

  it("treats another user's task id exactly like a missing one", async () => {
    const { ctx } = await setup();
    const other = await makeUser();
    cleanups.push(other.cleanup);
    const theirs = await db.task.create({ data: { userId: other.userId, title: "Private" } });

    const r = await executeToolCall(ctx, call("complete_task", { task_id: theirs.id }));
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect((await db.task.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("OPEN");
  });
});

describe("retrieval tools", () => {
  it("list_tasks and search_notes only see the caller's data", async () => {
    const { ctx, userId } = await setup();
    const other = await makeUser();
    cleanups.push(other.cleanup);
    await db.task.create({ data: { userId, title: "Mine" } });
    await db.task.create({ data: { userId: other.userId, title: "Theirs" } });
    await db.note.create({ data: { userId, title: "Northwind call", body: "Budget is six thousand per month" } });
    await db.note.create({ data: { userId: other.userId, title: "Northwind secret", body: "Budget for the competitor" } });

    const tasks = await executeToolCall(ctx, call("list_tasks", {}));
    expect(tasks.ok && (tasks.data as { title: string }[]).map((t) => t.title)).toEqual(["Mine"]);

    const notes = await executeToolCall(ctx, call("search_notes", { query: "northwind budget" }));
    expect(notes.ok && (notes.data as { title: string }[]).map((n) => n.title)).toEqual(["Northwind call"]);
  });

  it("search_notes falls back to substring match when full-text search finds nothing", async () => {
    const { ctx, userId } = await setup();
    await db.note.create({ data: { userId, title: "Reunión con Acme", body: "Presupuesto aprobado" } });
    const r = await executeToolCall(ctx, call("search_notes", { query: "presupuesto" }));
    expect(r.ok && (r.data as unknown[]).length).toBe(1);
  });

  it("list_tasks filters by due window", async () => {
    const { ctx, userId } = await setup();
    await db.task.createMany({
      data: [
        { userId, title: "Early", dueDate: new Date("2026-10-10T00:00:00Z") },
        { userId, title: "In window", dueDate: new Date("2026-10-20T00:00:00Z") },
        { userId, title: "No date" },
      ],
    });
    const r = await executeToolCall(ctx, call("list_tasks", { due_after: "2026-10-15", due_before: "2026-10-31" }));
    expect(r.ok && (r.data as { title: string }[]).map((t) => t.title)).toEqual(["In window"]);
  });
});

describe("memory tools", () => {
  it("remember then forget through the tool interface", async () => {
    const { ctx, userId } = await setup();
    expect(await executeToolCall(ctx, call("remember", { key: "reply_language", content: "Spanish", scope: "user" }))).toMatchObject({
      ok: true,
      data: { action: "created" },
    });
    expect(await executeToolCall(ctx, call("forget", { key: "reply_language" }))).toMatchObject({ ok: true, data: { forgotten: 1 } });
    expect(await executeToolCall(ctx, call("forget", { key: "nothing_here" }))).toMatchObject({ ok: false, code: "not_found" });
    expect(await db.memory.count({ where: { userId, status: "ACTIVE" } })).toBe(0);
  });
});
