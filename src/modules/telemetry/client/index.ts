/** Host-owned AI SDK 7 telemetry, with trusted attribution and isolated failures.
 * AI SDK's telemetry.ts defines callbacks and execution wrappers; agevex owns
 * neither spans nor exporters. Core turn/slots.ts owns the final flush deadline.
 */
import type { Telemetry } from "ai";
import type { SlotFacts, TelemetrySlot } from "../../../client/slots.js";

export type TelemetryFacts = Readonly<SlotFacts & { turnKey: string }>;
export type TelemetryOptions = {
  /** A factory can bind facts to an exporter's own metadata/span context. */
  integration: Telemetry | ((facts: TelemetryFacts) => Telemetry);
  flush?: (facts: TelemetryFacts, signal?: AbortSignal) => void | PromiseLike<void>;
};

/** Adapt a host integration without keeping buffers or credentials in agevex.
 * Fact snapshots are frozen and overwrite event.agevex, so model/tool content
 * cannot impersonate the run owner. Exporters must explicitly consume these
 * facts (or the factory argument); the SDK has no generic metadata option.
 */
export function telemetry({ integration, flush }: TelemetryOptions): TelemetrySlot {
  return {
    integration(facts) {
      const trusted = Object.freeze({ ...facts });

      try {
        const host = typeof integration === "function" ? integration(trusted) : integration;

        return guard(host, trusted);
      } catch {
        return {};
      }
    },
    async flush(facts, signal) {
      try {
        await flush?.(Object.freeze({ ...facts }), signal);
      } catch {
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
function guard(host: Telemetry, facts: TelemetryFacts): Telemetry {
  return new Proxy({} as Telemetry, {
    get(_target, key) {
      const target = host;

      try {
        const callback: unknown = Reflect.get(target, key, target);

        if (typeof callback !== "function") return undefined;

        if (key === "executeLanguageModelCall" || key === "executeTool")
          return (options: Execution) => executeOnce(target, callback as Wrapper, options, facts);

        return async (event: unknown) => {
          try {
            await Reflect.apply(callback, target, [attributed(event, facts)]);
          } catch {
            /* Sync throws and rejected callbacks cannot fail the turn. */
          }
        };
      } catch {
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
function attributed(event: unknown, facts: TelemetryFacts) {
  if (event === null || typeof event !== "object") return { error: event, agevex: facts };

  return new Proxy(event, {
    get(target, key) {
      if (key === "agevex") return facts;

      const value: unknown = Reflect.get(target, key, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (target, key) => key === "agevex" || Reflect.has(target, key),
    // Enumerating observers (serializers, matchers) see `agevex` as an own key.
    ownKeys: (target) => [...Reflect.ownKeys(target).filter((key) => key !== "agevex"), "agevex"],
    getOwnPropertyDescriptor: (target, key) =>
      key === "agevex"
        ? { value: facts, enumerable: true, configurable: true, writable: false }
        : Reflect.getOwnPropertyDescriptor(target, key),
    set: () => false,
  });
}

type Execution = { execute: () => PromiseLike<unknown> };
type Wrapper = (options: Execution) => PromiseLike<unknown>;

/** Memoize before starting work, retaining both success and failure. Exporter
 * failures before or after execute fall back to this exact promise; underlying
 * execution errors still propagate. Even a wrapper calling execute twice or
 * failing after starting it without awaiting cannot repeat an effect.
 */
async function executeOnce(
  host: Telemetry,
  wrapper: Wrapper,
  options: Execution,
  facts: TelemetryFacts,
) {
  let result: Promise<unknown> | undefined;

  const execute = () => {
    if (!result) {
      result = Promise.resolve().then(() => options.execute());
      // A wrapper may start work then reject without awaiting it. Observe that
      // rejection immediately while preserving it for the execution outcome.
      void result.catch(() => {});
    }

    return result;
  };

  try {
    await wrapper.call(host, { ...options, agevex: facts, execute });
  } catch {
    /* Only the model/tool's own promise may determine the execution outcome. */
  }

  return execute();
}
