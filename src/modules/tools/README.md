# tools

Optional host tool factories and installable Convex state snippets. Factories run
in the host Agent action with core's fenced `ToolContext`; installed state queries,
mutations and schemas run in the host Convex app. This module owns no component.

Install the desired registry item, merge its table snippet into the host schema,
and regenerate the host's Convex API. Import factories from `agevex/tools` (or the
installed source) and add their results to the Agent's `tools`:
`...createTodoTools(internal.agevexTools.todoState)` and
`...createGoalTools(internal.agevexTools.goalsState)`. The owner/thread scope comes
from `ToolContext`, never model arguments. Host-facing endpoints must authorize
the caller before invoking internal state functions.

`ask_user: createAskUserTool()` defers execution until the owner calls core
`answer`. Register `continue_budget: createContinueBudgetTool()` on root agents
only. In an authorized host mutation, record consent only after a fresh approved
core `respond`; later call `resumeAfterBudgetStop` in one mutation with callbacks
for activity, consent consumption, budget update, cancellation and fresh send.
A rejected/duplicate send throws so the whole transaction rolls back. Unknown
paid outcomes are never resumed or retried automatically.

File map:

- `client/index.ts`: stable public factory and type exports.
- `registry/todo/todo.ts`: todo tools, count/byte validation and typed state refs.
- `registry/todo/todoSchema.ts`: `todoTables` schema snippet and local data model.
- `registry/todo/todoState.ts`: internal read/write and bounded host cleanup.
- `registry/goals/goals.ts`: goal tools, trimmed text bound and typed state refs.
- `registry/goals/goalsSchema.ts`: `goalTables` schema snippet and local data model.
- `registry/goals/goalsState.ts`: internal check/set and bounded host cleanup.
- `registry/ask-user/askUser.ts`: bounded question schema and deferred tool.
- `registry/continue-budget/continueBudget.ts`: approval tool and atomic resume helper.
- `registry/continue-budget/continueBudgetSchema.ts`: `consentTables` snippet and data model.
- `registry/continue-budget/continueBudgetState.ts`: internal record/consume and age-bounded cleanup.

Host tables and reads:

- `agevexTodos`: `subject`/`threadId` index the owner's list; `todos` is validated
  on read/write (100 items and 32 KiB). One row is under 34 KiB; the unique lookup
  reads at most two rows, under 68 KiB.
- `agevexGoals`: `subject`/`threadId` scope the thread; `goal` is parsed on check/set
  (1–4000 trimmed characters). One row is under 18 KiB; unique lookup under 36 KiB.
- `agevexBudgetConsents`: `subject`/`threadId`/`approvalId` identify consent;
  `runId` binds it to the stopped run; `spent` prevents reuse. Record/consume read
  at most two rows under 2 KiB each. Cleanup retains rows beyond core receipt replay.

Cleanup is explicitly host-driven, with 128 deletions per call and one lookahead
row for `done`. The existing bounds, indexes and registered function paths are
part of the installation contract. Registry sources are authoritative;
`bun run registry:build` refreshes the generated docs payloads after source edits.
