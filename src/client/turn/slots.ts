// How the optional host slots take part in one turn.
//
// usage: `recordStepUsage` reports provider completion, including dropped saves.
// sandbox tools: `slotToolBags` asks each slot for its tools.
// telemetry: `telemetryIntegrations` per generation, `flushTelemetry` per action.
// Every slot is fail-open for evidence (usage, telemetry) and never retries paid
// work. Called from `turn/generation.ts`, `turn/tools.ts`, `turn/fence.ts` and
// `turn/run-turn.ts`.

import type { ToolSet } from "ai";
import { LIMITS } from "../../component/limits.js";
import { opaqueKey } from "../keys.js";
import type { RuntimeContext } from "../registration/context.js";
import type { SlotFacts, UsageEvent } from "../slots.js";
import type { HookContext, Registration } from "../types.js";
import { sliceKey, type Generation, type Turn } from "./context.js";
import { markUsagePartial, deliverStepUsage } from "./usage.js";
import { settleUsageSave } from "./step-usage.js";

/** Report exactly one provider completion after its save succeeds or fails.
 * Preserve the existing native key; a dropped save uses the unique slice id in
 * its place. Retries reuse this one event, including its original timestamp. */
export async function recordStepUsage(rt: RuntimeContext, gen: Generation, failed: boolean) {
  const { turn, fence } = gen;

  if (!rt.config.usage || !gen.state.modelStarted) return;

  const step = turn.stepUsage;

  if (!step) {
    await markUsagePartial(rt, turn);

    return;
  }

  try {
    await settleUsageSave(turn, fence);

    const requestId = step.providerMetadata?.agevex?.requestId;

    const event: UsageEvent = {
      ...turn.facts,
      purpose: "agent",
      model: step.model,
      provider: step.provider,
      key: await opaqueKey(
        "model",
        turn.facts.threadId,
        step.native?._id ?? sliceKey(turn),
        step.native?.stepOrder ?? 0,
      ),
      messageId: step.native ? String(step.native._id) : null,
      status: fence.controller.signal.aborted ? "aborted" : failed ? "failed" : step.status,
      occurredAt: step.occurredAt,
      usage: step.usage,
      providerMetadata: step.providerMetadata,
      ...(typeof requestId === "string" ? { requestId } : {}),
    };

    await deliverStepUsage(rt.config.usage, turn, fence, event);
  } catch {
    await markUsagePartial(rt, turn);
  }
}

/**
 * Tool bags the configured slots contribute to this turn: sandbox tools only
 * for agents that opted in. Each
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
