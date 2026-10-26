/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export function askUserMarker(tool) {
    return tool?.agevexAskUser;
}
/** Schemas travel out of band, never in model-visible tool-call input. */
export function askUserTools(tools) {
    return Object.fromEntries(Object.entries(tools).flatMap(([name, tool]) => {
        const marker = askUserMarker(tool);
        return marker
            ? [[name, marker.answerSchema ? { answerSchema: marker.answerSchema } : {}]]
            : [];
    }));
}
