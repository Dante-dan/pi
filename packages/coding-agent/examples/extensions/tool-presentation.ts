/**
 * Cycle full, compact, and one-line text tool rows with ctrl+shift+o.
 * Uses display-only resolvers, including for tools missing from resumed sessions.
 * Execution, tool declarations, and stored results are unchanged.
 * Image attachments are still displayed by Pi independently of these renderers.
 * Usage: pi -e ./tool-presentation.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

type RefreshableComponent = Component & { refresh(): void };

export default function (pi: ExtensionAPI) {
	let mode: "full" | "compact" | "one-line" = "compact";
	const rows = new Map<string, WeakRef<RefreshableComponent>>();

	pi.registerToolRenderer((toolName, next) => {
		const original = next();
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const expanded = mode === "full";
				let inner: Component;
				if (mode === "one-line") {
					const status = context.isPartial ? (context.executionStarted ? "running" : "pending") : context.isError ? "error" : "done";
					const color = context.isError ? "error" : "toolTitle";
					const summary = `${toolName} ${JSON.stringify(args) ?? ""} [${status}]`.replace(/\s+/g, " ");
					inner = {
						render: (width) => [truncateToWidth(theme.fg(color, summary), width)],
						invalidate() {},
					};
				} else {
					inner = original?.renderCall?.(args, theme, { ...context, expanded, lastComponent: undefined }) ??
						new Text(theme.fg("toolTitle", `${toolName}\n${JSON.stringify(args, null, expanded ? 2 : undefined) ?? ""}`), 0, 0);
				}
				// Weak references let replaced history rows be collected after /tree or reload.
				const component: RefreshableComponent = {
					render: (width) => inner.render(width),
					invalidate: () => inner.invalidate(),
					refresh: context.invalidate,
				};
				rows.set(context.toolCallId, new WeakRef(component));
				return component;
			},
			renderResult(result, options, theme, context) {
				if (mode === "one-line") return new Container();
				const expanded = mode === "full";
				if (original?.renderResult) {
					return original.renderResult(result, { ...options, expanded }, theme, { ...context, expanded, lastComponent: undefined });
				}
				const lines = result.content.flatMap((block) => block.type === "text" ? block.text.split("\n") : []);
				const visible = expanded ? lines : lines.slice(0, 10);
				if (visible.length < lines.length) visible.push(`... (${lines.length - visible.length} more lines)`);
				return new Text(theme.fg(context.isError ? "error" : "toolOutput", visible.join("\n")), 0, 0);
			},
		};
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Cycle text tool presentation: full, compact, one-line",
		handler(ctx) {
			if (ctx.mode !== "tui") return;
			mode = mode === "compact" ? "one-line" : mode === "one-line" ? "full" : "compact";
			// A refresh replaces the map entry; iterate a snapshot rather than the live map.
			for (const [id, ref] of [...rows]) {
				const component = ref.deref();
				if (component) component.refresh();
				else rows.delete(id);
			}
			ctx.ui.setStatus("tool-presentation", `Tools: ${mode}`);
		},
	});
}
