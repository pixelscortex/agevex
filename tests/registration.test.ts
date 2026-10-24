// @vitest-environment edge-runtime
import { it, expect } from "vite-plus/test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { Agent as NativeAgent, mockModel } from "@convex-dev/agent";
import { Agent, registerAgent } from "../src/client/index.js";
import { components, internal } from "./setup.js";
import { main, researcher } from "./host.js";

const coordinator = () =>
  makeFunctionReference<"mutation">("agents:coordinate") as unknown as FunctionReference<
    "mutation",
    "internal"
  >;
const policy = {
  refs: {
    runTurn: () => internal.agents.runTurn,
    coordinate: coordinator,
  },
  authorize: async () => ({ subject: "test" }),
  authorizeExecution: async () => {},
};
const child = new Agent(components.agent, {
  name: "Child",
  languageModel: mockModel(),
  subagents: [],
});
const grandchild = new Agent(components.agent, {
  name: "Grandchild",
  languageModel: mockModel(),
  subagents: [],
});

it("is genuinely additive to the native Agent", () => {
  expect(main).toBeInstanceOf(NativeAgent);
  expect(researcher).toBeInstanceOf(NativeAgent);
});

it("registers a Main -> Researcher graph and rejects an unusable one", () => {
  // A shared child definition is resolved through the root's `subagents` and
  // does not have to be a public root itself.
  const runtime = registerAgent(components.agevex, { ...policy, agents: [main] });
  expect(Object.keys(runtime.internalFunctions()).sort()).toEqual(["coordinate", "runTurn"]);
  expect(Object.keys(runtime.authorizedEndpoints()).sort()).toEqual([
    "activity",
    "cancel", // Phase 1a adds root-only cancellation.
    "delegations",
    "messages",
    "open",
    "send",
  ]);
  expect(() => registerAgent(components.agevex, { ...policy, agents: [main, main] })).toThrow(
    "DUPLICATE_AGENT_NAME",
  );
});

it("registering the same Agent object as both a root and a child throws ROOT_AS_CHILD", () => {
  const parent = new Agent(components.agent, {
    name: "Parent",
    languageModel: mockModel(),
    subagents: [child],
  });
  expect(() => registerAgent(components.agevex, { ...policy, agents: [parent, child] })).toThrow(
    "ROOT_AS_CHILD",
  );
});

it("rejects an invalid delegation graph instead of pretending collaboration exists", () => {
  const parent = new Agent(components.agent, {
    name: "Parent",
    languageModel: mockModel(),
    subagents: [child],
  });
  const deep = new Agent(components.agent, {
    name: "Deep",
    languageModel: mockModel(),
    subagents: [
      new Agent(components.agent, {
        name: "Middle",
        languageModel: mockModel(),
        subagents: [grandchild],
      }),
    ],
  });
  // Collaboration without a coordinator reference.
  expect(() =>
    registerAgent(components.agevex, {
      ...policy,
      refs: { runTurn: policy.refs.runTurn },
      agents: [parent],
    }),
  ).toThrow("COORDINATE_REF_REQUIRED");
  // Depth greater than 1.
  expect(() => registerAgent(components.agevex, { ...policy, agents: [deep] })).toThrow(
    "SUBAGENT_DEPTH",
  );
  // A name-only entry is not an executable agent.
  const nameOnly = new Agent(components.agent, {
    name: "NameOnly",
    languageModel: mockModel(),
    subagents: [{ name: "Researcher" } as never],
  });
  expect(() => registerAgent(components.agevex, { ...policy, agents: [nameOnly] })).toThrow(
    "UNKNOWN_SUBAGENT",
  );
  // The same child name bound to two different objects.
  const otherChild = new Agent(components.agent, {
    name: "Child",
    languageModel: mockModel(),
    subagents: [],
  });
  const conflicting = new Agent(components.agent, {
    name: "Conflicting",
    languageModel: mockModel(),
    subagents: [child, otherChild],
  });
  expect(() => registerAgent(components.agevex, { ...policy, agents: [conflicting] })).toThrow(
    "DUPLICATE_AGENT_NAME",
  );
  // A root is also declared as somebody's child.
  const hostRoot = new Agent(components.agent, {
    name: "HostRoot",
    languageModel: mockModel(),
    subagents: [],
  });
  const impostor = new Agent(components.agent, {
    name: "HostRoot",
    languageModel: mockModel(),
    subagents: [],
  });
  const parentOfHostRoot = new Agent(components.agent, {
    name: "ParentOfHostRoot",
    languageModel: mockModel(),
    subagents: [impostor],
  });
  expect(() =>
    registerAgent(components.agevex, { ...policy, agents: [parentOfHostRoot, hostRoot] }),
  ).toThrow("ROOT_AS_CHILD");
  // A self-referencing declaration is a cycle, not a graph.
  const looping = new Agent(components.agent, {
    name: "Looping",
    languageModel: mockModel(),
    subagents: [],
  });
  (looping as unknown as { subagents: unknown[] }).subagents = [looping];
  expect(() => registerAgent(components.agevex, { ...policy, agents: [looping] })).toThrow(
    "SUBAGENT_CYCLE",
  );
  // A host tool may not impersonate the reserved delegation tool.
  const reserved = new Agent(components.agent, {
    name: "Reserved",
    languageModel: mockModel(),
    tools: { agevex_delegate: {} as never },
    subagents: [],
  });
  expect(() => registerAgent(components.agevex, { ...policy, agents: [reserved] })).toThrow(
    "RESERVED_TOOL_NAME",
  );
});
