/** A literal secret, or a getter (sync or async) called at each export. */
export type Credential = string | (() => string | Promise<string>);
/** Validate a literal at registration; a getter is validated when it resolves. */
export declare function checkCredential(value: Credential, name: string): void;
/** Resolve at export time and apply the registration-time string validation. */
export declare function resolveCredential(value: Credential, name: string): Promise<string>;
