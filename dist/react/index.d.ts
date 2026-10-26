import type { FunctionReference, FunctionReturnType } from "convex/server";
import { type AgevexApi } from "./types.js";
export type { AgevexApi, QueryState } from "./types.js";
type TreeRef = FunctionReference<"query", "public", {
    threadId: string;
    rootRunId?: string;
}, unknown>;
type Pending = FunctionReturnType<NonNullable<AgevexApi["pendingApprovals"]>>[number];
/** All refs are optional at registration; an invoked hook checks its own needs. */
export declare function createAgevexHooks<Tree extends TreeRef = NonNullable<AgevexApi["runTree"]>>(api: Omit<AgevexApi, "runTree"> & {
    runTree?: Tree;
}): {
    useThread(threadId?: string): {
        send: (text: string, intent?: {
            requestKey: string;
        }) => Promise<{
            status: "rejected";
            code: "INVALID_MESSAGE" | "INVALID_REQUEST_KEY";
        } | {
            status: "rejected";
            code: "UNKNOWN_AGENT";
        } | {
            status: "rejected";
            code: "INVALID_MODELS";
        } | {
            status: "rejected";
            code: "KEY_CONFLICT";
        } | {
            receiptId: string;
            status: "duplicate";
            assignmentId: string;
            threadId: string;
            position: number;
            code?: undefined;
        } | {
            assignmentId: string;
            threadId: string;
            receiptId: string;
            status: "accepted";
            position: number;
        } | {
            status: "rejected";
            code: "CANCELLED" | "RECOVERY_REQUIRED";
        } | {
            status: "rejected";
            code: "QUEUE_FULL";
        } | {
            status: "rejected";
            code: "ATTACHMENT_LIMIT";
        }>;
        cancel: () => Promise<null>;
        messages: import("./messages.js").Message[];
        loadMore: () => void;
        canLoadMore: boolean;
        isLoadingMore: boolean;
        evicted: boolean;
        loadLatest: () => void;
        status: "skipped" | "loading" | "ready";
        data?: import("./messages.js").Message[] | undefined;
    };
    useRunTree(threadId?: string, rootRunId?: string): import("./types.js").QueryState<FunctionReturnType<Tree>>;
    usePendingApprovals(threadId?: string): {
        approve: (item: Pending) => Promise<{
            messageId: string;
            replayed: boolean;
        }>;
        reject: (item: Pending, reason?: string) => Promise<{
            messageId: string;
            replayed: boolean;
        }>;
        edit: (item: Pending, input: unknown) => Promise<{
            messageId: string;
            replayed: boolean;
        }>;
        status: "skipped" | "loading" | "ready";
        data?: {
            schema?: any;
            editable: boolean;
            threadId: string;
            agent: string;
            kind: "ask" | "approval";
            truncated?: true | undefined;
            id: string;
            providerExecuted: boolean;
            toolCallId: string;
            tool: string;
            input: any;
        }[] | undefined;
    };
    useAsk(threadId?: string): {
        answer: (item: Pending, value: unknown) => Promise<{
            messageId: string;
            replayed: boolean;
        }>;
        status: "skipped" | "loading" | "ready";
        data?: {
            schema?: any;
            editable: boolean;
            threadId: string;
            agent: string;
            kind: "ask" | "approval";
            truncated?: true | undefined;
            id: string;
            providerExecuted: boolean;
            toolCallId: string;
            tool: string;
            input: any;
        }[] | undefined;
    };
    useTitle(threadId?: string): {
        rename: (text: string) => Promise<{
            messageId: string;
            replayed: boolean;
        }>;
        status: "skipped" | "loading" | "ready";
        data?: {
            text: string | null;
            source: "auto" | "user" | null;
            version: number;
        } | undefined;
    };
    useSummary(threadId?: string): {
        summarize: () => Promise<{
            status: "replayed";
        } | {
            status: "queued";
        }>;
        status: "skipped" | "loading" | "ready";
        data?: {
            text: string;
            throughMessageId: string;
        } | null | undefined;
    };
};
