// Bounded native cursor subscriptions plus Agent's incremental stream reducer.
import { useQueries } from "convex/react";
import { useMemo, useState } from "react";
import { useStreamingUIMessages } from "@convex-dev/agent/react";
import { getFunctionName } from "convex/server";
import { queryState, required } from "./types.js";
import { combineMessages } from "./combine.js";
export const REACT_LIMITS = { messages: 500, page: 50, pages: 10 };
/** Keep at most ten page subscriptions, not an unbounded cache hidden behind slice().
 * Each subscription requests <=50 messages with the server's 512 KiB read cap.
 * Ten pages budget 500 messages / 5 MiB of requested reads, plus native
 * pagination's final-document allowance and the bounded stream buffer.
 * Browsing farther back evicts the newest page; loadLatest returns to live work.
 */
export function useMessages(api, threadId) {
    const messagesRef = required(api, "messages");
    const streamsRef = required(api, "streams");
    const [window, setWindow] = useState({
        threadId,
        cursors: [null],
        evicted: false,
    });
    const current = window.threadId === threadId ? window : { threadId, cursors: [null], evicted: false };
    if (window.threadId !== threadId)
        setWindow(current);
    const queries = useMemo(() => threadId === undefined
        ? {}
        : Object.fromEntries(current.cursors.map((cursor, i) => [
            String(i),
            {
                query: messagesRef,
                args: { threadId, paginationOpts: { cursor, numItems: REACT_LIMITS.page } },
            },
        ])), 
    // Generated anyApi proxies create a new ref object on each property read.
    // Convex identifies refs by name; matching that keeps useQueries stable.
    [threadId, current.cursors, getFunctionName(messagesRef)]);
    const results = useQueries(queries);
    const pages = current.cursors.map((_, i) => results[String(i)]);
    for (const page of pages)
        if (page instanceof Error)
            throw page;
    const cursors = reconnectPages(current.cursors, pages);
    if (cursors)
        setWindow({ ...current, cursors });
    // An uncached older page must not suspend the transcript or its live stream.
    const loaded = pages.filter((page) => page !== undefined);
    const ready = loaded.length > 0;
    const complete = loaded.length === pages.length;
    const stored = loaded.flatMap((page) => page.page);
    const streaming = useStreamingUIMessages(streamsRef, threadId === undefined || !ready || current.evicted ? "skip" : { threadId }, { startOrder: stored.length ? Math.min(...stored.map((m) => m.order)) : 0 });
    // Agent retains its reducer while a stream query is skipped. Do not expose
    // that previous thread's buffer while the new transcript is still loading.
    const merged = mergeMessages(stored, current.evicted || !ready || threadId === undefined ? [] : (streaming ?? []));
    const messages = merged.messages;
    const last = pages[pages.length - 1];
    const loadMore = () => {
        if (!complete || !last || last.isDone || threadId === undefined)
            return;
        setWindow((previous) => {
            if (previous !== current)
                return previous;
            const cursors = [...current.cursors, last.continueCursor];
            const evicted = current.evicted || cursors.length > REACT_LIMITS.pages;
            return { threadId, cursors: cursors.slice(-REACT_LIMITS.pages), evicted };
        });
    };
    return {
        ...queryState(threadId, ready ? messages : undefined),
        messages,
        loadMore,
        canLoadMore: complete && !!last && !last.isDone,
        isLoadingMore: threadId !== undefined && ready && !complete,
        evicted: current.evicted || merged.evicted,
        loadLatest: () => setWindow({ threadId, cursors: [null], evicted: false }),
    };
}
/** Native fixed-size pages can move after a reactive insert. Reconnect only
 * already requested successors before showing the window, preventing gaps or
 * overlaps without auto-paging history. Each page remains independently bounded.
 */
function reconnectPages(cursors, pages) {
    const moved = pages.findIndex((_, i) => i > 0 && pages[i - 1] !== undefined && cursors[i] !== pages[i - 1].continueCursor);
    if (moved < 0)
        return undefined;
    const next = [...cursors];
    next[moved] = pages[moved - 1].continueCursor;
    return next;
}
/** Prefer finalized native messages; preserve origin annotations on stored rows.
 * Agent useUIMessages cannot consume separate refs for messages/streams and its
 * pagination retains all pages (agent/src/vercel/react/useUIMessages.ts:137).
 * Reuse agent/src/vercel/react/useStreamingUIMessages.ts:38 instead, including
 * its native cursor reduction, with our separate authorized stream reference.
 */
function mergeMessages(stored, streaming) {
    const byPosition = new Map();
    for (const message of [...streaming, ...stored]) {
        const key = `${message.order}:${message.stepOrder}`;
        const previous = byPosition.get(key);
        if (!previous || message.status === "success" || previous.status !== "streaming")
            byPosition.set(key, message);
    }
    const combined = combineMessages([...byPosition.values()].sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder));
    return {
        messages: combined.slice(-REACT_LIMITS.messages),
        evicted: combined.length > REACT_LIMITS.messages,
    };
}
