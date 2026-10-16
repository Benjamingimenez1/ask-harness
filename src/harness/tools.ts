import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import type { ToolCall, ToolSpec } from "./model";
import { forgetMemory, saveMemory } from "./memory";
import { listTasks, searchNotes, ymd } from "./retrieval";

export type ToolContext = {
  userId: string;
  conversationId: string;
  /** The user message this turn is answering; part of the idempotency key. */
  userMessageId: string;
  now: Date;
};

/** What the model sees. `ok` is the only thing allowed to justify "done". */
export type ToolResult =
  | { ok: true; data: unknown; deduplicated?: boolean }
  | { ok: false; code: "unknown_tool" | "invalid_arguments" | "not_found" | "conflict" | "in_progress" | "internal"; error: string };

type Tx = Prisma.TransactionClient;

type ToolDef<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  /**
   * Side-effecting tools run inside a transaction together with their
   * ToolExecution row, so "the work happened" and "we recorded it" commit or
   * roll back together.
   */
  sideEffect: boolean;
  run: (ctx: ToolContext, args: z.infer<S>, tx: Tx) => Promise<ToolResult>;
};

function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  // Date.parse accepts "2026-02-30" and rolls it over to March 2, so check
  // that the date survives a round trip unchanged.
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real calendar date");

const dateOf = (s: string) => new Date(`${s}T00:00:00Z`);

const defs = [
  defineTool({
    name: "list_tasks",
    description:
      "List the user's tasks. Use for questions about tasks not shown in the snapshot (older, undated, done, or matching a word).",
    schema: z.object({
      status: z.enum(["open", "done"]).optional(),
      due_before: isoDate.optional().describe("Inclusive, YYYY-MM-DD"),
      due_after: isoDate.optional().describe("Inclusive, YYYY-MM-DD"),
      query: z.string().min(1).max(100).optional().describe("Word or phrase that must appear in the title"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    sideEffect: false,
    run: async (ctx, a) => ({
      ok: true,
      data: await listTasks(ctx.userId, {
        status: a.status === "open" ? "OPEN" : a.status === "done" ? "DONE" : undefined,
        dueBefore: a.due_before ? dateOf(a.due_before) : undefined,
        dueAfter: a.due_after ? dateOf(a.due_after) : undefined,
        query: a.query,
        limit: a.limit,
      }),
    }),
  }),
  defineTool({
    name: "search_notes",
    description: "Search the user's notes by keywords. Returns titles and short snippets.",
    schema: z.object({
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    sideEffect: false,
    run: async (ctx, a) => ({ ok: true, data: await searchNotes(ctx.userId, a.query, a.limit) }),
  }),
  defineTool({
    name: "create_task",
    description: "Create a task for the user. Fails if an open task with the same title already exists.",
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      due_date: isoDate.optional().describe("YYYY-MM-DD"),
      goal_id: z.string().optional().describe("ID of one of the user's goals, from the snapshot"),
    }),
    sideEffect: true,
    run: async (ctx, a, tx) => {
      if (a.goal_id) {
        const goal = await tx.goal.findFirst({ where: { id: a.goal_id, userId: ctx.userId }, select: { id: true } });
        if (!goal) return { ok: false, code: "not_found", error: `No goal with id ${a.goal_id}` };
      }
      const dup = await tx.task.findFirst({
        where: { userId: ctx.userId, status: "OPEN", title: { equals: a.title, mode: "insensitive" } },
      });
      if (dup) {
        return { ok: false, code: "conflict", error: `An open task with this title already exists (id ${dup.id}). Ask the user before creating another.` };
      }
      const task = await tx.task.create({
        data: { userId: ctx.userId, title: a.title, dueDate: a.due_date ? dateOf(a.due_date) : null, goalId: a.goal_id },
      });
      return { ok: true, data: { id: task.id, title: task.title, due: task.dueDate ? ymd(task.dueDate) : null } };
    },
  }),
  defineTool({
    name: "complete_task",
    description: "Mark one of the user's tasks as done, by id.",
    schema: z.object({ task_id: z.string().min(1) }),
    sideEffect: true,
    run: async (ctx, a, tx) => {
      // Scoped lookup: another user's task id behaves exactly like a missing one.
      const task = await tx.task.findFirst({ where: { id: a.task_id, userId: ctx.userId } });
      if (!task) return { ok: false, code: "not_found", error: `No task with id ${a.task_id}` };
      if (task.status === "DONE") return { ok: true, data: { id: task.id, title: task.title, alreadyDone: true } };
      await tx.task.update({ where: { id: task.id }, data: { status: "DONE" } });
      return { ok: true, data: { id: task.id, title: task.title } };
    },
  }),
  defineTool({
    name: "remember",
    description:
      "Save something to remember. scope 'user' lasts across conversations; scope 'conversation' applies to this chat only. Saving an existing key replaces its value.",
    schema: z.object({
      key: z.string().min(1).max(48).describe("Short snake_case topic, e.g. reply_language"),
      content: z.string().trim().min(1).max(500),
      scope: z.enum(["user", "conversation"]),
    }),
    sideEffect: true,
    // Memory writes use their own transaction (see memory.ts); they are
    // already idempotent by key, so running outside `tx` is safe.
    run: async (ctx, a) => {
      const r = await saveMemory({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        scope: a.scope === "user" ? "USER" : "CONVERSATION",
        key: a.key,
        content: a.content,
      });
      return { ok: true, data: { action: r.action, key: r.memory.key, ...(r.action === "replaced" ? { previous: r.previous } : {}) } };
    },
  }),
  defineTool({
    name: "forget",
    description: "Forget a remembered item by key, when the user asks you to.",
    schema: z.object({ key: z.string().min(1).max(48) }),
    sideEffect: true,
    run: async (ctx, a) => {
      const r = await forgetMemory({ userId: ctx.userId, conversationId: ctx.conversationId, key: a.key });
      if (r.forgotten === 0) return { ok: false, code: "not_found", error: `Nothing is remembered under "${a.key}"` };
      return { ok: true, data: { forgotten: r.forgotten } };
    },
  }),
];

const registry = new Map<string, ToolDef<z.ZodObject>>(defs.map((d) => [d.name, d as unknown as ToolDef<z.ZodObject>]));

export const toolSpecs: ToolSpec[] = defs.map((d) => {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(d.schema) as Record<string, unknown>;
  return { name: d.name, description: d.description, parameters };
});

/** Stable JSON: object keys sorted, so {a,b} and {b,a} hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Same user message + same tool + same arguments => same key. This catches a
 * model that repeats a call within a turn and a client that retries a request.
 */
export function idempotencyKey(ctx: ToolContext, name: string, args: unknown): string {
  return createHash("sha256")
    .update([ctx.userId, ctx.conversationId, ctx.userMessageId, name, canonical(args)].join("|"))
    .digest("hex");
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function executeToolCall(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) return { ok: false, code: "unknown_tool", error: `There is no tool named "${call.name}"` };

  let raw: unknown;
  try {
    raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return { ok: false, code: "invalid_arguments", error: "Arguments are not valid JSON" };
  }
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, code: "invalid_arguments", error: detail };
  }
  const args = parsed.data;

  if (!tool.sideEffect) {
    try {
      return await tool.run(ctx, args, db);
    } catch (err) {
      console.error(`[tool ${call.name}]`, err);
      return { ok: false, code: "internal", error: "The lookup failed. Try again or ask the user." };
    }
  }

  const key = idempotencyKey(ctx, call.name, args);

  try {
    return await db.$transaction(async (tx) => {
      // Inserting the key first means a concurrent duplicate blocks here and
      // then fails with a unique violation instead of doing the work again.
      const exec = await tx.toolExecution.create({
        data: { userId: ctx.userId, idempotencyKey: key, toolName: call.name, input: args as Prisma.InputJsonValue },
      });
      const result = await tool.run(ctx, args, tx);
      if (!result.ok) {
        // A refused action (not found, conflict) did nothing; throwing rolls
        // back the execution row so a corrected retry is not blocked.
        throw new RefusedAction(result);
      }
      await tx.toolExecution.update({
        where: { id: exec.id },
        data: { status: "SUCCEEDED", result: result.data as Prisma.InputJsonValue },
      });
      return result;
    });
  } catch (err) {
    if (err instanceof RefusedAction) return err.result;
    if (isUniqueViolation(err)) {
      const prior = await db.toolExecution.findUnique({ where: { idempotencyKey: key } });
      if (prior?.status === "SUCCEEDED") return { ok: true, data: prior.result, deduplicated: true };
      return { ok: false, code: "in_progress", error: "This exact action is already being processed." };
    }
    console.error(`[tool ${call.name}]`, err);
    await recordFailure(ctx, key, call.name, args, err);
    return { ok: false, code: "internal", error: "The action failed and nothing was changed." };
  }
}

class RefusedAction extends Error {
  constructor(readonly result: ToolResult) {
    super("refused");
  }
}

/** Best-effort record of a crashed action, for debugging. Never blocks a retry. */
async function recordFailure(ctx: ToolContext, key: string, name: string, args: unknown, err: unknown) {
  try {
    await db.toolExecution.create({
      data: {
        userId: ctx.userId,
        // Suffix keeps the real key free so a retry can still run.
        idempotencyKey: `${key}:failed:${Date.now()}`,
        toolName: name,
        input: args as Prisma.InputJsonValue,
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } catch {
    // Logging must never turn a handled failure into an unhandled one.
  }
}
