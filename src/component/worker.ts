// Workpool-to-host bridge.
//
// Workpool invokes a typed local action, which then resolves the host's
// `runTurn` function handle stored on the assignment. This is the only place in
// the component that consumes a host-provided handle.

import { v } from "convex/values";
import type { FunctionHandle, RegisteredAction } from "convex/server";
import { internalAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

type TurnArgs = { assignmentId: string; turnToken: string };
type DispatchArgs = TurnArgs & { runTurn: string };

/**
 * Run one host turn for a dispatched assignment.
 *
 * The handle is called through `ctx.runAction`, so a throw here is a callback /
 * reference failure and not evidence about the turn itself — the dispatcher cannot
 * distinguish those. That is why failures are not retried and are escalated as
 * `ambiguous`: `markAmbiguous` accepts a turn that never reached `claim`, so a
 * handle that failed immediately is recorded as ambiguous rather than silently
 * dropped. The host runner owns all real outcome reporting through `queue.finish`.
 *
 * Side effects: it runs the host action and, on failure, one queue mutation. It
 * never claims, finalizes or replays the turn on its own.
 */
export const dispatch: RegisteredAction<"internal", DispatchArgs, null> = internalAction({
  args: { assignmentId: v.string(), turnToken: v.string(), runTurn: v.string() },
  returns: v.null(),
  handler: async (ctx, { assignmentId, turnToken, runTurn }) => {
    try {
      await ctx.runAction(runTurn as FunctionHandle<"action", TurnArgs, null>, {
        assignmentId,
        turnToken,
      });
    } catch {
      await ctx.runMutation(api.queue.ambiguous, {
        assignmentId: assignmentId as Id<"assignments">,
        turnToken,
      });
    }
    return null;
  },
});
