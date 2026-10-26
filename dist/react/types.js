/** Fail at the hook that needs an omitted endpoint, rather than at factory creation. */
export function required(api, key) {
    const ref = api[key];
    if (!ref)
        throw new Error(`agevex/react: export the authorized '${key}' endpoint to use this hook`);
    return ref;
}
/** Missing input always wins over cached data, including a previously selected thread. */
export function queryState(threadId, data) {
    if (threadId === undefined)
        return { status: "skipped" };
    return data === undefined ? { status: "loading" } : { status: "ready", data };
}
export function threadRequired(threadId) {
    if (threadId === undefined)
        throw new Error("agevex/react: select a thread before writing");
    return threadId;
}
