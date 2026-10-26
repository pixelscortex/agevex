/** Select exact native identities, accounting for full document read sizes.
 * Gaps remain display-only; only a contiguous complete prefix may compact. */
import type { Doc } from "../_generated/dataModel.js";
import { TEXT_LIMITS } from "./values.js";

/** Native order, not save sequence, orders queued prompts and late responses. */
export function after(
  a: { order: number; stepOrder: number },
  b: { order: number; stepOrder: number },
) {
  return a.order > b.order || (a.order === b.order && a.stepOrder > b.stepOrder);
}

/** At most the existing 24-ref ring and 2 MiB of exact-id reads. Stop at the
 * first byte overflow so a skipped middle document cannot become coverage. */
export function summaryWindow(row: Doc<"assignments">) {
  const previous = row.textSummary;
  const completed = row.textCompleted;

  if (!completed) return null;

  const candidates = (row.contextMessages ?? [])
    .filter(
      (ref) =>
        ref.sequence <= completed.sequence &&
        !after(ref, completed) &&
        (!previous || after(ref, previous.through)),
    )
    .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

  // A later in-flight turn may have evicted the completed boundary. Never
  // advertise coverage for a boundary whose exact identity is no longer held.
  if (!candidates.some((ref) => ref.id === completed.id)) return null;

  let bytes = 0;
  const refs: typeof candidates = [];

  for (const ref of [...candidates].reverse()) {
    if (bytes + ref.bytes > TEXT_LIMITS.readBytes) break;

    bytes += ref.bytes;
    refs.unshift(ref);
  }

  if (!refs.length) return null;

  const sequences = refs.map((ref) => ref.sequence).sort((a, b) => a - b);

  const complete =
    (previous?.complete ?? true) &&
    (!previous || previous.epoch === row.cancellationEpoch) &&
    sequences[0] === (previous?.through.sequence ?? 0) + 1 &&
    sequences.every((sequence, i) => sequence === sequences[0] + i);

  const last = refs[refs.length - 1];

  return {
    refs,
    previous: previous?.text ?? "",
    complete,
    through: {
      id: last.id,
      order: last.order,
      stepOrder: last.stepOrder,
      sequence: Math.max(...sequences),
    },
  };
}
