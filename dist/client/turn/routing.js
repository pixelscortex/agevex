// Stateless model selection for one generation step, including tool/approval resumes.
// A hook choice never changes run or assignment state; returning it again is
// how hosts keep a model across separately scheduled generation steps.
/** Select this generation's allowlisted model and honor a beforeTurn block. */
export async function selectTurnModel(rt, gen) {
    const { turn, hc, hook } = gen;
    const { claimed, managed } = turn;
    if (!managed.hooks?.beforeTurn)
        return claimed.modelId;
    const docs = await turn.rawCtx.runQuery(managed.component.messages.getMessagesByIds, {
        messageIds: [claimed.requestMessageId],
    });
    const before = await hook(() => managed.hooks.beforeTurn(hc, { prompt: docs[0]?.text ?? "" }), true);
    if (before?.model)
        await hook(async () => {
            if (!rt.config.models || !rt.config.modelAllowlist?.includes(before.model))
                throw new Error("MODEL_NOT_ALLOWED");
        });
    if (before?.block) {
        gen.state.hookBlocked = true;
        throw new Error("HOOK_BLOCKED");
    }
    return before?.model ?? claimed.modelId;
}
