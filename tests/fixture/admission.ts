// Scheduled host work used to observe admit's transactional scheduler writes.
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";

export const scheduled = internalMutationGeneric({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
