/// <reference types="vite/client" />
import { beforeEach } from "vite-plus/test";

// `tests/tsconfig.json` types only `vite/client`, so the Node global `process`
// is declared here exactly as the Convex backend declares it. Vitest and the
// Convex test runtime both supply a real `process.env` at run time.
declare const process: { env: Record<string, string | undefined> };

/**
 * Names of the two backend-only environment entries a host's own provider
 * configuration conventionally reads, spelled out here as literals on purpose.
 *
 * This module is loaded by Vitest before any test file, and it exists to keep
 * the deterministic tests from ever seeing an inherited provider configuration.
 * This package ships no provider configuration of its own, so the literals are
 * not duplicated from anything here: they are cleared so that a mode or key
 * inherited from the developer's shell cannot silently shape a test run.
 */
export const UNIT_TEST_MODE_ENV = "AGEVEX_MODEL_MODE";
export const UNIT_TEST_KEY_ENV = "OPENROUTER_API_KEY";

/** Marker every denied outbound fetch rejects with. */
export const UNIT_TEST_FETCH_DENIED = "UNIT_TEST_OUTBOUND_FETCH_DENIED";

/**
 * Restores the deterministic no-provider baseline.
 *
 * A mode or key inherited from the developer's shell is cleared before the
 * first assertion runs, so no test can be shaped by the environment it happens
 * to run in and no inherited credential is even readable from a unit test.
 */
function restoreSafeBaseline() {
  process.env[UNIT_TEST_MODE_ENV] = "demo";
  delete process.env[UNIT_TEST_KEY_ENV];
}

/**
 * Refuses every outbound request.
 *
 * Unit tests are deterministic and offline: a provider call is always a test
 * defect, and a live one would be paid for. Replacing the global `fetch` closes
 * that door for every environment, including the ones where a test restores
 * mocks or stubs `process.env` back to its inherited values.
 */
function denyOutboundFetch(): Promise<never> {
  return Promise.reject(new Error(UNIT_TEST_FETCH_DENIED));
}

function installGlobalFetchDenial() {
  Object.defineProperty(globalThis, "fetch", {
    value: denyOutboundFetch,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

restoreSafeBaseline();
installGlobalFetchDenial();

// Re-asserted per test so a suite that restores mocks, globals or the
// environment cannot leave the next test with a paid path back open.
beforeEach(() => {
  restoreSafeBaseline();
  installGlobalFetchDenial();
});
