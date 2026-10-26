/** Select exact native identities, accounting for full document read sizes.
 * Summaries are display-only; native model context always owns its history. */
import type { Doc } from "../_generated/dataModel.js";
/** Native order, not save sequence, orders queued prompts and late responses. */
export declare function after(a: {
    order: number;
    stepOrder: number;
}, b: {
    order: number;
    stepOrder: number;
}): boolean;
/** At most the existing 24-ref ring and 2 MiB of exact-id reads. Stop at the
 * first byte overflow so a skipped middle document cannot become coverage. */
export declare function summaryWindow(row: Doc<"assignments">): {
    refs: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
        sequence: number;
    }[];
    previous: string;
    through: {
        id: string;
        order: number;
        stepOrder: number;
        sequence: number;
    };
} | null;
