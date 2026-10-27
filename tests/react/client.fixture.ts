/** An in-memory Convex transport; tests still run the real Convex React hooks. */
import { createElement, type ReactNode } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName, makeFunctionReference, type FunctionReference } from "convex/server";
import type { Value } from "convex/values";
import type { AgevexApi } from "../../src/react/index.js";

type Args = Record<string, Value>;
const ref = (name: string) => makeFunctionReference(`authorized:${name}`);

export const api = Object.fromEntries(
  [
    "messages",
    "streams",
    "send",
    "cancel",
    "runTree",
    "pendingApprovals",
    "respond",
    "answer",
    "title",
    "rename",
  ].map((name) => [name, ref(name)]),
) as AgevexApi;

export function transport(read: (name: string, args: Args) => unknown = () => undefined) {
  const cache = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const active = new Map<string, number>();
  const watched: { name: string; args: Args }[] = [];
  const writes: { name: string; args: Args }[] = [];
  let mutation: (name: string, args: Args) => Promise<unknown> = async () => null;

  const client = {
    watchQuery(query: FunctionReference<"query">, args: Args) {
      const name = getFunctionName(query);
      const key = JSON.stringify([name, args]);

      watched.push({ name, args });

      return {
        localQueryResult() {
          if (!cache.has(key)) cache.set(key, read(name, args));

          const value = cache.get(key);

          if (value instanceof Error) throw value;

          return value;
        },
        journal: () => undefined,
        onUpdate(callback: () => void) {
          listeners.add(callback);
          active.set(key, (active.get(key) ?? 0) + 1);

          return () => {
            listeners.delete(callback);
            const count = active.get(key)! - 1;

            if (count) active.set(key, count);
            else active.delete(key);
          };
        },
      };
    },
    mutation(query: FunctionReference<"mutation">, args: Args) {
      const name = getFunctionName(query);

      writes.push({ name, args });

      return mutation(name, args);
    },
  };

  return {
    watched,
    writes,
    active,
    update: () => {
      cache.clear();
      listeners.forEach((listener) => listener());
    },
    mutate: (fn: typeof mutation) => {
      mutation = fn;
    },
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(ConvexProvider, { client: client as unknown as ConvexReactClient }, children),
  };
}
