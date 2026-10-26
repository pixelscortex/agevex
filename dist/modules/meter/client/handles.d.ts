import type { ChargeHandle, Provider } from "./types.js";
import type { MeterBinding } from "./scope.js";
/** `provider` is undefined for an unregistered name: the charge exists as
 * `unknown`, and only a USD settlement can resolve it. */
export declare function chargeHandle({ meter, ctx, guard }: MeterBinding, key: string, provider: Provider | undefined): ChargeHandle;
