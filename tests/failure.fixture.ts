/** Drive the real Workflow completion callback for manually claimed fixtures. */
import { componentsGeneric, type FunctionReference } from "convex/server";
import { setup, rawAssignment } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";

/** The loop callback uses exactly the same fences as a failed paid step. */
export async function failLoop(
  t: ReturnType<typeof setup>,
  assignmentId: string,
  kind: "success" | "failed" | "canceled" = "success",
) {
  const row = (await t.query(rawAssignment, { assignmentId }))!;

  const args = {
    assignmentId,
    workflowId: row.workflowId!,
    executionId: row.turnToken!,
    epoch: row.cancellationEpoch,
  };

  await workflowCall(
    t,
    `agevex/${row.childRunId ? "childWorkflow" : "rootWorkflow"}`,
    "mutation",
    "workflow",
    "complete",
    {
      workflowId: row.workflowId,
      generationNumber: 0,
      runResult:
        kind === "success"
          ? { kind, returnValue: { executionId: args.executionId, epoch: args.epoch } }
          : kind === "failed"
            ? { kind, error: "loop driver failed before consuming nested result" }
            : { kind },
    },
  );

  return args;
}

/** Duplicate finalization is a no-op, even after a replacement loop starts. */
export const finalizeFailure = componentsGeneric().agevex.turns.failures
  .failWorkflow as unknown as FunctionReference<"mutation">;
