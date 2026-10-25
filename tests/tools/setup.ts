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
import type * as todoState from "../../src/modules/tools/registry/todo/todoState.js";
import type * as goalsState from "../../src/modules/tools/registry/goals/goalsState.js";
import type * as continueBudgetState from "../../src/modules/tools/registry/continue-budget/continueBudgetState.js";

export const api = anyApi as unknown as ApiFromModules<{
  host: typeof host;
  todoState: typeof todoState;
  goalsState: typeof goalsState;
  continueBudgetState: typeof continueBudgetState;
}>;
export const native = componentsGeneric().agent as unknown as NativeApi;
export const managed = componentsGeneric().agevex as unknown as ComponentApi;
export function setup() {
  state.calls.length = 0;
  state.steps.length = 0;
  child.calls.length = 0;
  state.budget = { checks: 0, runIds: [] };

  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]),
      "./fixture/todoState.ts": () => import("../../src/modules/tools/registry/todo/todoState.js"),
      "./fixture/goalsState.ts": () =>
        import("../../src/modules/tools/registry/goals/goalsState.js"),
      "./fixture/continueBudgetState.ts": () =>
        import("../../src/modules/tools/registry/continue-budget/continueBudgetState.js"),
    },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}

export { state, child };
