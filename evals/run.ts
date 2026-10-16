// Usage:
//   npm run eval                    real model from .env, prompt from PROMPT_VERSION
//   PROMPT_VERSION=v1 npm run eval  compare another prompt version on the same cases
//   npm run eval -- --only memory   run cases whose id contains "memory"
//   npm run eval:offline            scripted model; checks the runner, not the prompt

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");

const { db } = await import("@/lib/db");
const { runTurn } = await import("@/harness/harness");
const { modelFromEnv, ScriptedModel } = await import("@/harness/model");
const { currentPromptVersion } = await import("@/harness/prompt");
const { cases, EVAL_NOW } = await import("./cases");
type EvalContext = import("./cases").EvalContext;
type TurnResult = import("@/harness/harness").TurnResult;

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
const promptVersion = currentPromptVersion();
const selected = cases.filter((c) => !only || c.id.includes(only));

const rows: { id: string; pass: boolean; checks: { name: string; pass: boolean; detail?: string }[]; costUsd: number; latencyMs: number; error?: string }[] = [];
let modelName = "scripted";

for (const c of selected) {
  const user = await db.user.create({ data: { id: `eval-${randomUUID()}`, name: "Sam", timezone: "UTC" } });
  const first = await db.conversation.create({ data: { userId: user.id } });
  const ctx: EvalContext = { userId: user.id, conversationId: first.id, conversations: [first.id] };

  try {
    await c.setup?.(ctx);
    const model = offline ? new ScriptedModel(await c.offline(ctx)) : modelFromEnv();
    modelName = model.name;

    const results: TurnResult[] = [];
    for (const turn of c.turns) {
      if (turn.newConversation) {
        const conv = await db.conversation.create({ data: { userId: user.id } });
        ctx.conversationId = conv.id;
        ctx.conversations.push(conv.id);
      }
      results.push(await runTurn({ userId: user.id, conversationId: ctx.conversationId, text: turn.text, model, now: EVAL_NOW, promptVersion }));
    }

    const checks = await c.check(ctx, results);
    const traces = await db.turnTrace.findMany({ where: { conversationId: { in: ctx.conversations } } });
    rows.push({
      id: c.id,
      pass: checks.every((k) => k.pass),
      checks,
      costUsd: traces.reduce((s, t) => s + (t.costUsd ?? 0), 0),
      latencyMs: traces.reduce((s, t) => s + t.latencyMs, 0),
    });
  } catch (err) {
    rows.push({ id: c.id, pass: false, checks: [], costUsd: 0, latencyMs: 0, error: (err as Error).message });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
}

const passed = rows.filter((r) => r.pass).length;
console.log(`\nPrompt ${promptVersion} · model ${modelName}${offline ? " (OFFLINE: scripted, not a quality measure)" : ""}\n`);
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.error ? `  (error: ${r.error})` : ""}`);
  for (const k of r.checks.filter((k) => !k.pass)) console.log(`        ✗ ${k.name}${k.detail ? ` — ${k.detail}` : ""}`);
}
const cost = rows.reduce((s, r) => s + r.costUsd, 0);
const latency = rows.reduce((s, r) => s + r.latencyMs, 0);
console.log(`\n${passed}/${rows.length} passed · total cost $${cost.toFixed(4)} · total latency ${(latency / 1000).toFixed(1)}s`);

const outDir = path.join("evals", "results");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${promptVersion}_${modelName.replace(/\W+/g, "-")}${offline ? "_offline" : ""}.json`);
writeFileSync(file, JSON.stringify({ promptVersion, model: modelName, offline, passed, total: rows.length, costUsd: cost, rows }, null, 2));
console.log(`Results written to ${file}`);

await db.$disconnect();
process.exit(passed === rows.length ? 0 : 1);
