/** Test projections keep pause assertions independent of persisted row fields. */
import { approvalBlocked } from "../src/component/approvals.js";
import type { Doc } from "../src/component/_generated/dataModel.js";

export function approvalState(row: Doc<"assignments"> | null | undefined) {
  return row ? { ...row, approvalBlocked: approvalBlocked(row) } : row;
}
