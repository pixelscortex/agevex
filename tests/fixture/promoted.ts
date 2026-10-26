// A later host registration promotes Researcher to a public root. Convex-test
// loads this module when its endpoints are first called, after the original
// registration has created a real child thread in the same component database.
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { registerAgent, type TurnArgs } from "../../src/client/index.js";
import { components } from "./api.js";
import { researcher } from "../host.js";

const runtime = registerAgent(components.agevex, {
  title: false,
  agents: [researcher],
  refs: {
    runTurn: () =>
      makeFunctionReference<"action", TurnArgs, null>(
        "promoted:runTurn",
      ) as unknown as FunctionReference<"action", "internal", TurnArgs, null>,
  },
  authorize: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) throw new Error("UNAUTHENTICATED");

    return { subject: identity.subject };
  },
  authorizeExecution: async (_ctx, scope) => {
    if (scope.subject !== "alice") throw new Error("FORBIDDEN");
  },
});

export const { runTurn } = runtime.internalFunctions();
export const { open, send, messages, activity } = runtime.authorizedEndpoints();
