/** Adapt a host integration without keeping buffers or credentials in agevex.
 * Fact snapshots are frozen and overwrite event.agevex, so model/tool content
 * cannot impersonate the run owner. Exporters must explicitly consume these
 * facts (or the factory argument); the SDK has no generic metadata option.
 */
export function telemetry({ integration, flush }) {
    return {
        integration(facts) {
            const trusted = Object.freeze({ ...facts });
            try {
                const host = typeof integration === "function" ? integration(trusted) : integration;
                return guard(host, trusted);
            }
            catch {
                return {};
            }
        },
        async flush(facts, signal) {
            try {
                await flush?.(Object.freeze({ ...facts }), signal);
            }
            catch {
                /* Evidence delivery must never change managed execution. */
            }
        },
    };
}
/** Preserve prototypes and method receivers, including class-based integrations.
 * A proxy guards every SDK callback, including experimental callbacks, rather
 * than duplicating the SDK's evolving callback list. Getter failures are also
 * observer failures. Execution wrappers need a separate guard: replaying their
 * execute callback after an exporter throws could repeat paid model/tool work.
 */
function guard(host, facts) {
    return new Proxy({}, {
        get(_target, key) {
            const target = host;
            try {
                const callback = Reflect.get(target, key, target);
                if (typeof callback !== "function")
                    return undefined;
                if (key === "executeLanguageModelCall" || key === "executeTool")
                    return (options) => executeOnce(target, callback, options, facts);
                return async (event) => {
                    try {
                        await Reflect.apply(callback, target, [attributed(event, facts)]);
                    }
                    catch {
                        /* Sync throws and rejected callbacks cannot fail the turn. */
                    }
                };
            }
            catch {
                return undefined;
            }
        },
    });
}
/** Keep SDK payloads intact while replacing any untrusted attribution. Step
 * results are class instances whose text/toolCalls/toolResults are prototype
 * getters, so a spread would drop them: a read-only view delegates every other
 * key to the original event (getters run against it) and answers `agevex` with
 * the trusted facts. onError carries arbitrary values, so a primitive becomes
 * `{ error, agevex }`.
 */
function attributed(event, facts) {
    if (event === null || typeof event !== "object")
        return { error: event, agevex: facts };
    return new Proxy(event, {
        get(target, key) {
            if (key === "agevex")
                return facts;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
        has: (target, key) => key === "agevex" || Reflect.has(target, key),
        // Enumerating observers (serializers, matchers) see `agevex` as an own key.
        ownKeys: (target) => [...Reflect.ownKeys(target).filter((key) => key !== "agevex"), "agevex"],
        getOwnPropertyDescriptor: (target, key) => key === "agevex"
            ? { value: facts, enumerable: true, configurable: true, writable: false }
            : Reflect.getOwnPropertyDescriptor(target, key),
        set: () => false,
    });
}
/** Memoize before starting work, retaining both success and failure. Exporter
 * failures before or after execute fall back to this exact promise; underlying
 * execution errors still propagate. Even a wrapper calling execute twice or
 * failing after starting it without awaiting cannot repeat an effect.
 */
async function executeOnce(host, wrapper, options, facts) {
    let result;
    const execute = () => {
        if (!result) {
            result = Promise.resolve().then(() => options.execute());
            // A wrapper may start work then reject without awaiting it. Observe that
            // rejection immediately while preserving it for the execution outcome.
            void result.catch(() => { });
        }
        return result;
    };
    try {
        await wrapper.call(host, { ...options, agevex: facts, execute });
    }
    catch {
        /* Only the model/tool's own promise may determine the execution outcome. */
    }
    return execute();
}
