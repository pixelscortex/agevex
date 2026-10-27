// The tool set one generation runs with.
//
// `buildTurnTools` merges the agent's declared tools with the slot tool bags
// (rejecting collisions and reserved names), binds every tool to the turn's
// receipts ledger and fence (`bindOnceTool`), wraps every executable tool in the
// `beforeTool` / `afterTool` hooks, and finally installs the managed
// collaboration tools (`collaboration-tools.ts`), which are deliberately not
// wrapped by the generic tool hooks.

import type { Tool, ToolExecutionOptions, ToolSet } from "ai";
import { fingerprint } from "../keys.js";
import { opaqueKey } from "../keys.js";
import { bindOnceTool } from "../once.js";
import type { RuntimeContext } from "../registration/context.js";
import { RESERVED_TOOL_NAMES } from "../tool-names.js";
import { installCollaborationTools } from "./collaboration-tools.js";
import { boundToolDeadlines } from "./deadlines.js";
import type { Generation } from "./context.js";
import { slotToolBags } from "./slots.js";
import { assertBudget } from "./admission.js";
import { startToolProgress } from "./tool-progress.js";
import { askUserMarker } from "../../shared/tool-markers.js";

/** Build the complete tool set for one generation. */
export async function buildTurnTools(rt: RuntimeContext, gen: Generation): Promise<ToolSet> {
  const { turn, hc } = gen;
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

  if (!(claimed.settings.askUser ?? !claimed.subagent))
    for (const [name, tool] of Object.entries(tools))
      if (askUserMarker(tool))
        tools[name] = {
          ...tool,
          execute: async () => ({ status: "denied", code: "ROOT_ONLY" }),
        };

  installCollaborationTools(rt, gen, tools, eligible);

  for (const [name, tool] of Object.entries(tools))
    if (tool.execute) tools[name] = withToolProgress(rt, gen, name, tool);

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
 * tool yields. The tool receives an opaque per-call key.
 */
function withToolHooks(rt: RuntimeContext, gen: Generation, name: string, declared: Tool): Tool {
  const { turn, hc, hook, fence } = gen;
  const { managed, facts } = turn;
  const execute = declared.execute!;

  return {
    ...declared,
    execute: async function (input: unknown, options: ToolExecutionOptions<any>) {
      const approved = (await turn.rawCtx.runQuery(rt.component.turns.decision_reads.effective, {
        assignmentId: turn.args.assignmentId,
        toolCallId: options.toolCallId,
      })) as ApprovedInput | null;

      // Hooks receive a copy: in-place mutation must not mutate the immutable audit input.
      if (approved?.edited) input = JSON.parse(JSON.stringify(approved.input));

      // Plain approvals retain native parsed values, including non-JSON schema
      // transforms. Snapshot their fingerprint before hooks can mutate input.
      const approvedHash = approved ? await fingerprint(input) : undefined;

      const before = await hook(
        managed.hooks?.beforeTool
          ? () => managed.hooks!.beforeTool!(hc, { tool: name, input })
          : undefined,
      );

      if (before?.block) return { status: "denied", code: "HOOK_BLOCKED", reason: before.block };

      // The outer deadline wrapper checked budget once before this hook.
      const actual = before && "input" in before ? before.input : input;

      if (approved && (await fingerprint(actual)) !== approvedHash)
        return { status: "denied", code: "APPROVED_INPUT_CHANGED" };

      const callKey = await opaqueKey("tool-call", facts.runId, facts.threadId, options.toolCallId);

      const tc = {
        ...hc,
        toolCallId: callKey,
        nativeToolCallId: options.toolCallId,
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

        const result = after && "output" in after ? after.output : output;

        return approved?.edited ? { result, approval: approved } : result;
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

/** Receipt-backed audit annotation accompanying edited native tool results. */
type ApprovedInput = {
  input: unknown;
  toolCallId: string;
  originalHash: string;
  effectiveHash: string;
  edited: boolean;
};

/** Native Agent preserves our execute receiver (vercel/client/createTool.ts:378).
 * Mark all local calls, including collaboration, without exposing their inputs.
 * A stream stays active through consumption, cancellation or its final yield.
 */
export function withToolProgress(
  rt: RuntimeContext,
  gen: Generation,
  name: string,
  tool: Tool,
): Tool {
  return {
    ...tool,
    execute: async function (input, options) {
      const clear = startToolProgress(rt, gen.turn, name, options.toolCallId);

      let streaming = false;

      try {
        const output = await tool.execute!.call(this, input, options);

        if (output && typeof output === "object" && Symbol.asyncIterator in output) {
          streaming = true;

          return progressStream(output as AsyncIterable<unknown>, clear);
        }

        return output;
      } finally {
        if (!streaming) clear();
      }
    },
  } as Tool;
}

/** Async-generator finally handles both normal exhaustion and consumer return. */
async function* progressStream(output: AsyncIterable<unknown>, clear: () => void) {
  try {
    yield* output;
  } finally {
    clear();
  }
}
