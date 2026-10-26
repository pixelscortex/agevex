import { type Span } from "./otlp.js";
import type { BufferedSpan, Call, IntegrationContext, TurnContext } from "./types.js";
/** Admit a span only while unsealed and below the shared ceiling; ancestry is retained. */
export declare function add(context: IntegrationContext, name: string, path: string, operation: string, observation: string, parent?: BufferedSpan, kind?: Span["kind"]): BufferedSpan | undefined;
/** Mark a recorded span failed without retaining raw SDK diagnostics. */
export declare function fail(span: BufferedSpan | undefined, reason?: string): void;
/** End a span once; later failure attribution may still update its safe status. */
export declare function finish(span?: BufferedSpan, reason?: string): void;
/** Translate only known failed SDK finish reasons into safe diagnostics. */
export declare const finishFailure: (reason: string) => "Model call failed" | "Model call interrupted" | undefined;
/** Record opt-in content through the turn's bounded sanitizing writer. */
export declare function content(turn: TurnContext, span: BufferedSpan | undefined, key: string, value: unknown, enabled: boolean): void;
/** Keep only finite non-negative integer token counts from SDK usage. */
export declare function usage(turn: TurnContext, span: BufferedSpan | undefined, value: unknown): void;
/**
 * Wrap add() for a call's child span. A missing result means the span ceiling
 * dropped it (callbacks never run once sealed), so record that on the call and
 * mark its root: context.turn.buffer[0] is only the first call's root, which would tell a
 * reader nothing about this call's own tree.
 */
export declare function child(call: Call, span: BufferedSpan | undefined): BufferedSpan | undefined;
/** Open means created and not ended; a span dropped for the ceiling is not open. */
export declare const unfinished: (call: Call | undefined, span: BufferedSpan | undefined) => boolean;
/** Close open children as incomplete; a ceiling-dropped child was never open. */
export declare function endCall(context: IntegrationContext, callId: string, reason?: string): void;
