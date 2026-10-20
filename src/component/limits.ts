// Bounds shared by the component and the host runtime.
//
// This module holds constants only: it is safe to import from component
// functions *and* from host client code, so the managed execution limits are
// stated once instead of drifting between the two sides. Nothing here reads
// configuration or has runtime behavior.

/** Output-token ceiling for every managed generation (root, child or result continuation). */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * Cooperative abort deadline for one managed generation, measured from the
 * moment the turn is claimed. It is deliberately shorter than
 * `EXECUTION_WATCHDOG_MS` so the owner can normally report its own outcome
 * before the watchdog fires.
 *
 * Cooperative only: aborting does not guarantee that an uncooperative provider
 * stops billing for the request it already accepted.
 */
export const GENERATION_ABORT_MS = 90_000;

/**
 * Detection-only watchdog window for a claimed turn, armed by `queue.claim`
 * and never extended. Queue wait does not consume it.
 */
export const EXECUTION_WATCHDOG_MS = 120_000;

/** Concurrency cap of the shared Workpool across every root and child turn. */
export const MAX_PARALLEL_TURNS = 4;

/**
 * Concurrent queued-or-running child runs accepted per root assignment.
 *
 * A bounded per-root concurrent ceiling, not an unlimited fanout: it was
 * raised from 1 to 5 so several children can run at once under one root. It is
 * independent of the separate per-prompt allowance
 * ({@link MAX_DELEGATIONS_PER_USER_PROMPT}), which holds one accepted user
 * prompt to at most three children however fast those children finish, and it
 * does not change depth 1.
 */
export const MAX_ACTIVE_CHILD_RUNS = 5;

/**
 * Child launches one accepted user prompt may have accepted in total.
 *
 * An explicit fanout bound of three: a root turn of user origin may launch up
 * to three children, each as its own `agevex_delegate` tool call in the same
 * model step. It is persisted on the root assignment next to the delegating
 * turn token, so it survives a child that completes, fails or fails to deliver,
 * and it is reset only by the first accepted launch of the next accepted user
 * prompt. This is the per-prompt budget (`TASK_LIMIT`); the concurrent
 * {@link MAX_ACTIVE_CHILD_RUNS} ceiling is separate and is checked first.
 */
export const MAX_DELEGATIONS_PER_USER_PROMPT = 3;

/** Maximum `agent`/`task` length accepted by the managed `agevex_delegate` tool. */
export const MAX_DELEGATION_TASK_LENGTH = 4_000;

/**
 * Fixed upper bound on the persisted transition projection of one subagent
 * run: queued, started, one terminal phase, one delivery phase.
 */
export const MAX_RUN_EVENTS = 4;

/** Default and maximum page sizes of the authorized `delegations` query. */
export const DEFAULT_DELEGATION_PAGE = 20;
export const MAX_DELEGATION_PAGE = 50;
