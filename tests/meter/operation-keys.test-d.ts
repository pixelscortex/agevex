import type { ChargeHandle } from "../../src/modules/meter/client/index.js";

declare const charge: ChargeHandle;
// @ts-expect-error Corrections need a stable operation key, even without a revision.
void charge.correct({ quantity: 3 });
// @ts-expect-error Attachment needs its own stable operation key.
void charge.attach({ requestId: "request" });
// @ts-expect-error USD settlement needs a stable operation key.
void charge.settle({ usd: 0.5 });
// @ts-expect-error Credit settlement needs a stable operation key too.
void charge.settle({ credits: 3 });
// @ts-expect-error An observed revision cannot replace a stable operation key.
void charge.correct({ quantity: 3, revision: 0 });
// @ts-expect-error Revisions describe outcomes and are no longer correction inputs.
void charge.correct({ quantity: 3, key: "correct", revision: 0 });
void charge.correct({ quantity: 3, key: "correct" });
void charge.attach({ requestId: "request", key: "attach" });
void charge.settle({ usd: 0.5, key: "settle-usd" });
void charge.settle({ credits: 3, key: "settle-credits" });
