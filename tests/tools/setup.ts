/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { anyApi, componentsGeneric, type ApiFromModules } from "convex/server";
import type { ComponentApi as NativeApi } from "@convex-dev/agent/_generated/component.js";
import type { ComponentApi } from "../../src/component/_generated/component.js";
import agevex from "../../src/test.js";
import schema from "./fixture/schema.js";
import { state, child } from "./fixture/host.js";
import type * as host from "./fixture/host.js";

export const api = anyApi as unknown as ApiFromModules<{
  host: typeof host;
}>;
export const native = componentsGeneric().agent as unknown as NativeApi;
export const managed = componentsGeneric().agevex as unknown as ComponentApi;
export function setup() {
  state.effects.length = 0;
  state.hookInputs.length = 0;
  state.rewrite = false;
  child.steps = null;
  child.askUser = undefined;
  state.calls.length = 0;
  state.steps.length = 0;
  child.calls.length = 0;

  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]),
      "./fixture/host.ts": async () => {
        const host = await import("./fixture/host.js");

        return { ...host, ...host.fixtureExports() };
      },
    },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}

export { state, child };
