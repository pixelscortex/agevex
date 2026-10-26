// The tool set one generation runs with.
//
// `buildTurnTools` merges the agent's declared tools with the slot tool bags
// (rejecting collisions and reserved names), binds every tool to the turn's
// receipts ledger and fence (`bindOnceTool`), wraps every executable tool in the
// `beforeTool` / `afterTool` hooks, and finally installs the managed
// collaboration tools (`collaboration-tools.ts`), which are deliberately not
// wrapped by the generic tool hooks.

import type { Tool, ToolExecutionOptions, ToolSet } from "ai";
import { opaqueKey } from "../keys.js";
import { bindOnceTool } from "../once.js";
import type { RuntimeContext } from "../registration/context.js";
import { scopedMeter } from "../slots.js";
import { RESERVED_TOOL_NAMES } from "../tool-names.js";
import { installCollaborationTools } from "./collaboration-tools.js";
import { boundToolDeadlines } from "./deadlines.js";
import type { Generation } from "./context.js";
import { slotToolBags } from "./slots.js";
import { assertBudget } from "./admission.js";

/** Build the complete tool set for one generation. */
export async function buildTurnTools(rt: RuntimeContext, gen: Generation): Promise<ToolSet> {
  const { turn, hc, backend } = gen;
  const { rawCtx, args, claimed, managed } = turn;
  const eligible = (rt.graph.edges.get(claimed.agent)?.size ?? 0) > 0;

  const merged = mergeSlotTools(managed.declaredTools, ...(await slotToolBags(rt, turn, hc)));

  const tools = Object.fromEntries(
    Object.entries(merged).map(([name, declared]) => [
      name,
      bindOnceTool(
        declared,
        rt.component,
        rawCtx,
        hc,
        {
          assignmentId: args.assignmentId,
          executionId: args.turnToken,
          cancellationEpoch: claimed.cancellationEpoch,
        },
        rt.limits.leaseMs,
        backend,
      ),
    ]),
  );

  // Agent 0.7.7 createTool.ts:315-329 and wrapTools:378-397
  // inject context through dynamic `this`; preserve that receiver.
  // SDK collaboration tools are installed AFTER this wrapper. Their
  // capability protocols must not be rewritten by generic tool hooks;
  // delegation has its own beforeDelegate interception point.
  for (const [name, declared] of Object.entries(tools)) {
    if (!declared.execute) continue; // Deferred/provider-owned effects execute outside this action.

    tools[name] = withToolHooks(rt, gen, name, declared);
  }

  installCollaborationTools(rt, gen, tools, eligible);

  return boundToolDeadlines(gen, tools, () => assertBudget(rt, gen));
}

/**
 * Merge tool bags into one set. A name may appear once across all bags and may
 * never be a reserved managed tool name, so a slot cannot shadow a host tool
 * or impersonate a collaboration tool.
 */
function mergeSlotTools(...bags: ToolSet[]): ToolSet {
  const merged: ToolSet = {};

  for (const bag of bags)
    for (const [name, value] of Object.entries(bag)) {
      if (name in merged || RESERVED_TOOL_NAMES.includes(name))
        throw new Error("SLOT_TOOL_COLLISION");

      merged[name] = value;
    }

  return merged;
}

/**
 * Wrap one executable tool in the agent's tool hooks.
 *
 * `beforeTool` may block (the model gets a `HOOK_BLOCKED` denial) or rewrite the
 * input; `afterTool` may rewrite the output, including every value a streaming
 * tool yields. The tool receives an opaque per-call key and a per-call meter.
 */
function withToolHooks(rt: RuntimeContext, gen: Generation, name: string, declared: Tool): Tool {
  const { turn, hc, hook, backend, fence } = gen;
  const { managed, facts } = turn;
  const execute = declared.execute!;

  return {
    ...declared,
    execute: async function (input: unknown, options: ToolExecutionOptions<any>) {
      const before = await hook(
        managed.hooks?.beforeTool
          ? () => managed.hooks!.beforeTool!(hc, { tool: name, input })
          : undefined,
      );

      if (before?.block) return { status: "denied", code: "HOOK_BLOCKED", reason: before.block };

      // A host hook may itself report spend. Recheck before the actual effect.
      await assertBudget(rt, gen);

      const actual = before && "input" in before ? before.input : input;
      const callKey = await opaqueKey("tool-call", facts.runId, facts.threadId, options.toolCallId);

      const tc = {
        ...hc,
        toolCallId: callKey,
        nativeToolCallId: options.toolCallId,
        meter: scopedMeter(backend, callKey),
      };

      // Plain AI tools receive options.context; native createTool
      // receives its normal action context plus the managed facts.
      // Preserve native dynamic `this` injection (createTool.ts:315).
      const receiver = {
        ...this,
        ctx: { ...(this as { ctx?: object }).ctx, ...fence.ctx, ...tc },
      };

      const output = await execute.call(receiver, actual, {
        ...options,
        toolCallId: callKey,
        context: tc,
      });

      const reshape = async (output: unknown) => {
        const after = await hook(
          managed.hooks?.afterTool
            ? () => managed.hooks!.afterTool!(hc, { tool: name, input: actual, output })
            : undefined,
        );

        return after && "output" in after ? after.output : output;
      };

      if (output && typeof output === "object" && Symbol.asyncIterator in output) {
        // Preserve native streaming/backpressure; every published
        // value passes redaction before the model can consume it.
        return (async function* () {
          for await (const value of output) yield await reshape(value);
        })();
      }

      return reshape(output);
    },
  } as Tool;
}
