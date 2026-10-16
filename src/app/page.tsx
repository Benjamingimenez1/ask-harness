import { db } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import Chat from "./Chat";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const userId = await currentUserId();
  const { c } = await searchParams;

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    return (
      <main className="empty">
        <p>No demo user found. Run <code>npm run db:seed</code> first.</p>
      </main>
    );
  }

  const conversation =
    (c && (await db.conversation.findFirst({ where: { id: c, userId } }))) ||
    (await db.conversation.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } })) ||
    (await db.conversation.create({ data: { userId } }));

  return <Chat conversationId={conversation.id} userName={user.name} />;
}
