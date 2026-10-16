# Ask harness

A small, tested chat harness for an AI work assistant: the code and instructions that sit between a language model and a user's data. It covers the parts that decide whether an assistant feels trustworthy: what goes into context each turn, what gets remembered and forgotten, how data is retrieved, how actions are executed safely, and how behavior is measured.

Stack: TypeScript, Next.js App Router, PostgreSQL, Prisma, OpenRouter.

> **How this was built.** I built this with heavy help from an AI coding assistant (Claude). I directed the scope, reviewed the code, and can walk through every design decision below. The "Decisions" section is the part I'd most like to discuss.

## What it does

A consultant has goals, tasks and notes. They chat with "Ask", which can answer from their data, remember preferences, and create or complete tasks. A side panel shows what happened under the hood on each turn: which memories were in context, which tools ran and whether they succeeded, token count, latency and cost.

```
User message
   │
   ▼
runTurn ──► buildContext ──► system prompt (versioned file)
   │                         + <memory>   lasting + this-conversation memories, capped
   │                         + <snapshot> goals + tasks due within 7 days
   │                         + <summary>  rolling summary of older turns
   │                         + recent whole turns that fit the token budget
   ▼
model (OpenRouter) ◄──────┐
   │ tool calls           │ tool results {ok, data | code, error}
   ▼                      │
executeToolCall ──────────┘  zod validation → user-scoped queries → idempotent writes
   │
   ▼
final reply ──► TurnTrace (tools, memories, tokens, cost, unbacked-claim check)
           └──► summarize turns that fell out of the window (after answering)
```

## Run it

**In the browser, nothing to install:** on GitHub, click **Code → Codespaces → Create codespace on main**. The dev container starts Postgres, installs dependencies, migrates, seeds demo data and opens the app on port 3000. Add your OpenRouter key when GitHub asks for the `OPENROUTER_API_KEY` secret (or later in `.env`).

**Locally:** requires Node 20+ and PostgreSQL 14+.

```bash
cp .env.example .env            # add OPENROUTER_API_KEY, check DATABASE_URL
npm install
npm run db:migrate              # applies prisma/migrations
npm run db:seed                 # demo user with goals, tasks and notes
npm run dev                     # http://localhost:3000
```

Tests and evals:

```bash
npm test                        # 38 tests against the real database (no model needed)
npm run eval                    # 11 behavioral cases against the real model
PROMPT_VERSION=v1 npm run eval  # same cases, older prompt, for comparison
npm run eval:offline            # scripted model: checks the eval runner, not prompt quality
```

## Layout

```
prompts/              system.v1.md, system.v2.md, CHANGELOG.md
prisma/               schema, migration (with hand-written partial index + FTS index), seed
src/harness/
  harness.ts          runTurn: the tool loop, retries, step limit, traces, resume-on-retry
  context.ts          what the model sees each turn, within a token budget
  memory.ts           save / supersede / forget, scoped by user and conversation
  retrieval.ts        snapshot, structured task queries, full-text note search
  tools.ts            tool registry, zod validation, idempotent execution
  claims.ts           flags replies that claim an action no tool performed
  summarize.ts        rolling summary of turns that no longer fit
  model.ts            ModelClient interface, OpenRouter client, scripted model
src/app/              chat UI with an "under the hood" panel, /api/chat route
tests/                unit and integration tests (real Postgres)
evals/                behavioral cases and runner
```

## Decisions

**Lasting vs. temporary memory is a data model, not a prompt hope.** Memories have a `scope`: `USER` (applies everywhere) or `CONVERSATION` (only the chat it came from). "For this chat, answer in one line" must not follow the user into next week's conversations; scoping it in the database makes that impossible rather than unlikely.

**Corrections replace, they don't accumulate.** Each memory has a topic key (`reply_language`, `main_client`). Saving a key that already has an active value marks the old row `SUPERSEDED` and links it to the new one, in one transaction. A partial unique index (`WHERE status = 'ACTIVE'`) guarantees at most one current value per key even if two saves race. Without this, "my main client is Acme" and "actually it's Northwind" both sit in context and the model has to guess.

**Forget means the text is gone.** `forget` sets `DELETED` and wipes the content of the active row and its superseded history. Hiding it from the prompt while keeping it in the table would not meet what a user means by "forget".

**Context is assembled by priority, and turns are kept whole.** System prompt, then capped memories, then a small snapshot, then the summary, then as many recent turns as fit. History is cut at turn boundaries so an assistant tool call is never separated from its tool result (providers reject that, and the model loses track of what happened). The current message is always included. Dropped turns are folded into a rolling summary after the reply is sent, so summarization never adds latency or breaks a turn.

**Two retrieval paths, chosen by data shape.** Tasks are structured, so they're SQL filters (status, due window, title). Notes are free text, so they use Postgres full-text search with a substring fallback (FTS drops stop words and handles non-English poorly). I didn't add embeddings: for a few hundred notes per user, FTS is exact, cheap, debuggable, and needs no extra infrastructure. Embeddings become worth it when users search by meaning ("that call where they were worried about cash") and keyword search starts missing.

**Always-on snapshot + on-demand tools.** A small snapshot (goals, tasks overdue or due within 7 days) answers most "what's next?" questions with zero tool calls. Everything else is one tool call away. This keeps the common case fast and cheap without stuffing the whole database into the prompt.

**The server owns identity.** Every query takes `userId` from the session (`src/lib/session.ts`), never from the request body or the model's arguments. A task id belonging to another user returns `not_found`, exactly like a missing id, so the existence of other users' data doesn't leak.

**Tools validate before they act.** Each tool has one zod schema that both validates input and generates the JSON Schema sent to the model, so the two can't drift. Invalid arguments come back to the model as a structured error it can correct. (The tests caught that `Date.parse` accepts `2026-02-30` and silently rolls it to March 2; dates are now checked with a round trip.)

**Actions run at most once.** Each side-effecting call gets an idempotency key: hash of user, conversation, user message, tool name and canonicalized arguments. The key is inserted in the same transaction as the work, so a concurrent duplicate blocks and then fails on the unique index instead of acting twice. Refused actions (not found, conflict) roll back, so a corrected retry isn't blocked. A test fires five identical calls in parallel and checks exactly one task exists. Above that, `create_task` refuses an open task with the same title and tells the model to ask the user.

**Retries resume, they don't restart.** The client sends a `requestId` per message. If the request is retried after it finished, the stored reply is returned without calling the model. If it was interrupted mid-turn, the turn reruns with the same user message id, so its tool calls hit the same idempotency keys and don't repeat.

**Never claim what didn't happen.** Tool results always carry `ok`. The prompt ties phrases like "Done" to `ok: true`. Error and step-limit fallbacks list only actions the trace shows succeeded. And `claims.ts` flags replies that claim an action with no successful matching call; it's a heuristic, but it's recorded on every turn and checked in every eval.

**Prompts are versioned files, compared on the same evals.** `prompts/system.vN.md` plus a changelog that records what each change is meant to fix. `PROMPT_VERSION` picks one; eval results are saved per version and model, so "v2 is better" is a number, not a feeling.

**Evals assert on state, not wording.** Checks look at the database and the tool trace (was a lasting memory created? is there still one task? did `complete_task` run?) rather than exact phrasing. The cases cover memory persistence, temporary instructions, corrections, forgetting, relative dates, duplicates, answering from the snapshot, note retrieval, honest failure, ambiguity, and an instruction injected through a note.

## Trade-offs and what I'd do next

- **Token counting is an estimate** (characters / 4). Fine for budgeting; a real tokenizer would replace one function.
- **Only database side effects are atomic.** An external action (sending an email, writing to Google Calendar) can't share a Postgres transaction; it would need a PENDING row plus an outbox/worker, and the idempotency key passed to the external API.
- **The unbacked-claim detector is regex-based** (English and Spanish). It catches the common phrasings; a small classifier model would be more robust but adds cost per turn.
- **No streaming yet.** The tool loop returns one reply per request. Streaming the final answer is straightforward; streaming across tool steps needs a status protocol for the UI.
- **Auth is a stub.** `currentUserId()` returns the demo user; replacing it with a real session is a one-function change because nothing else reads identity.
- **Summaries can drift.** The summary prompt forbids invention, but a long-lived conversation should periodically re-summarize from source messages rather than only from the previous summary.

## Prompt changelog

See [`prompts/CHANGELOG.md`](prompts/CHANGELOG.md).
