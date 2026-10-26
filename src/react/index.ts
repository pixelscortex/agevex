"use client";
// Headless hooks over the app's public authorized refs and existing ConvexProvider.
import { useMutation, useQuery } from "convex/react";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import { required, queryState, threadRequired, type AgevexApi } from "./types.js";
import { useMessages } from "./messages.js";

export type { AgevexApi, QueryState } from "./types.js";
type TreeRef = FunctionReference<
  "query",
  "public",
  { threadId: string; rootRunId?: string },
  unknown
>;
type Pending = FunctionReturnType<NonNullable<AgevexApi["pendingApprovals"]>>[number];

/** Generate once per new intent. Convex retries the mutation's exact arguments;
 * apps can also retain an explicit key when retrying a rejected send promise.
 */
function requestKey() {
  return crypto.randomUUID();
}

/** All refs are optional at registration; an invoked hook checks its own needs. */
export function createAgevexHooks<Tree extends TreeRef = NonNullable<AgevexApi["runTree"]>>(
  api: Omit<AgevexApi, "runTree"> & { runTree?: Tree },
) {
  return {
    useThread(threadId?: string) {
      return useThread(api, threadId);
    },
    useRunTree(threadId?: string, rootRunId?: string) {
      const ref = api.runTree;

      if (!ref)
        throw new Error("agevex/react: export the authorized 'runTree' endpoint to use this hook");

      const data = useQuery(
        ref as TreeRef,
        threadId === undefined
          ? "skip"
          : { threadId, ...(rootRunId === undefined ? {} : { rootRunId }) },
      );

      return queryState<FunctionReturnType<Tree>>(
        threadId,
        data as FunctionReturnType<Tree> | undefined,
      );
    },
    usePendingApprovals(threadId?: string) {
      return useApprovals(api, threadId);
    },
    useAsk(threadId?: string) {
      return useAsk(api, threadId);
    },
    useTitle(threadId?: string) {
      return useTitle(api, threadId);
    },
    useSummary(threadId?: string) {
      return useSummary(api, threadId);
    },
  };
}

function useThread(api: Omit<AgevexApi, "runTree">, threadId?: string) {
  const messages = useMessages(api, threadId);
  const send = useMutation(required(api, "send"));
  const cancel = useMutation(required(api, "cancel"));

  return {
    ...messages,
    send: async (text: string, intent?: { requestKey: string }) =>
      send({
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
function usePending(
  api: Omit<AgevexApi, "runTree">,
  threadId: string | undefined,
  kind: Pending["kind"],
) {
  const data = useQuery(
    required(api, "pendingApprovals"),
    threadId === undefined ? "skip" : { threadId },
  );

  const target = (item: Pending) => {
    threadRequired(threadId);

    if (
      !data?.some(
        (entry) => entry.id === item.id && entry.threadId === item.threadId && entry.kind === kind,
      )
    )
      throw new Error("agevex/react: select a current pending decision");

    return { threadId: item.threadId, approvalId: item.id };
  };

  return {
    ...queryState(
      threadId,
      data?.filter((item) => item.kind === kind),
    ),
    target,
  };
}

function useApprovals(api: Omit<AgevexApi, "runTree">, threadId?: string) {
  const { target, ...state } = usePending(api, threadId, "approval");
  const respond = useMutation(required(api, "respond"));

  return {
    ...state,
    approve: async (item: Pending) => respond({ ...target(item), decision: { kind: "approve" } }),
    reject: async (item: Pending, reason?: string) =>
      respond({
        ...target(item),
        decision: { kind: "reject", ...(reason === undefined ? {} : { reason }) },
      }),
    edit: async (item: Pending, input: unknown) =>
      respond({ ...target(item), decision: { kind: "approve", edit: { input } } }),
  };
}

function useAsk(api: Omit<AgevexApi, "runTree">, threadId?: string) {
  const { target, ...state } = usePending(api, threadId, "ask");
  const answer = useMutation(required(api, "answer"));

  return {
    ...state,
    answer: async (item: Pending, value: unknown) => {
      target(item);

      return answer({ threadId: item.threadId, toolCallId: item.toolCallId, value });
    },
  };
}

function useTitle(api: Omit<AgevexApi, "runTree">, threadId?: string) {
  const data = useQuery(required(api, "title"), threadId === undefined ? "skip" : { threadId });
  const rename = useMutation(required(api, "rename"));

  return {
    ...queryState(threadId, data),
    rename: async (text: string) => {
      const id = threadRequired(threadId);

      if (data === undefined) throw new Error("agevex/react: wait for the title before renaming");

      return rename({ threadId: id, text, expectedVersion: data.version });
    },
  };
}

function useSummary(api: Omit<AgevexApi, "runTree">, threadId?: string) {
  const data = useQuery(required(api, "summary"), threadId === undefined ? "skip" : { threadId });
  const summarize = useMutation(required(api, "summarize"));

  return {
    ...queryState(threadId, data),
    summarize: async () =>
      summarize({ threadId: threadRequired(threadId), requestKey: requestKey() }),
  };
}
