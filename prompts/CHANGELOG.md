# Prompt changelog

Each version is a separate file so a change can be rolled back and two versions
can be compared on the same eval cases (`PROMPT_VERSION=v1 npm run eval` vs
`PROMPT_VERSION=v2 npm run eval`; results land in `evals/results/`).

## v2

Problems v1 leaves open, and what v2 does about each:

| Risk with v1 | Change in v2 |
|---|---|
| No rule for when to remember vs. not; the model may store one-off details or never store anything. | Explicit criteria for `remember`, plus the user / conversation scope split. |
| No convention for memory keys, so a correction creates a second, conflicting memory. | Short snake_case topic keys; same key replaces the old value. |
| Nothing stops the model from saying "Done" after a failed tool call. | Claims of action are tied to `"ok": true` in the tool result. |
| Memory and snapshot text could be read as instructions (prompt injection through a note title). | Blocks are declared as data, never instructions. |
| Relative dates passed to tools as free text. | Resolve against today's date, pass YYYY-MM-DD. |
| Duplicate actions when the model retries. | "Do not call the same action twice" (also enforced in code by idempotency keys). |

Status: these are the hypotheses behind v2. Measure them with `npm run eval`
against a real model and record the numbers here.

| Version | Model | Passed | Notes |
|---|---|---|---|
| v1 | | | |
| v2 | | | |

## v1

Baseline: role, date, and a one-line mention of tools.
