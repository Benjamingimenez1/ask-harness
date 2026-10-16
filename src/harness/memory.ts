import type { Memory, MemoryScope } from "@prisma/client";
import { db } from "@/lib/db";

export function normalizeKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!key) throw new Error("Memory key is empty after normalization");
  return key;
}

type SaveInput = {
  userId: string;
  scope: MemoryScope;
  /** Required when scope is CONVERSATION, ignored otherwise. */
  conversationId?: string | null;
  key: string;
  content: string;
};

export type SaveResult =
  | { action: "created"; memory: Memory }
  | { action: "replaced"; memory: Memory; previous: string }
  | { action: "unchanged"; memory: Memory };

/**
 * Saves a memory under a topic key. If an ACTIVE memory with the same key
 * already exists in the same scope, it is marked SUPERSEDED and linked to the
 * new one, so a correction replaces the old value instead of contradicting it.
 */
export async function saveMemory(input: SaveInput): Promise<SaveResult> {
  const key = normalizeKey(input.key);
  const content = input.content.trim();
  if (!content) throw new Error("Memory content is empty");
  const conversationId = input.scope === "CONVERSATION" ? input.conversationId : null;
  if (input.scope === "CONVERSATION" && !conversationId) {
    throw new Error("Conversation-scoped memory needs a conversationId");
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.memory.findFirst({
      where: { userId: input.userId, scope: input.scope, conversationId, key, status: "ACTIVE" },
    });

    if (existing && existing.content === content) {
      return { action: "unchanged" as const, memory: existing };
    }

    // Retire the old value first: the partial unique index allows only one
    // ACTIVE row per key, so creating before retiring would violate it.
    if (existing) {
      await tx.memory.update({ where: { id: existing.id }, data: { status: "SUPERSEDED" } });
    }

    const memory = await tx.memory.create({
      data: { userId: input.userId, scope: input.scope, conversationId, key, content },
    });

    if (existing) {
      await tx.memory.update({ where: { id: existing.id }, data: { supersededById: memory.id } });
      return { action: "replaced" as const, memory, previous: existing.content };
    }
    return { action: "created" as const, memory };
  });
}

/**
 * Forgets every ACTIVE memory with this key that the user can see in this
 * conversation (lasting and conversation-scoped). Content is wiped, not just
 * hidden: "forget" should mean the text is gone. Older SUPERSEDED versions of
 * the same key are wiped too, so the value cannot come back from history.
 */
export async function forgetMemory(input: {
  userId: string;
  conversationId: string;
  key: string;
}): Promise<{ forgotten: number }> {
  const key = normalizeKey(input.key);
  const visible = {
    userId: input.userId,
    key,
    OR: [{ scope: "USER" as const }, { scope: "CONVERSATION" as const, conversationId: input.conversationId }],
  };

  return db.$transaction(async (tx) => {
    const active = await tx.memory.count({ where: { ...visible, status: "ACTIVE" } });
    await tx.memory.updateMany({
      where: { ...visible, status: { in: ["ACTIVE", "SUPERSEDED"] } },
      data: { status: "DELETED", content: "" },
    });
    return { forgotten: active };
  });
}

/** Memories that apply to this turn: the user's lasting ones plus this conversation's. */
export async function activeMemories(userId: string, conversationId: string): Promise<Memory[]> {
  return db.memory.findMany({
    where: {
      userId,
      status: "ACTIVE",
      OR: [{ scope: "USER" }, { scope: "CONVERSATION", conversationId }],
    },
    orderBy: { updatedAt: "desc" },
  });
}
