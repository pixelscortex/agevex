import { type FunctionReturnType } from "convex/server";
import type { UIMessage } from "@convex-dev/agent";
import { type AgevexApi } from "./types.js";
export declare const REACT_LIMITS: {
    readonly messages: 500;
    readonly page: 50;
    readonly pages: 10;
};
type Page = FunctionReturnType<NonNullable<AgevexApi["messages"]>>;
export type Message = UIMessage & Partial<Pick<Page["page"][number], "origin" | "from" | "runId">>;
/** Keep at most ten page subscriptions, not an unbounded cache hidden behind slice().
 * Each subscription requests <=50 messages with the server's 512 KiB read cap.
 * Ten pages budget 500 messages / 5 MiB of requested reads, plus native
 * pagination's final-document allowance and the bounded stream buffer.
 * Browsing farther back evicts the newest page; loadLatest returns to live work.
 */
export declare function useMessages(api: Omit<AgevexApi, "runTree">, threadId?: string): {
    messages: Message[];
    loadMore: () => void;
    canLoadMore: boolean;
    isLoadingMore: boolean;
    evicted: boolean;
    loadLatest: () => void;
    status: "skipped" | "loading" | "ready";
    data?: Message[] | undefined;
};
export {};
