import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { register } from "../../src/meter/test.js";
import {
  defineMeter,
  inline,
  type ComponentApi,
  type Meter,
  type MeterOptions,
} from "../../src/meter/index.js";
import schema from "./fixture/schema.js";

const modules = import.meta.glob("./fixture/**/*.ts");
export const allBreakdowns: NonNullable<MeterOptions["breakdowns"]> = [
  "thread.model",
  "thread.provider",
  "subject.agent",
  "subject.model",
  "subject.provider",
];
type HostFunctions = ReturnType<Meter["internalFunctions"]>;
/** `host` may replace the exported workers, e.g. to make a job crash. */
export function setup(
  overrides: Partial<MeterOptions> = {},
  host: (functions: HostFunctions, component: ReturnType<typeof register>) => object = (
    functions,
  ) => functions,
) {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...modules,
      "./fixture/host.ts": async (): Promise<object> => host(meter.internalFunctions(), component),
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
  // Name the component type: inferring it would print the private Exposed alias.
  return { t, meter, component: component as ComponentApi };
}
export const attribution = {
  subject: "owner",
  rootThreadId: "root",
  threadId: "child",
  runId: "run",
  agent: "Builder",
  model: "model",
};
