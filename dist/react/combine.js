/** Agent 0.7.7 useUIMessages.ts:171-179 combines AFTER deduping original
 * step orders. Neither mergeUIMessages nor combineUIMessages is exported by
 * the package's public entries. Follow vercel/UIMessages.ts:894-945 here:
 * assistant fragments of the same order form one message; tool parts merge
 * by call id without overwriting existing input with undefined result fields.
 * Keep the first fragment's identity and agevex origin annotations.
 */
export function combineMessages(messages) {
    const combined = [];
    for (const message of messages) {
        const previous = combined[combined.length - 1];
        if (!previous ||
            previous.order !== message.order ||
            previous.role !== "assistant" ||
            message.role !== "assistant") {
            combined.push(message);
            continue;
        }
        const parts = [...previous.parts];
        for (const part of message.parts) {
            const callId = "toolCallId" in part ? part.toolCallId : undefined;
            const index = callId
                ? parts.findIndex((p) => "toolCallId" in p && p.toolCallId === callId)
                : -1;
            if (index < 0)
                parts.push(part);
            else {
                const [earlier] = parts.splice(index, 1);
                parts.push({
                    ...earlier,
                    ...Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined)),
                });
            }
        }
        combined[combined.length - 1] = {
            ...previous,
            status: message.status,
            metadata: message.metadata,
            agentName: message.agentName,
            parts,
            text: parts
                .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
                .join(" "),
        };
    }
    return combined;
}
