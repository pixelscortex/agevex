/** `true` by default. A getter may read deployment env and run at each turn. */
export type Enabled = boolean | (() => boolean | Promise<boolean>);
/** Reject a malformed switch at registration; a getter's value is checked when it resolves. */
export declare function validateEnabled(value: unknown): void;
/**
 * Resolve the switch. Booleans and synchronous getters answer immediately, so
 * the common case adds no asynchrony to model callbacks; only an async getter
 * returns a promise, bounded so a hung getter cannot hold the model call.
 */
export declare function resolveEnabled(value: Enabled | undefined): boolean | Promise<boolean>;
