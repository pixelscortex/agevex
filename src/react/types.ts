// Browser contracts derive from host exports; no component handles enter React.
import type { ApiFromModules } from "convex/server";
import type { authorizedEndpoints } from "../client/endpoints/index.js";

export type QueryState<T> = {
  status: "skipped" | "loading" | "ready";
  data?: T;
};
type Endpoints = ReturnType<typeof authorizedEndpoints>;
export type AgevexApi = Partial<ApiFromModules<{ endpoints: Endpoints }>["endpoints"]>;

/** Fail at the hook that needs an omitted endpoint, rather than at factory creation. */
export function required<K extends keyof AgevexApi>(api: AgevexApi, key: K) {
  const ref = api[key];

  if (!ref)
    throw new Error(`agevex/react: export the authorized '${key}' endpoint to use this hook`);

  return ref;
}

/** Missing input always wins over cached data, including a previously selected thread. */
export function queryState<T>(threadId: string | undefined, data: T | undefined): QueryState<T> {
  if (threadId === undefined) return { status: "skipped" };

  return data === undefined ? { status: "loading" } : { status: "ready", data };
}

export function threadRequired(threadId: string | undefined): string {
  if (threadId === undefined) throw new Error("agevex/react: select a thread before writing");

  return threadId;
}
