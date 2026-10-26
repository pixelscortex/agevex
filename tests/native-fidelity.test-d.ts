import { Agent as NativeAgent, mockModel } from "@convex-dev/agent";
import { tool } from "ai";
import { z } from "zod";
import { Agent, registerAgent } from "../src/client/index.js";
import type { ComponentApi } from "../src/component/_generated/component.js";
import type { Registration } from "../src/client/types.js";
import type { AgentComponent } from "@convex-dev/agent";

declare const component: AgentComponent;

const tools = {
  echo: tool({ inputSchema: z.object({ text: z.string() }), execute: ({ text }) => text }),
};

declare const native: NativeAgent<object, typeof tools>;

const additive = new Agent(component, {
  name: "additive",
  languageModel: mockModel(),
  tools,
  subagents: [],
});

const custom = new Agent<{ organization: string }, typeof tools>(component, {
  name: "custom",
  languageModel: mockModel(),
  tools,
  subagents: [],
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type GenerateFidelity = Assert<
  Equal<typeof native.generateText, typeof additive.generateText>
>;
export type StreamFidelity = Assert<Equal<typeof native.streamText, typeof additive.streamText>>;
export type ContinueFidelity = Assert<
  Equal<typeof native.continueThread, typeof additive.continueThread>
>;
export type CustomFidelity = Assert<
  Equal<typeof custom.streamText, NativeAgent<{ organization: string }, typeof tools>["streamText"]>
>;
// @ts-expect-error A host action context cannot manufacture required custom context.
const unsupported: Agent<object> = custom;

void unsupported;
declare const agevex: ComponentApi;
declare const policy: Omit<Registration, "agents">;
registerAgent(agevex, { ...policy, agents: [additive] });
// @ts-expect-error Managed turns cannot synthesize organization context.
registerAgent(agevex, { ...policy, agents: [custom] });

const gateway = new Agent(component, {
  name: "gateway",
  languageModel: "openai/gpt-4o",
  subagents: [],
});

void gateway;
export type DefaultGenerateFidelity = Assert<
  Equal<NativeAgent["generateText"], typeof gateway.generateText>
>;
export type DefaultStreamFidelity = Assert<
  Equal<NativeAgent["streamText"], typeof gateway.streamText>
>;
