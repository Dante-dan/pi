import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Request byte limits are independent of the model's token window. */
export function isRequestSizeError(errorMessage: string | undefined): boolean {
	return /request_too_large|exceeded limit on max bytes to request body|^413\s*(?:status code)?\s*\(no body\)/i.test(
		errorMessage ?? "",
	);
}

/** Limit retained image bytes, oldest first, without modifying the session transcript. */
export function limitOverflowImages(
	messages: AgentMessage[],
	budget = Number.POSITIVE_INFINITY,
): {
	messages: AgentMessage[];
	imageBytes: number;
} {
	let imageBytes = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") continue;
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "image") imageBytes += block.data.length;
		}
	}
	if (imageBytes === 0) return { messages, imageBytes };

	let remainingBytes = imageBytes;
	const reduced = messages.map((message): AgentMessage => {
		if (remainingBytes <= budget) return message;
		if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return message;
		if (typeof message.content === "string") return message;
		let changed = false;
		const content = message.content.map((block) => {
			if (block.type !== "image" || remainingBytes <= budget) return block;
			remainingBytes -= block.data.length;
			changed = true;
			return { type: "text" as const, text: "[Image omitted after the provider rejected the request size.]" };
		});
		return changed ? { ...message, content } : message;
	});
	return { messages: reduced, imageBytes: remainingBytes };
}
