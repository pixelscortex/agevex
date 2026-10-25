import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vite-plus/test";
import { langfuse, telemetry } from "../../../src/telemetry/index.js";
import { facts, scripted } from "../script.js";

// Only this file is consulted; shell credentials cannot accidentally enable a live
// export. Never print the file, credentials, request headers or response bodies.
let contents = "";

try {
  contents = await readFile("/Volumes/mypixel/pxc/agevex/.env.local", "utf8");
} catch {
  /* Missing keys skip below. */
}

const entries = Object.fromEntries(
  contents.split(/\r?\n/).flatMap((line) => {
    const match =
      /^\s*(?:export\s+)?(LANGFUSE_(?:PUBLIC_KEY|SECRET_KEY|BASE_URL))\s*=\s*(.*?)\s*$/.exec(line);

    if (!match) return [];

    return [[match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]];
  }),
);

const enabled = !!(
  entries.LANGFUSE_PUBLIC_KEY &&
  entries.LANGFUSE_SECRET_KEY &&
  entries.LANGFUSE_BASE_URL
);

if (!enabled)
  console.info(
    "Telemetry live skipped: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are required in .env.local.",
  );

it.skipIf(!enabled)(
  "live Langfuse accepts OTLP (requires LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL in main .env.local)",
  async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let accepted = false;

    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests++;
      const response = await originalFetch(input, init);

      accepted = response.ok;

      return response;
    });

    try {
      const observer = telemetry({
        exporters: [
          langfuse({
            baseUrl: entries.LANGFUSE_BASE_URL,
            publicKey: entries.LANGFUSE_PUBLIC_KEY,
            secretKey: entries.LANGFUSE_SECRET_KEY,
          }),
        ],
      });

      await scripted(
        observer.integration({ ...facts, runId: "telemetry-live", turnKey: crypto.randomUUID() }),
      );

      await observer.flush();
      expect(requests).toBe(1);
      expect(accepted).toBe(true);

      console.info(
        "Telemetry live: Langfuse accepted one OTLP batch; model=scripted-model; synthetic input/output tokens=14/6; paid model calls=0; credits=0.",
      );
    } finally {
      transport.mockRestore();
    }
  },
  10_000,
);
