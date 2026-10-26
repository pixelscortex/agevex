import type { Receipt } from "../src/client/index.js";

/** Callers that need a thread must narrow the public receipt before using ids. */
export function requireReceipt<T extends Receipt>(receipt: T): Exclude<T, { status: "rejected" }> {
  if (receipt.status === "rejected") throw new Error(receipt.code);

  return receipt as Exclude<T, { status: "rejected" }>;
}
