/** A literal secret, or a getter (sync or async) called at each use. */
export type Credential = string | (() => string | Promise<string>);
/** Resolve at call time and require a non-empty value within the length bound. */
export declare function resolveCredential(value: Credential, code: string): Promise<string>;
