"use client";
// Headless hooks over the app's public authorized refs and existing ConvexProvider.
import { useMutation, useQuery } from "convex/react";
import { required, queryState, threadRequired } from "./types.js";
import { useMessages } from "./messages.js";
/** Generate once per new intent. Convex retries the mutation's exact arguments;
 * apps can also retain an explicit key when retrying a rejected send promise.
 */
function requestKey() {
    return crypto.randomUUID();
}
/** All refs are optional at registration; an invoked hook checks its own needs. */
export function createAgevexHooks(api) {
    return {
        useThread(threadId) {
            return useThread(api, threadId);
        },
        useRunTree(threadId, rootRunId) {
            const ref = api.runTree;
            if (!ref)
                throw new Error("agevex/react: export the authorized 'runTree' endpoint to use this hook");
            const data = useQuery(ref, threadId === undefined
                ? "skip"
                : { threadId, ...(rootRunId === undefined ? {} : { rootRunId }) });
            return queryState(threadId, data);
        },
        usePendingApprovals(threadId) {
            return useApprovals(api, threadId);
        },
        useAsk(threadId) {
            return useAsk(api, threadId);
        },
        useTitle(threadId) {
            return useTitle(api, threadId);
        },
    };
}
function useThread(api, threadId) {
    const messages = useMessages(api, threadId);
    const send = useMutation(required(api, "send"));
    const cancel = useMutation(required(api, "cancel"));
    return {
        ...messages,
        send: async (text, intent) => send({
            threadId: threadRequired(threadId),
            text,
            requestKey: intent?.requestKey ?? requestKey(),
        }),
        cancel: async () => cancel({ threadId: threadRequired(threadId) }),
    };
}
/** Use the same query/args in both hooks so Convex shares the subscription.
 * Take the pending item so approvals on descendants address their owned thread.
 * Never remove an item locally: only a committed server receipt resolves it.
 */
function usePending(api, threadId, kind) {
    const data = useQuery(required(api, "pendingApprovals"), threadId === undefined ? "skip" : { threadId });
    const target = (item) => {
        threadRequired(threadId);
        if (!data?.some((entry) => entry.id === item.id && entry.threadId === item.threadId && entry.kind === kind))
            throw new Error("agevex/react: select a current pending decision");
        return { threadId: item.threadId, approvalId: item.id };
    };
    return {
        ...queryState(threadId, data?.filter((item) => item.kind === kind)),
        target,
    };
}
function useApprovals(api, threadId) {
    const { target, ...state } = usePending(api, threadId, "approval");
    const respond = useMutation(required(api, "respond"));
    return {
        ...state,
        approve: async (item) => respond({ ...target(item), decision: { kind: "approve" } }),
        reject: async (item, reason) => respond({
            ...target(item),
            decision: { kind: "reject", ...(reason === undefined ? {} : { reason }) },
        }),
        edit: async (item, input) => respond({ ...target(item), decision: { kind: "approve", edit: { input } } }),
    };
}
function useAsk(api, threadId) {
    const { target, ...state } = usePending(api, threadId, "ask");
    const answer = useMutation(required(api, "answer"));
    return {
        ...state,
        answer: async (item, value) => {
            target(item);
            return answer({ threadId: item.threadId, toolCallId: item.toolCallId, value });
        },
    };
}
function useTitle(api, threadId) {
    const data = useQuery(required(api, "title"), threadId === undefined ? "skip" : { threadId });
    const rename = useMutation(required(api, "rename"));
    return {
        ...queryState(threadId, data),
        rename: async (text) => {
            const id = threadRequired(threadId);
            return rename({ threadId: id, text });
        },
    };
}
