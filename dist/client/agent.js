// The managed `Agent` class hosts construct their agents with.
//
// It is the native `@convex-dev/agent` Agent plus the metadata the managed
// runtime reads at registration: a name, declared tools, `subagents`,
// `sideAgents`, `hooks` and the sandbox opt-in. Generation, tools, threads and
// streams stay entirely native. `registerAgent` (`registration/graph.ts`)
// validates the graph these fields describe. Touches no tables.
import { Agent as NativeAgent } from "@convex-dev/agent";
// Equivalent supported constructor inputs, without the upstream intersection of
// two enormous gateway-model unions (TS2590 on TypeScript 5.9). Only the
// constructor signature is normalized; the instance type is entirely native.
const NativeBase = NativeAgent;
/** Shared empty tool bag, so a tool-less agent costs no per-instance allocation. */
const EMPTY_TOOLS = {};
/** Native Agent plus metadata; generation, tools, threads and streams stay native. */
export class Agent extends NativeBase {
    name;
    run;
    sandbox;
    subagents;
    hooks;
    sideAgents;
    /**
     * Native tools declared on this agent, kept so the managed runtime can merge
     * its reserved delegation tool with them. Inherited native behavior is
     * unchanged: a managed turn passes the merged set per call, exactly as the
     * native `streamText` `tools` override already allows.
     */
    declaredTools;
    constructor(component, options) {
        super(component, options);
        this.name = options.name;
        this.run = options.run;
        this.sandbox = options.sandbox ?? false;
        this.subagents = options.subagents ?? [];
        this.hooks = options.hooks;
        this.sideAgents = options.sideAgents ?? [];
        this.declaredTools = options.tools ?? EMPTY_TOOLS;
    }
}
