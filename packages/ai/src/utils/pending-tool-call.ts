import { JSONParser, type JsonTypes, type ParsedElementInfo } from "@streamparser/json";
import type { ToolCall } from "../types.ts";
import { parseStreamingJson } from "./json-parse.ts";

interface IncrementalParserState {
	parser: JSONParser;
	owner: symbol;
	failed: boolean;
	latest: ToolCall["arguments"] | undefined;
	pendingInfo: ParsedElementInfo | undefined;
}

interface ArgumentState {
	json?: string;
	value: ToolCall["arguments"];
	parser: IncrementalParserState;
}

/** Provider-owned state for a tool call whose arguments are still streaming. */
export interface PendingToolCall<T extends ToolCall = ToolCall> {
	readonly toolCall: T;
	appendJson(delta: string): void;
	setJson(json: string | undefined): void;
	finish(): void;
	finishFromJson(): void;
	copy(): PendingToolCall<T>;
}

export function createPendingToolCall<T extends ToolCall>(initial: T, fallbackOnFalsy = false): PendingToolCall<T> {
	return createPendingView(initial, undefined, fallbackOnFalsy);
}

function setProperty(target: JsonTypes.JsonStruct, key: string | number, value: unknown): void {
	if (Array.isArray(target)) {
		target[key as number] = value as JsonTypes.JsonPrimitive | JsonTypes.JsonStruct;
	} else if (key === "__proto__") {
		Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		target[key] = value as JsonTypes.JsonPrimitive | JsonTypes.JsonStruct;
	}
}

function shallowClone(value: JsonTypes.JsonStruct | undefined): JsonTypes.JsonStruct {
	if (Array.isArray(value)) return value.slice();
	const clone: JsonTypes.JsonObject = {};
	for (const key of Object.keys(value ?? {})) setProperty(clone, key, value![key]);
	return clone;
}

/** Copy the active container path so later parser writes do not mutate an emitted snapshot. */
function snapshotValue(info: ParsedElementInfo): ToolCall["arguments"] | undefined {
	if (info.stack.length === 0) return info.value as ToolCall["arguments"] | undefined;
	let current = shallowClone(info.parent);
	if (info.key !== undefined && info.value !== undefined) setProperty(current, info.key, info.value);
	for (let index = info.stack.length - 1; index >= 1; index--) {
		const frame = info.stack[index];
		const parent = shallowClone(frame.value);
		if (frame.key !== undefined) setProperty(parent, frame.key, current);
		current = parent;
	}
	return current as ToolCall["arguments"];
}

function applyFallback(value: ToolCall["arguments"] | undefined, fallbackOnFalsy: boolean): ToolCall["arguments"] {
	return (fallbackOnFalsy ? value || {} : value === undefined ? {} : value) as ToolCall["arguments"];
}

function createIncrementalParser(owner: symbol): IncrementalParserState {
	const state: IncrementalParserState = {
		parser: new JSONParser({ emitPartialTokens: true, emitPartialValues: true, keepStack: true }),
		owner,
		failed: false,
		latest: undefined,
		pendingInfo: undefined,
	};
	state.parser.onValue = (info) => {
		state.pendingInfo = info;
	};
	state.parser.onError = () => {
		// Keep the last strict snapshot for realtime display. The provider buffer is
		// still collected and parsed with pi's tolerant parser at settlement.
		state.failed = true;
	};
	return state;
}

function feed(parser: IncrementalParserState, json: string): void {
	if (parser.failed || json.length === 0) return;
	parser.pendingInfo = undefined;
	try {
		parser.parser.write(json);
	} catch {
		parser.failed = true;
	}
	if (parser.pendingInfo !== undefined) {
		const snapshot = snapshotValue(parser.pendingInfo);
		if (snapshot !== undefined) parser.latest = snapshot;
	}
}

function createPendingView<T extends ToolCall>(
	initial: T,
	initialState: ArgumentState | undefined,
	fallbackOnFalsy: boolean,
): PendingToolCall<T> {
	const owner = Symbol("pending-tool-call-view");
	let state =
		initialState ??
		({
			json: undefined,
			value: initial.arguments,
			parser: createIncrementalParser(owner),
		} satisfies ArgumentState);
	// copy() transfers the live parser to the new view. A subsequently updated
	// older view rebuilds once from its own buffered prefix before diverging.
	state.parser.owner = owner;
	const parseJson = (): ToolCall["arguments"] => {
		return applyFallback(parseStreamingJson<ToolCall["arguments"]>(state.json), fallbackOnFalsy);
	};
	const materialize = (value: ToolCall["arguments"]): void => {
		Object.defineProperty(toolCall, "arguments", { value, writable: true, enumerable: true, configurable: true });
		state = { ...state, value };
	};
	const toolCall: T = {
		...initial,
		get arguments() {
			return state.value;
		},
		set arguments(value: ToolCall["arguments"]) {
			// Assignments replace this view's value without changing earlier copies.
			state = { ...state, value };
		},
	};

	return {
		toolCall,
		appendJson(delta) {
			let parser = state.parser;
			if (parser.owner !== owner) {
				parser = createIncrementalParser(owner);
				feed(parser, state.json ?? "");
			}
			feed(parser, delta);
			state = {
				json: (state.json ?? "") + delta,
				value: applyFallback(parser.latest === undefined ? state.value : parser.latest, fallbackOnFalsy),
				parser,
			};
		},
		setJson(json) {
			const parser = createIncrementalParser(owner);
			feed(parser, json ?? "");
			state = { json, value: applyFallback(parser.latest, fallbackOnFalsy), parser };
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
