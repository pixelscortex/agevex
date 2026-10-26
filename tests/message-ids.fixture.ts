/** Observe exact native save results without listing or matching a transcript. */
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import type { MessageDoc } from "@convex-dev/agent";
import { mutationGeneric } from "convex/server";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import type { Registration } from "../src/client/types.js";
import { exports } from "./hooks.host.js";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

type NativeSave = {
  _args: never;
  _returns: never;
  _handler: (ctx: unknown, args: unknown) => Promise<{ messages: MessageDoc[] }>;
};

/** Keep a witness of committed save batches, including tool rows/placeholders. */
export function setup(
  limits?: Registration["limits"],
  onSave?: (messages: MessageDoc[]) => Promise<void>,
) {
  const saves: MessageDoc[][] = [];

  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports(limits) },
  });

  t.registerComponent("agent", agent.schema, {
    ...agent.modules,
    "./component/messages.ts": async () => {
      const real = (await agent.modules["./component/messages.ts"]()) as {
        addMessages: NativeSave;
      };

      return {
        ...real,
        addMessages: mutationGeneric({
          args: real.addMessages._args,
          returns: real.addMessages._returns,
          handler: async (ctx, args) => {
            const result = await real.addMessages._handler(ctx, args);

            saves.push(result.messages);
            await onSave?.(result.messages);

            return result as never;
          },
        }),
      };
    },
  });

  agevex.register(t);

  return { t, saves };
}
