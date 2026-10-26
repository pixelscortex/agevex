/** A literal secret, or a getter (sync or async) called at each export. */
export type Credential = string | (() => string | Promise<string>);
/** A non-secret exporter setting (project id, base URL) with the same literal-or-getter shape. */
export type Setting = string | (() => string | Promise<string>);
/** Validate a literal at registration; a getter is validated when it resolves. */
export declare function checkCredential(value: Credential, name: string): void;
/** Resolve at export time and apply the registration-time string validation. */
export declare function resolveCredential(value: Credential, name: string): Promise<string>;
/** Validate a literal setting at construction; a getter is validated when it resolves. */
export declare function checkSetting(value: Setting, name: string, maximum: number): void;
/** Resolve at export time; a missing or oversized value throws into the fail-open attempt. */
export declare function resolveSetting(value: Setting, name: string, maximum: number): Promise<string>;
