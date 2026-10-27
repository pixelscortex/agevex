/** The adapter observes real SDK callbacks without owning exporter behavior. */
import { expect, it, vi } from "vite-plus/test";
import type { Telemetry } from "ai";
import { telemetry } from "../../src/modules/telemetry/client/index.js";
import { facts, scripted } from "./script.js";

it("real model and tool callbacks carry the trusted run, thread, subject and agent", async () => {
  const seen: unknown[] = [];

  const receive = (event: unknown) => {
    seen.push(event);
  };

  const slot = telemetry({
    integration: {
      onStart: receive,
      onStepStart: receive,
      onLanguageModelCallStart: receive,
      onLanguageModelCallEnd: receive,
      onToolExecutionStart: receive,
      onToolExecutionEnd: receive,
      onStepEnd: receive,
      onEnd: receive,
    },
  });

  expect(await scripted(slot.integration(facts))).toBe("private model output");
  expect(seen.length).toBeGreaterThan(8);

  for (const event of seen) expect(event).toMatchObject({ agevex: facts });
});

it("attribution is snapshotted and replaces forged event attribution across concurrent turns", async () => {
  const seen: { agevex: typeof facts }[] = [];
  const source = { ...facts };

  const host = {
    onError(event: unknown) {
      seen.push(event as (typeof seen)[number]);
    },
  };

  const slot = telemetry({ integration: host });
  const first = slot.integration(source);
  const second = slot.integration({ ...facts, runId: "second" });

  source.subject = "changed";

  await Promise.all([
    first.onError?.({ agevex: { subject: "forged" } }),
    second.onError?.({ agevex: { runId: "forged" } }),
  ]);

  expect(seen.map(({ agevex }) => agevex.subject)).toEqual(["owner", "owner"]);
  expect(seen.map(({ agevex }) => agevex.runId)).toEqual(["run", "second"]);
  expect(Object.isFrozen(seen[0].agevex)).toBe(true);
});

it.each(["sync", "async"])(
  "%s callback failures cannot fail real SDK model or tool execution",
  async (failure) => {
    const fail = () => {
      if (failure === "sync") throw new Error("exporter failed");

      return Promise.reject(new Error("exporter failed"));
    };

    const slot = telemetry({
      integration: {
        onStart: fail,
        onStepStart: fail,
        onLanguageModelCallStart: fail,
        onLanguageModelCallEnd: fail,
        onToolExecutionStart: fail,
        onToolExecutionEnd: fail,
        onStepEnd: fail,
        onEnd: fail,
      },
    });

    expect(await scripted(slot.integration(facts))).toBe("private model output");
  },
);

it("class methods keep their receiver and frozen integrations remain usable", async () => {
  class Host {
    seen = 0;
    onStart() {
      this.seen++;
    }
  }
  const host = new Host();

  await scripted(telemetry({ integration: host }).integration(facts));
  expect(host.seen).toBe(1);
  const onStart = vi.fn();

  await scripted(telemetry({ integration: Object.freeze({ onStart }) }).integration(facts));
  expect(onStart).toHaveBeenCalledTimes(1);
});

it("integration factory and callback getter failures leave model execution available", async () => {
  for (const integration of [
    () => {
      throw new Error("factory failed");
    },
    {
      get onStart(): Telemetry["onStart"] {
        throw new Error("getter failed");
      },
    },
  ]) {
    const slot = telemetry({ integration });

    expect(await scripted(slot.integration(facts))).toBe("private model output");
  }
});

it.each(["executeLanguageModelCall", "executeTool"] as const)(
  "%s wrappers cannot repeat work or replace its result when telemetry fails",
  async (key) => {
    for (const failure of ["before", "after", "unawaited", "duplicate"] as const) {
      const execute = vi.fn(async () => "actual result");

      const wrapper: NonNullable<Telemetry[typeof key]> = async <T>({
        execute,
      }: {
        execute: () => PromiseLike<T>;
      }): Promise<T> => {
        if (failure === "before") throw new Error("before execution");

        if (failure === "unawaited") {
          void execute();
          throw new Error("after start");
        }

        await execute();

        if (failure === "after") throw new Error("after execution");

        return execute();
      };

      const integration = telemetry({ integration: { [key]: wrapper } }).integration(facts);
      const result = await integration[key]!({ callId: "call", toolCallId: "tool", execute });

      expect(result).toBe("actual result");
      expect(execute).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(["executeLanguageModelCall", "executeTool"] as const)(
  "%s preserves an underlying execution error even if the exporter swallows it",
  async (key) => {
    const failure = new Error("paid work failed");
    const execute = vi.fn(() => Promise.reject(failure));

    const wrapper: NonNullable<Telemetry[typeof key]> = async <T>({
      execute,
    }: {
      execute: () => PromiseLike<T>;
    }): Promise<T> => {
      try {
        return await execute();
      } catch {
        return undefined as never;
      }
    };

    const integration = telemetry({ integration: { [key]: wrapper } }).integration(facts);

    await expect(integration[key]!({ callId: "call", toolCallId: "tool", execute })).rejects.toBe(
      failure,
    );

    expect(execute).toHaveBeenCalledTimes(1);
  },
);

it("the host factory and final flush receive trusted facts and the abort signal", async () => {
  const factory = vi.fn(() => ({}));

  const flush = vi.fn(() => {
    throw new Error("delivery failed");
  });

  const slot = telemetry({ integration: factory, flush });
  const controller = new AbortController();

  slot.integration(facts);
  await expect(slot.flush(facts, controller.signal)).resolves.toBeUndefined();
  expect(factory).toHaveBeenCalledWith(facts);
  expect(flush).toHaveBeenCalledWith(facts, controller.signal);
});
