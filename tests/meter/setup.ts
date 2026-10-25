import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { register } from "../../src/meter/test.js";
import { defineMeter, inline, type MeterOptions } from "../../src/meter/index.js";
import schema from "./fixture/schema.js";

const modules = import.meta.glob("./fixture/**/*.ts");
export const allBreakdowns: NonNullable<MeterOptions["breakdowns"]> = [
  "thread.model",
  "thread.provider",
  "subject.agent",
  "subject.model",
  "subject.provider",
];
export function setup(overrides: Partial<MeterOptions> = {}) {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...modules,
      "./fixture/host.ts": async () => meter.internalFunctions(),
    },
  });
  const component = register(t);
  const meter = defineMeter(component, {
    providers: {
      openrouter: inline(),
      fal: { profiles: { image: { unit: "image", usd: 0.25 } } },
      firecrawl: { credits: { usdPerCredit: 0.001 } },
    },
    workers: {
      lookup: makeFunctionReference("host:meterLookup") as unknown as FunctionReference<
        "action",
        "internal"
      >,
      deliver: makeFunctionReference("host:meterDeliver") as unknown as FunctionReference<
        "action",
        "internal"
      >,
    },
    ...overrides,
  });
  return { t, meter, component };
}
export const attribution = {
  subject: "owner",
  rootThreadId: "root",
  threadId: "child",
  runId: "run",
  agent: "Builder",
  model: "model",
};
