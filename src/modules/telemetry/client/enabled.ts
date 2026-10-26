/**
 * Call-time switch for recording and exporting a turn.
 * It is resolved once, when the turn's buffer is created (the first integration
 * for a turn key). That is the cheapest correct point: a later flush then has
 * nothing to decide, and a disabled turn never admits a span, so no span is
 * held in memory and no exporter runs. Resolution fails closed: a getter that
 * throws, rejects, hangs past the export deadline or returns anything but
 * `true` disables that turn. It can never fail the agent.
 */
import { LIMITS } from "./limits.js";

/** `true` by default. A getter may read deployment env and run at each turn. */
export type Enabled = boolean | (() => boolean | Promise<boolean>);

/** Reject a malformed switch at registration; a getter's value is checked when it resolves. */
export function validateEnabled(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean" && typeof value !== "function")
    throw new Error("Invalid telemetry enabled");
}

/**
 * Resolve the switch. Booleans and synchronous getters answer immediately, so
 * the common case adds no asynchrony to model callbacks; only an async getter
 * returns a promise, bounded so a hung getter cannot hold the model call.
 */
export function resolveEnabled(value: Enabled | undefined): boolean | Promise<boolean> {
  if (value === undefined) return true;

  if (typeof value === "boolean") return value;

  let result: boolean | Promise<boolean>;

  try {
    result = value();
  } catch {
    return false;
  }

  if (typeof result !== "object" || result === null) return result === true;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), LIMITS.exportTimeoutMs);
  });

  const answer = Promise.resolve(result).then(
    (open) => open === true,
    () => false,
  );

  return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
}
