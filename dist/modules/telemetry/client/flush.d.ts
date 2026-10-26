import type { TurnContext } from "./types.js";
/** Seal synchronously and detach the buffer before awaiting any digest or exporter. */
export declare function flushTurn(turn: TurnContext, signal?: AbortSignal): Promise<void>;
