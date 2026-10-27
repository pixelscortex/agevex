// The per-turn context objects passed between the turn modules.
//
// `Turn` is what one `runTurn` action knows after a successful claim (the queued
// execution, the claimed facts, the executing agent, attribution facts).
// `Generation` adds what exists only while the model runs: the cancellation fence,
// the hook context, the hook runner, and the mutable generation flags.
// `TurnOutcome` is what generation hands to finalization. The fence predicates
// `stillOwns` / `stillRunning` live here because every phase re-checks them.
/** The key that names this slice: the slice id when sliced, else the turn token. */
export function sliceKey(turn) {
    return turn.args.sliceId ?? turn.args.turnToken;
}
/**
 * Whether the turn still owns its execution: same turn token, same cancellation
 * epoch, not cancelled. Re-checked before every terminal write so a cancelled or
 * superseded turn never finishes, continues or settles anything.
 */
export function stillOwns(row, turn) {
    return (!!row &&
        !row.cancelled &&
        row.turnToken === turn.args.turnToken &&
        row.cancellationEpoch === turn.claimed.cancellationEpoch);
}
/** `stillOwns` and the turn is still `running` (the generation-time fence). */
export function stillRunning(row, turn) {
    return stillOwns(row, turn) && row.turnStatus === "running";
}
/** A native approval save intentionally clears the token. Only this slice's
 * last committed assistant id can justify that exception for usage delivery;
 * a resumed/replaced execution or a cancellation must still revoke retries. */
export function stillReporting(row, turn) {
    const messageId = turn.stepUsage?.native?._id ?? turn.usageSave?.messageId;
    return (stillRunning(row, turn) ||
        (!!row &&
            !row.cancelled &&
            row.cancellationEpoch === turn.claimed.cancellationEpoch &&
            row.turnStatus === "idle" &&
            !row.turnToken &&
            row.approvalBlocked &&
            !!messageId &&
            row.messageIds[row.messageIds.length - 1] === messageId));
}
