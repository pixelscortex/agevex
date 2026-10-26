/** Stored delegation protocol facts for pre-existing coordination tests.
 * Public tree projections are covered separately in run-tree.test.ts.
 */
import { componentsGeneric, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { ApiFromModules } from "convex/server";
import type * as bridge from "../src/testing/bridge.js";
import type { TestConvex } from "convex-test";
import type schema from "./fixture/schema.js";

type Ref = ApiFromModules<{ bridge: typeof bridge }>["bridge"]["delegationState"];

const ref = componentsGeneric().agevex.agevexTest.delegationState as unknown as FunctionReference<
  "query",
  "internal",
  { threadId: string },
  FunctionReturnType<Ref>
>;

export const delegationState = (t: TestConvex<typeof schema>, threadId: string) =>
  t.query(ref, { threadId });
