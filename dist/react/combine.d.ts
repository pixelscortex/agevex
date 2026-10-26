import type { Message } from "./messages.js";
/** Agent 0.7.7 useUIMessages.ts:171-179 combines AFTER deduping original
 * step orders. Neither mergeUIMessages nor combineUIMessages is exported by
 * the package's public entries. Follow vercel/UIMessages.ts:894-945 here:
 * assistant fragments of the same order form one message; tool parts merge
 * by call id without overwriting existing input with undefined result fields.
 * Keep the first fragment's identity and agevex origin annotations.
 */
export declare function combineMessages(messages: Message[]): Message[];
