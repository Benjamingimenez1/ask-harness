import type { Message } from "@prisma/client";
import { db } from "@/lib/db";
import type { ModelClient } from "./model";

const SUMMARY_PROMPT = `You maintain a running summary of a conversation between a user and their work assistant.
Merge the previous summary with the new messages into one updated summary.
Keep: decisions, commitments with dates, open questions, facts about the user's work, and actions that were completed or failed.
Drop: greetings, small talk, and anything already superseded.
Write plain text, at most 150 words. Do not invent anything that is not in the input.`;

function render(m: Message): string {
  if (m.role === "tool") return `[tool ${m.toolName} result] ${m.content.slice(0, 400)}`;
  if (m.role === "assistant" && m.toolCalls) {
    const calls = (m.toolCalls as { name: string; arguments: string }[]).map((c) => `${c.name}(${c.arguments})`).join(", ");
    return `assistant: ${m.content} [called ${calls}]`;
  }
  return `${m.role}: ${m.content}`;
}

/**
 * Folds messages that fell out of the context window into the conversation's
 * rolling summary. Runs after the answer is ready, so a failure here never
 * breaks a turn. The conditional update stops two concurrent turns from
 * overwriting each other's summary.
 */
export async function summarizeDropped(model: ModelClient, conversationId: string, dropped: Message[]): Promise<boolean> {
  if (dropped.length === 0) return false;
  const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });

  const response = await model.complete({
    temperature: 0,
    maxTokens: 300,
    messages: [
      { role: "system", content: SUMMARY_PROMPT },
      {
        role: "user",
        content: `Previous summary:\n${conversation.summary ?? "(none)"}\n\nNew messages:\n${dropped.map(render).join("\n")}`,
      },
    ],
  });

  const summary = response.content.trim();
  if (!summary) return false;

  const { count } = await db.conversation.updateMany({
    where: { id: conversationId, summarizedThroughSeq: conversation.summarizedThroughSeq },
    data: { summary, summarizedThroughSeq: dropped[dropped.length - 1]!.seq },
  });
  return count === 1;
}
