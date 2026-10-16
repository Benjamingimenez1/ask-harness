import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { detectUnbackedClaims } from "./claims";
import { buildContext } from "./context";
import { type ChatMessage, type ModelClient, type ModelResponse, ModelError } from "./model";
import { currentPromptVersion } from "./prompt";
import { summarizeDropped } from "./summarize";
import { executeToolCall, type ToolContext, type ToolResult, toolSpecs } from "./tools";

const MAX_STEPS = 5;

export type ToolCallTrace = {
  name: string;
  arguments: string;
  ok: boolean;
  code?: string;
  deduplicated?: boolean;
  ms: number;
};

export type TurnResult = {
  reply: string;
  userMessageId: string;
  replayed: boolean;
  trace: {
    promptVersion: string;
    model: string;
    contextTokens: number;
    includedMemoryIds: string[];
    droppedMessageCount: number;
    toolCalls: ToolCallTrace[];
    unbackedClaims: string[];
    latencyMs: number;
    error?: string;
  };
};

export type TurnInput = {
  userId: string;
  conversationId: string;
  text: string;
  model: ModelClient;
  /** Client-generated; lets a retried request resume the same turn. */
  requestId?: string;
  now?: Date;
  promptVersion?: string;
  budget?: number;
};

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const promptVersion = input.promptVersion ?? currentPromptVersion();
  const text = input.text.trim();
  if (!text) throw new Error("Empty message");

  // Ownership check before anything is written.
  await db.conversation.findFirstOrThrow({ where: { id: input.conversationId, userId: input.userId }, select: { id: true } });

  const { userMessage, replay } = await startTurn(input, text);
  if (replay) {
    return { reply: replay, userMessageId: userMessage.id, replayed: true, trace: emptyTrace(promptVersion, input.model.name, started) };
  }

  const ctx = await buildContext({
    userId: input.userId,
    conversationId: input.conversationId,
    now,
    promptVersion,
    budget: input.budget,
  });

  const toolCtx: ToolContext = { userId: input.userId, conversationId: input.conversationId, userMessageId: userMessage.id, now };
  const messages: ChatMessage[] = [...ctx.messages];
  const toolTrace: ToolCallTrace[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false };
  let reply: string | null = null;
  let error: string | undefined;

  try {
    for (let step = 0; step < MAX_STEPS && reply === null; step++) {
      const res = await completeWithRetry(input.model, messages);
      if (res.usage) {
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        if (res.usage.costUsd != null) {
          usage.costUsd += res.usage.costUsd;
          usage.hasCost = true;
        }
      }

      if (res.toolCalls.length === 0) {
        reply = res.content.trim() || "(no answer)";
        break;
      }

      await saveMessage(input.conversationId, { role: "assistant", content: res.content, toolCalls: res.toolCalls });
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });

      // Sequential on purpose: later calls may depend on earlier ones, and
      // ordering keeps traces reproducible.
      for (const call of res.toolCalls) {
        const t0 = Date.now();
        const result: ToolResult = await executeToolCall(toolCtx, call);
        toolTrace.push({
          name: call.name,
          arguments: call.arguments,
          ok: result.ok,
          code: result.ok ? undefined : result.code,
          deduplicated: result.ok ? result.deduplicated : undefined,
          ms: Date.now() - t0,
        });
        const content = JSON.stringify(result);
        await saveMessage(input.conversationId, { role: "tool", content, toolCallId: call.id, toolName: call.name });
        messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
      }
    }
    if (reply === null) {
      error = "step_limit";
      reply = fallbackReply("I couldn't finish this request in the steps I'm allowed.", toolTrace);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[runTurn]", err);
    reply = fallbackReply("Sorry, something went wrong on my side before I could answer.", toolTrace);
  }

  await saveMessage(input.conversationId, { role: "assistant", content: reply });

  const unbackedClaims = detectUnbackedClaims(reply, toolTrace);
  const trace: TurnResult["trace"] = {
    promptVersion,
    model: input.model.name,
    contextTokens: ctx.contextTokens,
    includedMemoryIds: ctx.includedMemoryIds,
    droppedMessageCount: ctx.droppedMessages.length,
    toolCalls: toolTrace,
    unbackedClaims,
    latencyMs: Date.now() - started,
    error,
  };

  await db.turnTrace.create({
    data: {
      conversationId: input.conversationId,
      userMessageId: userMessage.id,
      promptVersion,
      model: input.model.name,
      contextTokens: ctx.contextTokens,
      includedMemoryIds: ctx.includedMemoryIds,
      droppedMessageCount: ctx.droppedMessages.length,
      toolCalls: toolTrace as unknown as Prisma.InputJsonValue,
      unbackedClaims,
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      costUsd: usage.hasCost ? usage.costUsd : null,
      latencyMs: trace.latencyMs,
      error,
    },
  });

  // Fold old turns into the summary after answering. Best effort.
  if (ctx.droppedMessages.length > 0) {
    await summarizeDropped(input.model, input.conversationId, ctx.droppedMessages).catch((err) =>
      console.error("[summarize]", err),
    );
  }

  return { reply, userMessageId: userMessage.id, replayed: false, trace };
}

/**
 * Saves the user message, or recognises a retry of one already saved. A retry
 * whose turn finished gets the stored reply back; a retry of an interrupted
 * turn reruns it with the same user message id, so its tool calls hit the same
 * idempotency keys and are not executed twice.
 */
async function startTurn(input: TurnInput, text: string) {
  if (input.requestId) {
    const existing = await db.message.findUnique({ where: { requestId: input.requestId } });
    if (existing) {
      if (existing.conversationId !== input.conversationId) throw new Error("requestId belongs to another conversation");
      const next = await db.message.findFirst({
        where: { conversationId: input.conversationId, seq: { gt: existing.seq } },
        orderBy: { seq: "asc" },
        select: { seq: true },
      });
      const nextUser = await db.message.findFirst({
        where: { conversationId: input.conversationId, role: "user", seq: { gt: existing.seq } },
        orderBy: { seq: "asc" },
        select: { seq: true },
      });
      const finalReply = await db.message.findFirst({
        where: {
          conversationId: input.conversationId,
          role: "assistant",
          toolCalls: { equals: Prisma.DbNull },
          seq: { gt: existing.seq, ...(nextUser ? { lt: nextUser.seq } : {}) },
        },
        orderBy: { seq: "desc" },
      });
      if (finalReply) return { userMessage: existing, replay: finalReply.content };
      if (next) {
        // Interrupted turn: drop its partial messages; they will be regenerated.
        await db.message.deleteMany({
          where: { conversationId: input.conversationId, seq: { gt: existing.seq, ...(nextUser ? { lt: nextUser.seq } : {}) } },
        });
      }
      return { userMessage: existing, replay: null };
    }
  }
  const userMessage = await saveMessage(input.conversationId, { role: "user", content: text, requestId: input.requestId });
  return { userMessage, replay: null };
}

async function completeWithRetry(model: ModelClient, messages: ChatMessage[]): Promise<ModelResponse> {
  try {
    return await model.complete({ messages, tools: toolSpecs });
  } catch (err) {
    if (err instanceof ModelError && err.retryable) {
      await new Promise((r) => setTimeout(r, 800));
      return model.complete({ messages, tools: toolSpecs });
    }
    throw err;
  }
}

/** Never claims more than the trace shows. */
function fallbackReply(opening: string, calls: ToolCallTrace[]): string {
  const done = calls.filter((c) => c.ok && c.name !== "list_tasks" && c.name !== "search_notes");
  if (done.length === 0) return `${opening} Nothing was changed.`;
  return `${opening} These actions did complete: ${done.map((c) => `${c.name}(${c.arguments})`).join(", ")}.`;
}

function saveMessage(
  conversationId: string,
  m: { role: "user" | "assistant" | "tool"; content: string; toolCalls?: unknown; toolCallId?: string; toolName?: string; requestId?: string },
) {
  return db.message.create({
    data: {
      conversationId,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? (m.toolCalls as Prisma.InputJsonValue) : undefined,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      requestId: m.requestId,
    },
  });
}

function emptyTrace(promptVersion: string, model: string, started: number): TurnResult["trace"] {
  return {
    promptVersion,
    model,
    contextTokens: 0,
    includedMemoryIds: [],
    droppedMessageCount: 0,
    toolCalls: [],
    unbackedClaims: [],
    latencyMs: Date.now() - started,
  };
}
