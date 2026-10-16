import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activeMemories, forgetMemory, normalizeKey, saveMemory } from "@/harness/memory";
import { makeUser } from "./helpers";

let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("memory", () => {
  it("normalizes keys to snake_case topics", () => {
    expect(normalizeKey("Reply Language")).toBe("reply_language");
    expect(normalizeKey("  main-client! ")).toBe("main_client");
    expect(() => normalizeKey("!!!")).toThrow();
  });

  it("a correction replaces the old value instead of adding a contradicting one", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;

    const first = await saveMemory({ userId: u.userId, scope: "USER", key: "reply_language", content: "English" });
    const second = await saveMemory({ userId: u.userId, scope: "USER", key: "Reply Language", content: "Spanish" });

    expect(first.action).toBe("created");
    expect(second).toMatchObject({ action: "replaced", previous: "English" });

    const active = await activeMemories(u.userId, u.conversationId);
    expect(active.map((m) => m.content)).toEqual(["Spanish"]);

    const old = await db.memory.findUniqueOrThrow({ where: { id: first.memory.id } });
    expect(old.status).toBe("SUPERSEDED");
    expect(old.supersededById).toBe(second.memory.id);
  });

  it("saving the same value again is a no-op", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    await saveMemory({ userId: u.userId, scope: "USER", key: "tone", content: "brief" });
    const again = await saveMemory({ userId: u.userId, scope: "USER", key: "tone", content: "brief" });
    expect(again.action).toBe("unchanged");
    expect(await db.memory.count({ where: { userId: u.userId } })).toBe(1);
  });

  it("conversation-scoped memory does not leak into other conversations", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    const other = await db.conversation.create({ data: { userId: u.userId } });

    await saveMemory({ userId: u.userId, scope: "CONVERSATION", conversationId: u.conversationId, key: "length", content: "one line answers" });
    await saveMemory({ userId: u.userId, scope: "USER", key: "reply_language", content: "Spanish" });

    expect((await activeMemories(u.userId, u.conversationId)).map((m) => m.key).sort()).toEqual(["length", "reply_language"]);
    expect((await activeMemories(u.userId, other.id)).map((m) => m.key)).toEqual(["reply_language"]);
  });

  it("forget wipes the content, including older superseded versions", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    await saveMemory({ userId: u.userId, scope: "USER", key: "home_city", content: "Rosario" });
    await saveMemory({ userId: u.userId, scope: "USER", key: "home_city", content: "Córdoba" });

    const r = await forgetMemory({ userId: u.userId, conversationId: u.conversationId, key: "home_city" });
    expect(r.forgotten).toBe(1);

    const rows = await db.memory.findMany({ where: { userId: u.userId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.status === "DELETED" && m.content === "")).toBe(true);
    expect(await activeMemories(u.userId, u.conversationId)).toHaveLength(0);
  });

  it("forget does not touch another user's memory with the same key", async () => {
    const a = await makeUser();
    const b = await makeUser();
    cleanup = async () => {
      await a.cleanup();
      await b.cleanup();
    };
    await saveMemory({ userId: a.userId, scope: "USER", key: "tone", content: "brief" });
    await saveMemory({ userId: b.userId, scope: "USER", key: "tone", content: "detailed" });
    await forgetMemory({ userId: a.userId, conversationId: a.conversationId, key: "tone" });
    expect((await activeMemories(b.userId, b.conversationId)).map((m) => m.content)).toEqual(["detailed"]);
  });

  it("the database refuses two ACTIVE memories for one key (race safety net)", async () => {
    const u = await makeUser();
    cleanup = u.cleanup;
    await db.memory.create({ data: { userId: u.userId, scope: "USER", key: "tone", content: "a" } });
    await expect(db.memory.create({ data: { userId: u.userId, scope: "USER", key: "tone", content: "b" } })).rejects.toThrow();
  });
});
