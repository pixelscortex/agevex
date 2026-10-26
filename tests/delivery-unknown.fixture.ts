/** Fail chosen delivery writes of the real component, to model a database that rejects them. */
import { mutationGeneric } from "convex/server";
import agevex from "../src/test.js";
import { type Test, api, owner, rawAssignment, components } from "./message-parent.fixture.js";

type DeliveryArgs = {
  runId: string;
  deliveryToken: string;
  deliveryStatus?: string;
  errorCode?: string | null;
  unknown?: boolean;
};
type Handler = { _handler: (ctx: unknown, args: DeliveryArgs) => Promise<unknown> };

/** Which delivery write a call is: the accepted attempt, the `DELIVERY_FAILED`
 * record of the direct path (`deliver`), the `DELIVERY_FAILED` record of the
 * scheduled notify path (`failDelivery`), or a `DELIVERY_UNKNOWN` record from
 * either path. */
export type DeliveryWrite = "accepted" | "failed" | "failDelivery" | "unknown";

/** Refuse every delivery write whose kind the test did not allow. A refused
 * accepted write rolls its native parent save back with it, as a real failure
 * would. `writes` counts every call, refused or not, outside persisted state. */
export function breakDelivery(t: Test) {
  const fault = {
    allowed: new Set<DeliveryWrite>(),
    writes: { accepted: 0, failed: 0, failDelivery: 0, unknown: 0 } satisfies Record<
      DeliveryWrite,
      number
    >,
  };

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/subagents/deliver.ts": async () => {
      const real = (await agevex.modules["./component/subagents/deliver.ts"]()) as Record<
        string,
        Handler
      >;

      const wrap = (name: "deliver" | "failDelivery") =>
        mutationGeneric({
          handler: async (ctx, raw) => {
            const args = raw as DeliveryArgs;

            const kind: DeliveryWrite =
              args.deliveryStatus === "accepted"
                ? "accepted"
                : args.errorCode === "DELIVERY_UNKNOWN" || args.unknown
                  ? "unknown"
                  : name === "failDelivery"
                    ? "failDelivery"
                    : "failed";

            fault.writes[kind]++;

            if (!fault.allowed.has(kind)) throw new Error("injected delivery write failure");

            return (await real[name]._handler(ctx, args)) as never;
          },
        });

      return { ...real, deliver: wrap("deliver"), failDelivery: wrap("failDelivery") };
    },
  });

  return fault;
}

/** Send a fresh request and claim its turn, so its launches face the result guard. */
export async function claimNextRequest(
  t: Test,
  receipt: { assignmentId: string; threadId: string },
  requestKey: string,
) {
  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "fresh request",
    requestKey,
  });

  const row = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;
  const actor = { assignmentId: row._id, turnToken: row.turnToken! };

  await t.mutation(components.agevex.turns.slices.claim, actor);

  return actor;
}
