import type { Memory, Message } from "@prisma/client";
import { db } from "@/lib/db";
import type { ChatMessage, ToolCall } from "./model";
import { activeMemories } from "./memory";
import { loadPrompt, renderPrompt } from "./prompt";
import { formatSnapshot, getSnapshot } from "./retrieval";
import { estimateTokens } from "./tokens";
import { toolSpecs } from "./tools";

export type BuiltContext = {
  messages: ChatMessage[];
  contextTokens: number;
  includedMemoryIds: string[];
  /** Older turns that did not fit and are not yet covered by the summary. */
  droppedMessages: Message[];
};

export type ContextOptions = {
  userId: string;
  conversationId: string;
  now: Date;
  promptVersion: string;
  /** Token budget for system prompt + memory + snapshot + history + tool specs. */
  budget?: number;
  /** Cap for the memory block so a long memory list cannot crowd out the conversation. */
  memoryBudget?: number;
};

export function todayIn(timezone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Decides what the model sees this turn, in priority order:
 *   1. system prompt (always)
 *   2. memories (capped)
 *   3. snapshot of goals and near-term tasks (small, always)
 *   4. rolling summary of older turns
 *   5. as many recent whole turns as fit, newest first
 * Turns are kept whole so an assistant tool call is never separated from its
 * tool results, which providers reject.
 */
export async function buildContext(opts: ContextOptions): Promise<BuiltContext> {
  const budget = opts.budget ?? 6000;
  const memoryBudget = opts.memoryBudget ?? 800;

  const [user, conversation] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: opts.userId } }),
    db.conversation.findFirstOrThrow({ where: { id: opts.conversationId, userId: opts.userId } }),
  ]);
  const today = todayIn(user.timezone, opts.now);

  const [memories, snapshot, history] = await Promise.all([
    activeMemories(opts.userId, opts.conversationId),
    getSnapshot(opts.userId, opts.now),
    db.message.findMany({
      where: {
        conversationId: opts.conversationId,
        ...(conversation.summarizedThroughSeq != null ? { seq: { gt: conversation.summarizedThroughSeq } } : {}),
      },
      orderBy: { seq: "asc" },
    }),
  ]);

  const { block: memoryBlock, included } = memoryBlockWithin(memories, memoryBudget);

  let system = renderPrompt(loadPrompt(opts.promptVersion), { user_name: user.name, today, timezone: user.timezone });
  if (memoryBlock) system += `\n\n<memory>\n${memoryBlock}\n</memory>`;
  system += `\n\n<snapshot>\n${formatSnapshot(snapshot, today)}\n</snapshot>`;
  if (conversation.summary) system += `\n\n<summary>\n${conversation.summary}\n</summary>`;

  const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(toolSpecs));
  let remaining = budget - fixedTokens;

  const turns = groupIntoTurns(history);
  const kept: Message[][] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const cost = turn.reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls ?? "")), 0);
    // The newest turn holds the current user message; it is always included.
    if (cost > remaining && kept.length > 0) break;
    kept.unshift(turn);
    remaining -= cost;
  }
  const keptMessages = kept.flat();
  const droppedMessages = history.slice(0, history.length - keptMessages.length);

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...keptMessages.map(toChatMessage)];
  return {
    messages,
    contextTokens: budget - remaining,
    includedMemoryIds: included.map((m) => m.id),
    droppedMessages,
  };
}

function memoryBlockWithin(memories: Memory[], budget: number) {
  const included: Memory[] = [];
  const lines: string[] = [];
  let used = 0;
  // Conversation-scoped first: an instruction for this chat should win over a general preference.
  const ordered = [...memories].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "CONVERSATION" ? -1 : 1));
  for (const m of ordered) {
    const line = `- (${m.scope === "USER" ? "lasting" : "this conversation only"}) ${m.key}: ${m.content}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) continue;
    lines.push(line);
    included.push(m);
    used += cost;
  }
  return { block: lines.join("\n"), included };
}

/** A turn starts at each user message and runs until the next one. */
export function groupIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

function toChatMessage(m: Message): ChatMessage {
  if (m.role === "tool") return { role: "tool", content: m.content, toolCallId: m.toolCallId ?? "", name: m.toolName ?? "" };
  if (m.role === "assistant") {
    const toolCalls = (m.toolCalls as ToolCall[] | null) ?? undefined;
    return { role: "assistant", content: m.content, toolCalls };
  }
  return { role: "user", content: m.content };
}
