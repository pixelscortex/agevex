// How the optional host slots take part in one turn.
//
// usage: `recordStepUsage` reports the model step a native save just captured.
// extract: `extractAttachedFiles` admits the turn's attachments at turn start.
// sandbox / extract tools: `slotToolBags` asks each slot for its tools.
// telemetry: `telemetryIntegrations` per generation, `flushTelemetry` per action.
// Every slot is fail-open for evidence (usage, telemetry) and never retries paid
// work. Called from `turn/generation.ts`, `turn/tools.ts`, `turn/fence.ts` and
// `turn/run-turn.ts`.

import type { MessageDoc } from "@convex-dev/agent";
import type { ToolSet } from "ai";
import { createFunctionHandle } from "convex/server";
import { LIMITS } from "../../component/limits.js";
import { opaqueKey } from "../keys.js";
import type { RuntimeContext } from "../registration/context.js";
import type { SlotFacts, UsageSlot } from "../slots.js";
import type { HookContext, Registration } from "../types.js";
import { sliceKey, type Turn } from "./context.js";
import type { TurnFence } from "./fence.js";
import { markUsagePartial } from "./usage.js";

/**
 * Report the model step one native message save just captured.
 *
 * Agent 0.7.7 start.ts:382-417 saves step usage with its
 * native result. turns.slices.write returns those committed documents;
 * no transcript discovery is needed.
 * The fenced native save returns the committed document and exact identity;
 * no duplicate step reference or follow-up execution read is needed.
 */
export async function recordStepUsage(
  rt: RuntimeContext,
  turn: Turn,
  usage: UsageSlot,
  saved: unknown,
) {
  const messages = (saved as { messages?: MessageDoc[] } | null)?.messages ?? [];
  const step = messages.find((message) => message.usage && message.status === "success");

  if (!step?.usage) return;

  try {
    const requestId = step.providerMetadata?.agevex?.requestId;

    await usage.record(turn.rawCtx, {
      ...turn.facts,
      purpose: "agent",
      model: step.model,
      provider: step.provider,
      key: await opaqueKey("model", turn.facts.threadId, step._id, step.stepOrder),
      messageId: String(step._id),
      usage: step.usage,
      providerMetadata: step.providerMetadata,
      ...(typeof requestId === "string" ? { requestId } : {}),
    });
  } catch {
    await markUsagePartial(rt, turn);
    // Billing evidence is best effort. Never replay a paid
    // generation because its usage hook was unavailable.
  }
}

/**
 * Admit the turn's attached files to the extract slot, once, at turn start.
 * Admission is the extract module's durable, deduplicated run; core never
 * retries extraction or reads its component state.
 */
export async function extractAttachedFiles(rt: RuntimeContext, turn: Turn, fence: TurnFence) {
  const { claimed, managed } = turn;

  if (!rt.config.extract || !claimed.isTurnStart) return;

  const files = await fence.ctx.runQuery(rt.component.files.attachments.forMessage, {
    messageId: claimed.promptMessageId,
    subject: claimed.subject,
    threadId: claimed.threadId,
    native: await createFunctionHandle(managed.component.files.get),
  });

  for (const fileId of files)
    await rt.config.extract.run(fence.ctx, {
      fileId,
      threadId: claimed.threadId,
      subject: claimed.subject,
    });
}

/**
 * Tool bags the configured slots contribute to this turn: sandbox tools only
 * for agents that opted in, extract tools whenever extract is configured. Each
 * bag gets an opaque per-slice call key.
 */
export async function slotToolBags(
  rt: RuntimeContext,
  turn: Turn,
  hc: HookContext,
): Promise<ToolSet[]> {
  const { config } = rt;
  const bags: ToolSet[] = [];

  if (turn.managed.sandbox && config.sandbox)
    bags.push(config.sandbox.tools({ ...hc, toolCallId: await slotCallKey(turn) }));

  if (config.extract)
    bags.push(config.extract.tools({ ...hc, toolCallId: await slotCallKey(turn) }));

  return bags;
}

function slotCallKey(turn: Turn) {
  return opaqueKey("slot-call", turn.facts.runId, sliceKey(turn));
}

/** Telemetry integrations for one generation; a throwing slot yields none. */
export function telemetryIntegrations(config: Registration, facts: SlotFacts, turnKey: string) {
  try {
    return [config.telemetry!.integration({ ...facts, turnKey })];
  } catch {
    return [];
  }
}

/**
 * Flush telemetry once per `runTurn` action, bounded in time.
 *
 * Race even uncooperative exporters; abort alone cannot bound an
 * arbitrary Promise. One action spends at most three seconds
 * (`LIMITS.telemetryFlushMs`). Export failures never change turn state.
 */
export async function flushTelemetry(config: Registration, facts: SlotFacts, turnKey: string) {
  if (!config.telemetry) return;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.resolve().then(() =>
        config.telemetry!.flush({ ...facts, turnKey }, controller.signal),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve();
        }, LIMITS.telemetryFlushMs);
      }),
    ]);
  } catch {
    /* Export failures never change turn state. */
  } finally {
    clearTimeout(timer);
  }
}
