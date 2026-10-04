/**
 * Reference workaround for #10024, loaded explicitly with -e ./stable-system-prompt.ts.
 *
 * Keep the initial system text and send later prompt changes as user messages for
 * templates that reject mid-conversation system messages. Updates have user-level
 * priority: do not use this for changes that must retain system-level authority.
 * Current tool declarations still change and can invalidate a provider's cache.
 * Compaction establishes a new initial prompt; forced prompts remain authoritative.
 */
import { getCurrentTools, getInitialSystemMessage, renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event, ctx) => {
		if (ctx.model?.compat?.supportsMidConvoSystemMessages) return;
		const initial = getInitialSystemMessage(event.messages);
		if (!initial) return;
		const tools = getCurrentTools(event.messages);
		const { toolsAdded: _added, toolsRemoved: _removed, ...head } = initial;
		return {
			messages: [
				{ ...head, ...(tools.length > 0 ? { toolsAdded: tools } : {}) },
				...event.messages.slice(1).flatMap((message) => {
					if (message.role !== "system") return [message];
					const text = renderSystemMessageUpdate(message);
					return text ? [{ role: "user" as const, content: text, timestamp: message.timestamp }] : [];
				}),
			],
		};
	});
}
