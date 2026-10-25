import { Agent as NativeAgent, type AgentComponent, type Config } from "@convex-dev/agent";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Instructions, LanguageModel, StopCondition, ToolSet } from "ai";
import type { AgentHooks, SideAgent, ManagedAgent } from "./types.js";

// Replace the native model property before restating it: intersecting the two
// gateway id unions exceeds TypeScript's representable union size as the model
// catalog grows. This preserves every other native configuration option.
type AgentOptions<Tools extends ToolSet> = Omit<Config, "languageModel"> & {
  name: string;
  languageModel: Extract<LanguageModel, string | LanguageModelV4>;
  instructions?: Instructions;
  tools?: Tools;
  stopWhen?: StopCondition<NoInfer<Tools>> | StopCondition<NoInfer<Tools>>[];
  /**
   * Agents this one may delegate to through the managed `agevex_delegate` tool.
   * Must be real `Agent` objects, not names: `registerAgent` resolves the
   * executable child through this list. Registration allows up to two edges
   * from each root (or one when limits.maxDepth is lowered).
   */
  subagents?: readonly ManagedAgent[];
  sandbox?: boolean;
  hooks?: AgentHooks;
  sideAgents?: readonly SideAgent[];
};

// Equivalent supported constructor inputs, without the upstream intersection of
// two enormous gateway-model unions (TS2590 on TypeScript 5.9). Only the
// constructor signature is normalized; the instance type is entirely native.
const NativeBase = NativeAgent as unknown as {
  new <CustomCtx extends object, Tools extends ToolSet>(
    component: AgentComponent,
    options: AgentOptions<Tools>,
  ): NativeAgent<CustomCtx, Tools>;
};

/** Shared empty tool bag, so a tool-less agent costs no per-instance allocation. */
const EMPTY_TOOLS: ToolSet = {};

/** Native Agent plus metadata; generation, tools, threads and streams stay native. */
export class Agent<
  CustomCtx extends object = object,
  // Match the upstream generic default exactly, including no-tools return types.
  AgentTools extends ToolSet = any,
> extends NativeBase<CustomCtx, AgentTools> {
  /** Type-only marker: managed registration cannot supply required custom context. */
  declare readonly _agevexContext: (ctx: CustomCtx) => void;
  readonly name: string;
  readonly sandbox: boolean;
  readonly subagents: readonly ManagedAgent[];
  readonly hooks?: AgentHooks;
  readonly sideAgents: readonly SideAgent[];
  /**
   * Native tools declared on this agent, kept so the managed runtime can merge
   * its reserved delegation tool with them. Inherited native behavior is
   * unchanged: a managed turn passes the merged set per call, exactly as the
   * native `streamText` `tools` override already allows.
   */
  readonly declaredTools: ToolSet;

  constructor(component: AgentComponent, options: AgentOptions<AgentTools>) {
    super(component, options);
    this.name = options.name;
    this.sandbox = options.sandbox ?? false;
    this.subagents = options.subagents ?? [];
    this.hooks = options.hooks;
    this.sideAgents = options.sideAgents ?? [];
    this.declaredTools = options.tools ?? EMPTY_TOOLS;
  }
}
