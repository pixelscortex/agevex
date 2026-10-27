/**
 * Approval pauses: when a model step asks for tool approval (or calls a
 * declared no-execute "deferred" tool the host must answer), the turn stops
 * and waits for `turns.approvals.respond` / `turns.approvals.answer`.
 *
 * All of it runs inside `turns.slices.write`, in the same transaction as the native
 * assistant save that contains the requests: count them against
 * `LIMITS.approvalsPerPause` before the save, retire requests whose results
 * the save carries, collect the new requests as fixed-size hashes, and
 * suspend the turn with one continuation inbox row. Touches
 * `assignments.approvals` and `inbox`.
 */
import { approvalBlocked } from "../approvals.js";
import { ConvexError, getConvexSize } from "convex/values";
import { LIMITS } from "../limits.js";
import { approvalKey, callKey, keyString } from "../approvals.js";
import { firstReady } from "./inbox.js";
import { disarmSlice } from "./boundaries.js";
import { saveProposal } from "./decision_proposals.js";
/** Decided approvals still need native results from continuation generation. */
export function awaitingApprovalResults(row) {
    return !!row.approvals?.requests.some((request) => request.resolved);
}
/** The content parts of a native assistant message, or null for any other
 * role or a plain-text content string. */
function assistantParts(message) {
    const native = message.message;
    return native?.role === "assistant" && Array.isArray(native.content) ? native.content : null;
}
/** A host-answerable call: a non-provider tool call of a declared deferred
 * tool that the same message did not also put up for approval. */
function isDeferredCall(part, content, deferredTools) {
    return (part.type === "tool-call" &&
        !part.providerExecuted &&
        deferredTools.has(part.toolName) &&
        !content.some((candidate) => candidate.type === "tool-approval-request" && candidate.toolCallId === part.toolCallId));
}
/** How many approval requests and deferred calls a pending save would open.
 * Pure: write checks it BEFORE the native save so an overflow never exists. */
export function countPauseRequests(messages, deferredTools) {
    return messages.reduce((total, message) => {
        const content = assistantParts(message);
        if (!content)
            return total;
        return (total +
            content.filter((part) => part.type === "tool-approval-request" || isDeferredCall(part, content, deferredTools)).length);
    }, 0);
}
/** Retire recorded requests this save consumed: a tool result for the call,
 * or (for a resolved provider-executed request) any successful assistant
 * response. Mutates `row.approvals` so later steps see the remainder. */
export async function retireConsumedApprovals(ctx, row, messages) {
    const resulted = new Set();
    for (const message of messages) {
        if (message.message?.role !== "tool" || !Array.isArray(message.message.content))
            continue;
        for (const part of message.message.content)
            if (part.type === "tool-result")
                resulted.add(await approvalKey(part.toolCallId));
    }
    const providerConsumed = messages.some((message) => message.message?.role === "assistant" &&
        message.status === "success" &&
        Array.isArray(message.message.content));
    // A running turn is claimed only after every recorded request was
    // resolved (claim refuses approvalBlocked), and respond/answer refuse
    // while it runs, so "resolved" here means decided AND resumed.
    const remaining = row.approvals.requests.filter((request) => !(providerConsumed && request.providerExecuted && request.resolved) &&
        !resulted.has(keyString(request.toolCallKey)));
    for (const request of row.approvals.requests)
        if (!remaining.includes(request))
            await ctx.db.delete("receipts", request.proposalId);
    row.approvals = remaining.length ? { ...row.approvals, requests: remaining } : undefined;
    await ctx.db.patch("assignments", row._id, { approvals: row.approvals });
}
/** Collect the approval requests, then the deferred calls, that a native save
 * opened, saving their compact proposals in the same transaction. Throws if a
 * deferred call's id/name cannot fit in one bounded cleanup document. */
export async function collectPause(ctx, messages, deferredTools, askTools = {}) {
    const pause = { requests: [], count: 0 };
    await addApprovalRequests(ctx, pause, messages, askTools);
    await addDeferredCalls(ctx, pause, messages, deferredTools, askTools);
    return pause;
}
async function addApprovalRequests(ctx, pause, messages, askTools) {
    for (const message of messages) {
        const content = assistantParts(message);
        if (!content)
            continue;
        for (const part of content) {
            if (part.type !== "tool-approval-request")
                continue;
            pause.requestMessageId ??= message._id;
            pause.count++;
            const key = await approvalKey(part.approvalId);
            if (pause.requests.some((request) => request.key === key))
                continue;
            const call = content.find((call) => call.type === "tool-call" && call.toolCallId === part.toolCallId);
            if (call?.type !== "tool-call")
                throw new ConvexError({ code: "PENDING_CALL_NOT_FOUND" });
            pause.requests.push({
                key,
                messageId: message._id,
                proposalId: await saveProposal(ctx, call, part.approvalId, askTools[call.toolName]),
                toolCallKey: await callKey(part.toolCallId),
                providerExecuted: content.some((call) => call.type === "tool-call" &&
                    call.toolCallId === part.toolCallId &&
                    call.providerExecuted === true),
            });
        }
    }
}
/** Only calls from declared no-execute tools can become host-answerable.
 * Record hashes + the exact native message id in the SAME transaction as
 * that assistant save. Only the bounded proposal is copied into receipts. */
async function addDeferredCalls(ctx, pause, messages, deferredTools, askTools) {
    for (const message of messages) {
        const content = assistantParts(message);
        if (!content)
            continue;
        for (const part of content) {
            if (part.type !== "tool-call" || !isDeferredCall(part, content, deferredTools))
                continue;
            const key = await approvalKey(part.toolCallId);
            const alreadyResulted = messages.some((doc) => doc.message?.role === "tool" &&
                doc.message.content.some((result) => result.type === "tool-result" && result.toolCallId === part.toolCallId));
            if (alreadyResulted ||
                pause.requests.some((request) => request.key === key && request.deferred))
                continue;
            // The cancellation result repeats the native ids. Refuse an id/name
            // envelope that cannot be settled in one bounded cleanup document.
            if (getConvexSize({ toolCallId: part.toolCallId, toolName: part.toolName }) +
                LIMITS.nativeEnvelopeBytes >
                LIMITS.cleanupMessageBytes)
                throw new ConvexError({ code: "DEFERRED_CALL_TOO_LARGE" });
            pause.requests.push({
                key,
                messageId: message._id,
                proposalId: await saveProposal(ctx, part, part.toolCallId, askTools[part.toolName]),
                toolCallKey: await callKey(part.toolCallId),
                providerExecuted: false,
                deferred: true,
            });
            pause.requestMessageId ??= message._id;
            pause.count++;
        }
    }
}
/** Suspend the running turn on the requests just recorded: close the slice,
 * insert the continuation row at the head of the ready FIFO, and commit
 * the request hashes and native handles. */
export async function suspendForApprovals(ctx, row, pause, handles) {
    await disarmSlice(ctx, row);
    if (approvalBlocked(row))
        throw new ConvexError({ code: "APPROVAL_ALREADY_PENDING" });
    if (row.approvals?.requests.length)
        throw new ConvexError({ code: "APPROVAL_RESULTS_MISSING" });
    // This is the suspended turn's control continuation, so it uses the
    // reserved head/approval slot even when ordinary ready work is full.
    // answer/respond update this exact row instead of admitting more work;
    // 100 message rows +50 owed results +one parent-answer slot +this continuation
    // remain within the 152-row per-assignment cancel bound in limits.ts.
    // Results enter the queue regardless of this continuation.
    // The response continuation must precede unrelated queued sends.
    const head = await firstReady(ctx, row._id);
    const inboxId = await ctx.db.insert("inbox", {
        assignmentId: row._id,
        runId: row.runId,
        messageId: pause.requestMessageId,
        sequence: head ? head.sequence - 1 : row.nextSequence,
        kind: row.turnOrigin === "subagent_result" ? "result" : "user",
    });
    // Commit the block with the native request, even if the action dies
    // immediately after this mutation. No later action owns this fact.
    await ctx.db.patch("assignments", row._id, {
        turnReport: row.turnReport ? { ...row.turnReport, resumeInboxId: inboxId } : undefined,
        approvals: {
            inboxId,
            requests: pause.requests,
            epoch: row.cancellationEpoch,
            getMessages: handles.getMessages,
            addMessages: handles.addMessages,
        },
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
        inboxId: undefined,
        queuedMessages: row.queuedMessages + 1,
        nextSequence: row.nextSequence + 1,
    });
}
