// Public entry point of the `agevex` package (`.` export).
//
// Re-exports the managed `Agent`, `registerAgent`, the reserved tool names, the
// slot contracts, `defineOnceTool`, structured tasks and the public types. The
// implementation is organised by concept; see `client/README.md` for the map.

export type { RunSettings, ResolvedRunSettings } from "../component/run-settings.js";
export { Agent } from "./agent.js";
export {
  DELEGATE_TOOL_NAME,
  MESSAGE_CHILD_TOOL_NAME,
  ASK_PARENT_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
  registerAgent,
} from "./runtime.js";
export type {
  HookContext,
  HookResult,
  AgentHooks,
  SideAgent,
  Activity,
  Receipt,
  Registration,
  AuthorizationScope,
  ExecutionScope,
  CoordinateArgs,
  CoordinateResult,
  DelegationResult,
  DelegationDenialCode,
  TurnArgs,
  TurnOrigin,
  ManagedAgent,
  AgentEvent,
  ObserveAgentEvent,
} from "./types.js";

export { LIMITS, PLATFORM } from "../component/limits.js";
export type { Limits } from "../component/limits.js";
export { defineOnceTool } from "./once.js";
export type { NoteArgs } from "./host/notes.js";
export type { ToolContext, ScopedMeter, MeterCharge } from "./once.js";

export type { OriginMessage } from "./endpoints/index.js";
export type {
  SlotFacts,
  SlotActionCtx,
  ChargeCost,
  UsageSlot,
  UsageView,
  UsageViewArgs,
  UsageProjection,
  BudgetSlot,
  TelemetrySlot,
  SandboxSlot,
  ExtractSlot,
  MeterBackend,
  MeterChargeBackend,
} from "./slots.js";
export type { SandboxCompletion } from "./runtime.js";
export { defineTask, runTask } from "./tasks.js";
export type { Task, TaskOptions, TaskOutcome } from "./tasks.js";

export type { ThreadTextOptions, TextTaskOptions, TextTaskArgs } from "./text/options.js";

export {
  assertFormSchema,
  validateAnswer,
  type JsonSchema,
  type Decision,
} from "../shared/decisions.js";
