import { mutationGeneric } from "convex/server";

// Test-only module mounted inside the real core component. Seed an active
// execution so bindOnceTool exercises core's actual epoch/claim checks rather
// than replacing the receipt ledger with a mock implementation.
export const seed = mutationGeneric({
  args: {},
  handler: (ctx) =>
    ctx.db.insert("assignments", {
      subject: "owner",
      agent: "SandboxTest",
      threadId: "thread",
      runTurn: "unused",
      cancellationEpoch: 0,
      cancelled: false,
      turnStatus: "running",
      errorCode: null,
      queuedMessages: 0,
      notesPending: 0,
      nextSequence: 0,
      nextTurn: 0,
      turnToken: "execution",
    }),
});
