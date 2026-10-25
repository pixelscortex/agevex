/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { anyApi, componentsGeneric, type ApiFromModules } from "convex/server";
import type { ComponentApi as NativeApi } from "@convex-dev/agent/_generated/component.js";
import type { ComponentApi } from "../../src/component/_generated/component.js";
import agevex from "../../src/test.js";
import schema from "./fixture/schema.js";
import { state } from "./fixture/host.js";
import type * as host from "./fixture/host.js";
import type * as todoState from "../../docs/site/registry/todo/todoState.js";
import type * as goalsState from "../../docs/site/registry/goals/goalsState.js";

export const api = anyApi as unknown as ApiFromModules<{
  host: typeof host;
  todoState: typeof todoState;
  goalsState: typeof goalsState;
}>;
export const native = componentsGeneric().agent as unknown as NativeApi;
export const managed = componentsGeneric().agevex as unknown as ComponentApi;
export function setup() {
  state.calls.length = 0;
  state.steps.length = 0;
  state.budget = { allowed: Infinity, checks: 0, runIds: [] };
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]),
      "./fixture/todoState.ts": () => import("../../docs/site/registry/todo/todoState.js"),
      "./fixture/goalsState.ts": () => import("../../docs/site/registry/goals/goalsState.js"),
    },
  });
  agent.register(t);
  agevex.register(t);
  return t;
}

export { state };
