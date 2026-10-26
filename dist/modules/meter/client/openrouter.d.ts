import type { Provider } from "./types.js";
/** Inline cost is authoritative; optional estimates use host-configured rates.
 * Supply workers.lookup to defineMeter whenever this adapter is registered. */
export declare function openRouterProvider(options: {
    apiKey: string | (() => string | Promise<string>);
    estimate?: Provider["estimate"];
    fetch?: typeof fetch;
    lookupFor?: Provider["lookupFor"];
}): Provider;
