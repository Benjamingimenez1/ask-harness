import type { Prisma, TaskStatus } from "@prisma/client";
import { db } from "@/lib/db";

// Two retrieval paths, chosen by the shape of the data:
// - Tasks and goals are structured (status, due date), so they are fetched with
//   filtered SQL queries. Semantic search would be slower and less exact here.
// - Notes are free text, so they use Postgres full-text search with a
//   substring fallback (FTS drops stop words and very short queries).
//
// Every query takes userId from the server session, never from the model.

const DAY = 24 * 60 * 60 * 1000;

export type TaskView = { id: string; title: string; status: TaskStatus; due: string | null; goal: string | null };
export type NoteHit = { id: string; title: string; snippet: string };

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toView(t: { id: string; title: string; status: TaskStatus; dueDate: Date | null; goal: { title: string } | null }): TaskView {
  return { id: t.id, title: t.title, status: t.status, due: t.dueDate ? ymd(t.dueDate) : null, goal: t.goal?.title ?? null };
}

export type Snapshot = {
  goals: { id: string; title: string; target: string | null }[];
  dueSoon: TaskView[];
  otherOpenCount: number;
};

/**
 * Small, always-included view of the user's work: goals plus open tasks that
 * are overdue or due within a week. Cheap to fetch and answers most "what's
 * next?" questions without a tool call. Everything else is one tool call away.
 */
export async function getSnapshot(userId: string, now: Date): Promise<Snapshot> {
  const horizon = new Date(now.getTime() + 7 * DAY);
  const [goals, dueSoon, openTotal] = await Promise.all([
    db.goal.findMany({ where: { userId }, orderBy: { targetDate: "asc" }, take: 5 }),
    db.task.findMany({
      where: { userId, status: "OPEN", dueDate: { lte: horizon } },
      orderBy: { dueDate: "asc" },
      take: 15,
      include: { goal: { select: { title: true } } },
    }),
    db.task.count({ where: { userId, status: "OPEN" } }),
  ]);
  return {
    goals: goals.map((g) => ({ id: g.id, title: g.title, target: g.targetDate ? ymd(g.targetDate) : null })),
    dueSoon: dueSoon.map(toView),
    otherOpenCount: openTotal - dueSoon.length,
  };
}

export function formatSnapshot(s: Snapshot, today: string): string {
  const lines: string[] = [];
  lines.push("Goals:");
  if (s.goals.length === 0) lines.push("- (none)");
  for (const g of s.goals) lines.push(`- [${g.id}] ${g.title}${g.target ? ` (target ${g.target})` : ""}`);
  lines.push("Open tasks overdue or due within 7 days:");
  if (s.dueSoon.length === 0) lines.push("- (none)");
  for (const t of s.dueSoon) {
    const overdue = t.due && t.due < today ? " OVERDUE" : "";
    lines.push(`- [${t.id}] ${t.title} (due ${t.due}${overdue})${t.goal ? ` - goal: ${t.goal}` : ""}`);
  }
  if (s.otherOpenCount > 0) lines.push(`(${s.otherOpenCount} more open tasks without a near due date; use list_tasks to see them.)`);
  return lines.join("\n");
}

export async function listTasks(
  userId: string,
  f: { status?: TaskStatus; dueBefore?: Date; dueAfter?: Date; query?: string; limit?: number },
): Promise<TaskView[]> {
  const where: Prisma.TaskWhereInput = { userId };
  if (f.status) where.status = f.status;
  if (f.dueBefore || f.dueAfter) where.dueDate = { lte: f.dueBefore, gte: f.dueAfter };
  if (f.query) where.title = { contains: f.query, mode: "insensitive" };
  const tasks = await db.task.findMany({
    where,
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: Math.min(f.limit ?? 20, 50),
    include: { goal: { select: { title: true } } },
  });
  return tasks.map(toView);
}

export async function searchNotes(userId: string, query: string, limit = 5): Promise<NoteHit[]> {
  const take = Math.min(limit, 10);
  const fts = await db.$queryRaw<{ id: string; title: string; body: string }[]>`
    SELECT id, title, body
    FROM "Note"
    WHERE "userId" = ${userId}
      AND to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', ${query})) DESC
    LIMIT ${take}`;

  const rows =
    fts.length > 0
      ? fts
      : await db.note.findMany({
          where: {
            userId,
            OR: [
              { title: { contains: query, mode: "insensitive" } },
              { body: { contains: query, mode: "insensitive" } },
            ],
          },
          take,
          orderBy: { createdAt: "desc" },
        });

  return rows.map((n) => ({ id: n.id, title: n.title, snippet: n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body }));
}
