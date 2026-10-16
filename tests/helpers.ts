import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { ToolContext } from "@/harness/tools";

/** A fresh user + conversation per test, removed by cascade afterwards. */
export async function makeUser(name = "Test") {
  const user = await db.user.create({ data: { id: `test-${randomUUID()}`, name, timezone: "UTC" } });
  const conversation = await db.conversation.create({ data: { userId: user.id } });
  return {
    userId: user.id,
    conversationId: conversation.id,
    cleanup: () => db.user.deleteMany({ where: { id: user.id } }),
  };
}

export async function toolCtx(userId: string, conversationId: string): Promise<ToolContext> {
  const msg = await db.message.create({ data: { conversationId, role: "user", content: "test" } });
  return { userId, conversationId, userMessageId: msg.id, now: new Date("2026-10-16T12:00:00Z") };
}

export const call = (name: string, args: unknown, id = randomUUID()) => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
