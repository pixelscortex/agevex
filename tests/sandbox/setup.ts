import { convexTest } from "convex-test";
import { anyApi, type ApiFromModules } from "convex/server";
import agent from "@convex-dev/agent/test";
import core from "../../src/test.js";
import sandbox from "../../src/modules/sandbox/test.js";
import schema from "./fixture/schema.js";
import { state, runtime } from "./fixture/host.js";
import { config } from "./fixture/host.js";
import { sandboxNodeExport } from "../../src/modules/sandbox/client/index.js";
import type * as host from "./fixture/host.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import type { SandboxLimits } from "../../src/modules/sandbox/shared/limits.js";

const modules = import.meta.glob(["./fixture/**/*.ts"]);

export const api = anyApi as unknown as ApiFromModules<{ host: typeof host }>;
export function setup(
  scope: typeof state.scope = "thread",
  limits: Partial<SandboxLimits> = {},
  fake = fakeSandboxProvider(),
) {
  state.fake = fake;
  state.scope = scope;
  state.limits = limits;
  state.authorized = true;
  state.deniedWith = "HOST_DENIED";
  state.deniedAsConvexError = false;
  state.beforeUse = undefined;
  state.crashPolls = 0;
  state.callbackFails = false;
  state.usageFails = false;
  state.usage = [];
  state.resolver = undefined;
  state.nodeExport = false;
  state.nodeWrite = false;

  // Every sandbox scenario, including hard-max admissions and sweeps, runs
  // with convex-test's actual transaction byte/doc/query limits enabled.
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...modules,
      "./fixture/host.ts": async () => ({ ...(await import("./fixture/host.js")), ...runtime() }),
      "./fixture/node.ts": async () => {
        const node = await import("./fixture/node.js");

        return {
          ...node,
          exportFile: sandboxNodeExport(config()),
          writeBytes: node.nodeWrite(),
        };
      },
    },
  });

  agent.register(t);

  t.registerComponent("agevex", core.schema, {
    ...core.modules,
    "./component/sandboxFixture.ts": () => import("./fixture/seed.js"),
  });

  const component = sandbox.register(t);

  return { t, component, fake };
}
export { state };

/** Multi-window export tests take ~14 s on a loaded machine; vitest's default is 5 s. */
export const EXPORT_TEST_TIMEOUT_MS = 60_000;
