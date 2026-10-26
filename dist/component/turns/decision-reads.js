// Exact-id pending-call reads and receipt lookup; never discover calls in history.
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server.js";
import { approvalKey, keyString } from "../approvals.js";
import { findReceipt } from "../receipts/records.js";
import { proposal } from "./decision-proposals.js";
import { DECISION_LIMITS, decisionBytes } from "../../shared/decisions.js";
import { oversizedAskItem } from "../../shared/ask-values.js";
export const pendingItem = v.object({
    ...proposal.fields,
    threadId: v.string(),
    agent: v.string(),
    kind: v.union(v.literal("approval"), v.literal("ask")),
});
/** One recorded reference reads one <=32 KiB proposal, never a native transcript.
 * `approved` (added by respond) is split off: it is not part of the proposal's
 * bound and is never shown in the pending projection.
 */
export async function readProposal(ctx, request) {
    const stored = await ctx.db.get("receipts", request.proposalId);
    if (stored?.kind !== "proposal")
        throw new ConvexError({ code: "PENDING_CALL_NOT_FOUND" });
    const { approved, ...result } = stored.result;
    if (decisionBytes({ ...stored, result }) > DECISION_LIMITS.proposalBytes)
        throw new ConvexError({ code: "PENDING_ITEM_TOO_LARGE" });
    return { result, approved };
}
export async function readPending(ctx, row, request) {
    const { result } = await readProposal(ctx, request);
    const call = {
        ...result,
        threadId: row.threadId,
        agent: row.agent,
        kind: request.deferred ? "ask" : "approval",
    };
    // The answer endpoint reads this same projection: a public truncated stub
    // must remain unanswerable even when the stored proposal itself fits 32 KiB.
    return request.deferred && oversizedAskItem(call) ? { ...call, truncated: true } : call;
}
/** Resolve exactly one requested decision, or the already committed first receipt. */
export const detail = query({
    args: {
        assignmentId: v.id("assignments"),
        subject: v.string(),
        id: v.string(),
        deferred: v.boolean(),
    },
    returns: v.union(pendingItem, v.null()),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("assignments", args.assignmentId);
        if (!row || row.subject !== args.subject)
            throw new ConvexError({ code: "FORBIDDEN" });
        const key = await approvalKey(args.id);
        const receipt = await findReceipt(ctx, args.deferred ? "answer" : "respond", await approvalKey(JSON.stringify([row.threadId, args.id])));
        if (receipt)
            return null;
        const request = row.approvals?.requests.find((r) => r.key === key && !!r.deferred === args.deferred);
        if (!request)
            throw new ConvexError({ code: args.deferred ? "TOOL_CALL_NOT_FOUND" : "APPROVAL_NOT_FOUND" });
        return readPending(ctx, row, request);
    },
});
/** Root plus bounded live children: <=59*34 KiB assignment metadata +
 * 256*32 KiB compact proposals + <=58*4 KiB child refs +16 KiB run
 * =10,446 KiB <10.3 MiB <16 MiB. Only <=16 assignments may be paused.
 * Native messages (up to 1 MiB of reasoning each) are never read here.
 * The host projects each item to <=16 KiB, giving <=4 MiB final output.
 */
export const pending = query({
    args: {
        assignmentId: v.id("assignments"),
        subject: v.string(),
        rootRunId: v.optional(v.string()),
    },
    returns: v.array(pendingItem),
    handler: async (ctx, args) => {
        const root = await ctx.db.get("assignments", args.assignmentId);
        if (!root || root.subject !== args.subject || root.rootAssignmentId)
            throw new ConvexError({ code: "FORBIDDEN" });
        const runId = args.rootRunId ?? root.runId;
        if (!runId)
            return [];
        if (runId !== root.runId)
            throw new ConvexError({ code: "RUN_NOT_FOUND" });
        const run = await ctx.db.get("runs", root.runId);
        if (!run)
            throw new ConvexError({ code: "RUN_NOT_FOUND" });
        const children = await ctx.db
            .query("subagentRuns")
            .withIndex("by_group", (q) => q.eq("parentRunId", root.runId))
            .take(root.limits.runLaunches + root.limits.sideRunsPerRun);
        const rows = [root];
        for (const child of children) {
            if (!child.childAssignmentId || child.status === "completed" || child.status === "failed")
                continue;
            const row = await ctx.db.get("assignments", child.childAssignmentId);
            if (row &&
                row.subject === args.subject &&
                row.rootAssignmentId === root._id &&
                row.runId === runId)
                rows.push(row);
        }
        const paused = rows.filter((r) => r.approvalBlocked && !r.cancelled && !r.approvals?.cleanupPending);
        if (paused.length > DECISION_LIMITS.assignments)
            throw new ConvexError({ code: "PENDING_LIMIT" });
        const result = [];
        for (const row of paused)
            for (const request of row.approvals.requests) {
                if (!request.resolved)
                    result.push(await readPending(ctx, row, request));
            }
        return result;
    },
});
/** Approved input is retrieved only for the exact recorded call, within its assignment.
 * It is stored on the request's own proposal, so it lives exactly as long as the
 * request: one <=32 KiB proposal read, no expiring receipt.
 */
export const effective = query({
    args: { assignmentId: v.id("assignments"), toolCallId: v.string() },
    returns: v.any(),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("assignments", args.assignmentId);
        const key = await approvalKey(args.toolCallId);
        const request = row?.approvals?.requests.find((r) => r.resolved && keyString(r.toolCallKey) === key);
        if (!row || !request || !request.effective)
            return null;
        const stored = await ctx.db.get("receipts", request.proposalId);
        if (stored?.kind !== "proposal" || !stored.result.approved)
            throw new ConvexError({ code: "APPROVED_INPUT_GONE" });
        return stored.result.approved;
    },
});
