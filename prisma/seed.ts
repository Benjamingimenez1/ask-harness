// Demo data: one consultant with goals, tasks and notes. Safe to re-run.
import { db } from "../src/lib/db";

const DAY = 24 * 60 * 60 * 1000;
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
};

export const DEMO_USER_ID = "demo-user";

async function main() {
  await db.user.deleteMany({ where: { id: DEMO_USER_ID } });
  await db.user.create({ data: { id: DEMO_USER_ID, name: "Sam", timezone: "America/Argentina/Buenos_Aires" } });

  const clients = await db.goal.create({
    data: { userId: DEMO_USER_ID, title: "Sign 2 new retainer clients", targetDate: day(60) },
  });
  const content = await db.goal.create({
    data: { userId: DEMO_USER_ID, title: "Publish one LinkedIn post per week", targetDate: day(90) },
  });

  await db.task.createMany({
    data: [
      { userId: DEMO_USER_ID, title: "Send proposal to Northwind", dueDate: day(-1), goalId: clients.id },
      { userId: DEMO_USER_ID, title: "Follow up with Maria about referral", dueDate: day(1), goalId: clients.id },
      { userId: DEMO_USER_ID, title: "Draft post: why fractional COOs fail", dueDate: day(3), goalId: content.id },
      { userId: DEMO_USER_ID, title: "Acme weekly report", dueDate: day(2) },
      { userId: DEMO_USER_ID, title: "Update portfolio site" },
      { userId: DEMO_USER_ID, title: "Book accountant call", status: "DONE", dueDate: day(-5) },
    ],
  });

  await db.note.createMany({
    data: [
      {
        userId: DEMO_USER_ID,
        title: "Northwind discovery call",
        body: "Budget around $6k/month. Decision maker is the CFO, Lena. Main pain: month-end close takes 12 days. They want a proposal with a 90-day plan.",
      },
      {
        userId: DEMO_USER_ID,
        title: "Pricing thoughts",
        body: "Retainer floor $4k/month for 1 day a week. Never discount below floor; trade scope instead.",
      },
      {
        userId: DEMO_USER_ID,
        title: "Acme context",
        body: "Acme is the main client. Weekly report due every Friday to Tom. They care about hiring pipeline metrics.",
      },
    ],
  });

  await db.conversation.create({ data: { id: "demo-conversation", userId: DEMO_USER_ID } });
  console.log("Seeded demo user, goals, tasks, notes and a conversation.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
