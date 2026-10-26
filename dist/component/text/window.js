import { TEXT_LIMITS } from "./values.js";
/** Native order, not save sequence, orders queued prompts and late responses. */
export function after(a, b) {
    return a.order > b.order || (a.order === b.order && a.stepOrder > b.stepOrder);
}
/** At most the existing 24-ref ring and 2 MiB of exact-id reads. Stop at the
 * first byte overflow so a skipped middle document cannot become coverage. */
export function summaryWindow(row) {
    const previous = row.textSummary;
    const completed = row.textCompleted;
    if (!completed)
        return null;
    const candidates = (row.contextMessages ?? [])
        .filter((ref) => ref.sequence <= completed.sequence &&
        !after(ref, completed) &&
        (!previous || after(ref, previous.through)))
        .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
    // A later in-flight turn may have evicted the completed boundary. Never
    // advertise coverage for a boundary whose exact identity is no longer held.
    if (!candidates.some((ref) => ref.id === completed.id))
        return null;
    let bytes = 0;
    const refs = [];
    for (const ref of [...candidates].reverse()) {
        if (bytes + ref.bytes > TEXT_LIMITS.readBytes)
            break;
        bytes += ref.bytes;
        refs.unshift(ref);
    }
    if (!refs.length)
        return null;
    const sequences = refs.map((ref) => ref.sequence).sort((a, b) => a - b);
    const last = refs[refs.length - 1];
    return {
        refs,
        previous: previous?.text ?? "",
        through: {
            id: last.id,
            order: last.order,
            stepOrder: last.stepOrder,
            sequence: Math.max(...sequences),
        },
    };
}
