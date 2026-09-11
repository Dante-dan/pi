import type { ToolCall } from "../types.ts";
import { parseStreamingJson } from "./json-parse.ts";

interface ArgumentState {
	json?: string;
	value: ToolCall["arguments"] | undefined;
}

/** Provider-owned state for a tool call whose arguments are still streaming. */
export interface PendingToolCall<T extends ToolCall = ToolCall> {
	readonly toolCall: T;
	setJson(json: string | undefined): void;
	finish(): void;
	finishFromJson(): void;
	copy(): PendingToolCall<T>;
}

export function createPendingToolCall<T extends ToolCall>(initial: T, fallbackOnFalsy = false): PendingToolCall<T> {
	return createPendingView(initial, { value: initial.arguments }, fallbackOnFalsy);
}

function createPendingView<T extends ToolCall>(
	initial: T,
	initialState: ArgumentState,
	fallbackOnFalsy: boolean,
): PendingToolCall<T> {
	let state = initialState;
	const parseJson = (): ToolCall["arguments"] => {
		let value = parseStreamingJson<ToolCall["arguments"]>(state.json);
		if (fallbackOnFalsy) value ||= {};
		return value;
	};
	const materialize = (value: ToolCall["arguments"]): void => {
		Object.defineProperty(toolCall, "arguments", { value, writable: true, enumerable: true, configurable: true });
		state = { value };
	};
	const toolCall: T = {
		...initial,
		get arguments() {
			if (state.value === undefined) {
				state.value = parseJson();
			}
			return state.value;
		},
		set arguments(value: ToolCall["arguments"]) {
			// Assignments replace this view's value without changing earlier copies.
			state = { ...state, value };
		},
	};

	return {
		toolCall,
		setJson(json) {
			state = { json, value: undefined };
		},
		finish() {
			materialize(toolCall.arguments);
		},
		finishFromJson() {
			// On interruption, the provider buffer remains authoritative even if a
			// streaming consumer mutated or replaced the last parsed snapshot.
			materialize(state.json === undefined ? toolCall.arguments : parseJson());
		},
		copy() {
			// Preserve the proxy's spread semantics for metadata, including symbol keys
			// and getter receivers, without evaluating arguments.
			const entries = Reflect.ownKeys(toolCall)
				.filter((key) => Object.getOwnPropertyDescriptor(toolCall, key)?.enumerable)
				.map((key) => [key, key === "arguments" ? {} : Reflect.get(toolCall, key)] as const);
			// Reads share a cached parse; later deltas and assignments replace only
			// the state of the view receiving them.
			return createPendingView(Object.fromEntries(entries) as unknown as T, state, fallbackOnFalsy);
		},
	};
}
