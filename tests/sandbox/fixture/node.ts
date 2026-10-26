"use node";

import { sandboxNodeExport, sandboxNodeWrite } from "../../../src/modules/sandbox/client/index.js";
import { config } from "./host.js";
import { internalActionGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import type {
  SandboxContext,
  SandboxNodeWriteArgs,
  SandboxWriteResult,
} from "../../../src/modules/sandbox/client/types.js";
import { installStorageMetadata } from "./storage.js";

export const exportFile = sandboxNodeExport(config());
export function nodeWrite() {
  const action = sandboxNodeWrite(config()) as unknown as {
    _handler(ctx: SandboxContext, args: SandboxNodeWriteArgs): Promise<SandboxWriteResult>;
  };

  return internalActionGeneric({
    args: {
      subject: v.string(),
      threadId: v.string(),
      runId: v.string(),
      path: v.string(),
      source: v.object({ storageId: v.id("_storage") }),
      maxBytes: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
      installStorageMetadata(ctx);

      try {
        return await action._handler(ctx, args);
      } catch (error) {
        // convex-test passes thrown objects through. Production Convex keeps only
        // ConvexError data across runAction and reduces any other error to a message.
        if (error instanceof ConvexError) throw error;

        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
export const writeBytes = nodeWrite();
