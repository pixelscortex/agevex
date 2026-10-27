// The host-internal coordinator mutation: the only entry point for managed
// collaboration.
//
// `buildCoordinate` returns the registered internal mutation the host exports
// (as `refs.coordinate`). Its handler only dispatches on `op` to the op modules:
// `launch.ts` (start a child), `interaction.ts` (`message` /
// `ask`), `parent-note.ts` (`message_parent`), `settle.ts` (record a child
// outcome) and `delivery.ts` (`notify`).
// Each op runs entirely inside this one mutation's transaction.
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { denialCode, runErrorCode } from "../../component/schema.js";
import { notifyRun } from "./delivery.js";
import { interact } from "./interaction.js";
import { launchChild } from "./launch.js";
import { settleRun } from "./settle.js";
import { messageParent } from "./parent-note.js";
/**
 * Convex argument validator for the coordinator.
 *
 * Declared as one flat object with a discriminant rather than a validator union:
 * Convex requires an arguments validator to be an object, and the discriminated
 * `CoordinateArgs` union is enforced by the handler, which refuses any
 * combination the contract does not define.
 */
const coordinateArgs = v.object({
    op: v.string(),
    assignmentId: v.optional(v.string()),
    turnToken: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    agent: v.optional(v.string()),
    task: v.optional(v.string()),
    runId: v.optional(v.string()),
    resultMessageId: v.optional(v.string()),
    errorCode: v.optional(runErrorCode),
    deliveryToken: v.optional(v.string()),
    wait: v.optional(v.literal("each")),
    text: v.optional(v.string()),
    question: v.optional(v.string()),
});
const delegationResult = v.union(v.object({ status: v.literal("queued"), runId: v.string(), agent: v.string() }), v.object({ status: v.literal("denied"), code: denialCode }));
/** Build the registered coordinator mutation for one registration. */
export function buildCoordinate(rt) {
    return internalMutationGeneric({
        args: coordinateArgs,
        returns: v.union(delegationResult, v.object({ status: v.literal("accepted"), runId: v.string() }), v.object({ status: v.literal("accepted"), messageId: v.string() }), v.object({ status: v.literal("deferred"), runId: v.string() }), v.null()),
        /**
         * The only host entry point for managed collaboration.
         *
         * Each operation validates a capability the caller already holds
         * before any policy call or write: `launch` the actor's currently
         * running turn token plus the native tool call id, `settle` the child
         * turn token that owns the run, `notify` the one-shot delivery
         * capability minted at launch. Ownership and outcome always come from
         * persisted state and verified native messages, never from a
         * caller-supplied principal flag.
         */
        handler: (ctx, raw) => coordinate(rt, ctx, raw),
    });
}
/** Dispatch one coordinator call to its op. Anything else is a `notify`. */
async function coordinate(rt, ctx, args) {
    if (args.op === "launch")
        return launchChild(rt, ctx, args);
    if (args.op === "message" || args.op === "ask")
        return interact(rt, ctx, args);
    if (args.op === "message_parent")
        return messageParent(rt, ctx, args);
    if (args.op === "settle")
        return settleRun(rt, ctx, args);
    return notifyRun(rt, ctx, args);
}
