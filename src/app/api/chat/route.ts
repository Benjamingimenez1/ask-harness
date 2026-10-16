import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { runTurn } from "@/harness/harness";
import { activeMemories } from "@/harness/memory";
import { modelFromEnv } from "@/harness/model";

export const runtime = "nodejs";

const PostBody = z.object({
  conversationId: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
  requestId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const userId = await currentUserId();
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const conversation = await db.conversation.findFirst({ where: { id: parsed.data.conversationId, userId } });
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  let model;
  try {
    model = modelFromEnv();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const result = await runTurn({ userId, conversationId: conversation.id, text: parsed.data.text, requestId: parsed.data.requestId, model });
  return NextResponse.json(result);
}

/** Conversation view for the UI: visible messages, recent traces and active memories. */
export async function GET(req: Request) {
  const userId = await currentUserId();
  const conversationId = new URL(req.url).searchParams.get("conversationId") ?? "";
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const [messages, traces, memories] = await Promise.all([
    db.message.findMany({
      // Tool messages and intermediate tool-calling steps are filtered out below.
      where: { conversationId, role: { in: ["user", "assistant"] } },
      orderBy: { seq: "asc" },
      select: { id: true, role: true, content: true, toolCalls: true },
    }),
    db.turnTrace.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 10 }),
    activeMemories(userId, conversationId),
  ]);

  return NextResponse.json({
    messages: messages.filter((m) => m.role === "user" || m.toolCalls === null).map(({ id, role, content }) => ({ id, role, content })),
    traces,
    memories: memories.map((m) => ({ id: m.id, key: m.key, content: m.content, scope: m.scope })),
    summary: conversation.summary,
  });
}
