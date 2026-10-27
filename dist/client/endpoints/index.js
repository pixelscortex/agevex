// The subject-authorized public endpoints a host exports, built by
// `registerAgent(...).authorizedEndpoints()`.
//
// This file only composes them; each lives with its concept in this folder:
// `access.ts` (shared context and the `ownedThread` gate), `requests.ts` (`open`,
// `send`), `attachments.ts` (file validation for those two), `controls.ts`
// (`respond`, `answer`, `cancel`) and `reads.ts` (`messages`, `streams`,
// `activity`, `runTree`, `delegations`). Every endpoint authorizes through the host
// `authorize` contract before touching component state.
import { createEndpointContext } from "./access.js";
import { pendingApprovalsEndpoint } from "./pending.js";
import { answerEndpoint, cancelEndpoint, respondEndpoint } from "./controls.js";
import { activityEndpoint, delegationsEndpoint, messagesEndpoint, runTreeEndpoint, streamsEndpoint, } from "./reads.js";
import { titleEndpoint, renameEndpoint } from "./text.js";
import { openEndpoint, sendEndpoint } from "./requests.js";
/** Build every public endpoint for one registration. */
export function authorizedEndpoints(component, config, settings) {
    const ep = createEndpointContext(component, config, settings);
    return {
        title: titleEndpoint(ep),
        rename: renameEndpoint(ep),
        open: openEndpoint(ep),
        send: sendEndpoint(ep),
        respond: respondEndpoint(ep),
        pendingApprovals: pendingApprovalsEndpoint(ep),
        answer: answerEndpoint(ep),
        cancel: cancelEndpoint(ep),
        messages: messagesEndpoint(ep),
        streams: streamsEndpoint(ep),
        activity: activityEndpoint(ep),
        runTree: runTreeEndpoint(ep),
        delegations: delegationsEndpoint(ep),
    };
}
