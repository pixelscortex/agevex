// Typed view of the fixture app's API.
//
// The runtime values come from the fixture's copied `_generated/api.js`, exactly
// as a real Convex host app resolves `api`, `internal` and `components`. The
// types are derived from the deterministic test registration in `tests/host.ts`,
// so a reference and the function it addresses cannot drift apart.
//
// `tests/host.ts` imports `components` from here and this module imports the
// registration's types from there. The import below is type-only, so it is
// erased at runtime and the two modules do not form a runtime cycle.

import type {
  FunctionReference,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import type { ComponentApi as AgentComponentApi } from "@convex-dev/agent/_generated/component.js";
import type { ComponentApi } from "../../src/component/_generated/component.js";
import type {
  activity,
  cancel,
  coordinate,
  delegations,
  messages,
  streams,
  open,
  runTurn,
  send,
  respond,
  answer,
} from "../host.js";
import type * as promoted from "./promoted.js";
import {
  api as generatedApi,
  components as generatedComponents,
  internal as generatedInternal,
} from "./_generated/api.js";

/** A registered Convex function, addressed as a typed function reference. */
type UndefinedToNull<T> = undefined extends T ? null : T;

/**
 * The reference type of one registered function, derived from the
 * registration itself.
 *
 * This mirrors the reference shape the Convex CLI generates for a host app:
 * the visibility, the argument object and the return type come from the
 * registration, so a reference and the function it addresses cannot drift.
 */
type ReferenceOf<Export> =
  Export extends RegisteredQuery<infer Visibility, infer Args, infer Returns>
    ? FunctionReference<"query", Visibility, Args, UndefinedToNull<Awaited<Returns>>>
    : Export extends RegisteredMutation<infer Visibility, infer Args, infer Returns>
      ? FunctionReference<"mutation", Visibility, Args, UndefinedToNull<Awaited<Returns>>>
      : Export extends RegisteredAction<infer Visibility, infer Args, infer Returns>
        ? FunctionReference<"action", Visibility, Args, UndefinedToNull<Awaited<Returns>>>
        : never;

export const api = generatedApi as unknown as {
  agents: {
    open: ReferenceOf<typeof open>;
    send: ReferenceOf<typeof send>;
    respond: ReferenceOf<typeof respond>;
    answer: ReferenceOf<typeof answer>;
    cancel: ReferenceOf<typeof cancel>;
    messages: ReferenceOf<typeof messages>;
    streams: ReferenceOf<typeof streams>;
    activity: ReferenceOf<typeof activity>;
    delegations: ReferenceOf<typeof delegations>;
  };
  promoted: {
    open: ReferenceOf<typeof promoted.open>;
    send: ReferenceOf<typeof promoted.send>;
    messages: ReferenceOf<typeof promoted.messages>;
    activity: ReferenceOf<typeof promoted.activity>;
  };
};

export const internal = generatedInternal as unknown as {
  agents: {
    runTurn: ReferenceOf<typeof runTurn>;
    coordinate: ReferenceOf<typeof coordinate>;
  };
};

export const components = generatedComponents as unknown as {
  agent: AgentComponentApi<"agent">;
  agevex: ComponentApi<"agevex">;
};
