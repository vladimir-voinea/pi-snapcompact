/**
 * Conversation -> dense archive text for snapcompact (pi port).
 *
 * Ported from hermes-snapcompact serialize.py and adapted to pi's LLM message
 * shapes (user / assistant with toolCalls / toolResult with toolName).
 *
 * Faithful, bounded serialization of the discarded middle: tool results truncated
 * head+tail, tool-call arguments capped per value and per call, tool output kept
 * distinct from conversation. No paraphrasing, no LLM — the archive text is what
 * gets rasterized onto the frames, and (bounded) what later compactions re-render
 * from, so prior archives survive re-compaction without OCR.
 */

export const SNAPCOMPACT_ARCHIVE_KEY = "_snapcompact_archive";

type Part = { type: string; text?: string; data?: string; mimeType?: string };

export interface LlmMessage {
	role: string;
	content?: string | Part[];
	toolCalls?: { type?: string; id?: string; name?: string; arguments?: unknown }[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

export function truncHeadTail(text: string, maxChars: number, headRatio: number): string {
	/** Keep head+tail of overlong text with an explicit elision marker. */
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const head = Math.trunc(maxChars * headRatio);
	const tail = Math.max(0, maxChars - head);
	const omitted = text.length - head - tail;
	return text.slice(0, head) + `\n...[elided ${omitted} chars]...\n` + (tail ? text.slice(-tail) : "");
}

function truncArgs(args: unknown, perValue: number, perCall: number): string {
	/** JSON-dump tool-call args with each string value capped at `perValue`. */
	const cap = (v: unknown): unknown => {
		if (typeof v === "string") {
			return v.length > perValue ? v.slice(0, perValue) + `...[${v.length - perValue} chars elided]` : v;
		}
		if (Array.isArray(v)) return v.map(cap);
		if (v && typeof v === "object") {
			return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cap(x)]));
		}
		return v;
	};
	let parsed: unknown = args;
	if (typeof args === "string") {
		try {
			parsed = args.trim() ? JSON.parse(args) : {};
		} catch {
			parsed = args;
		}
	}
	let out: string;
	try {
		out = JSON.stringify(cap(parsed));
	} catch {
		out = String(args);
	}
	if (out.length > perCall) {
		out = out.slice(0, perCall) + `...[${out.length - perCall} chars elided]`;
	}
	return out;
}

export interface SerializeOptions {
	tool_result_max_chars?: number;
	tool_result_head_ratio?: number;
	tool_arg_max_chars?: number;
	tool_call_max_chars?: number;
	/** Marker preceding an already-elided read-only document inside a tool result. */
	previous_summary_bounded?: string | null;
}

function partText(part: unknown): string {
	if (typeof part === "string") return part;
	if (part && typeof part === "object") {
		const p = part as Part;
		if (p.type === "text") return String(p.text ?? "");
		if (p.type === "image" || p.type === "image_url" || p.type === "input_image") {
			return "[image attached]";
		}
	}
	return "";
}

/** pi: assistant tool calls are content parts ({type: "toolCall", name, arguments}). */
function isToolCallPart(part: unknown): part is { type: string; name?: string; arguments?: unknown } {
	return Boolean(part && typeof part === "object" &&
		((part as Part).type === "toolCall" || (part as Part).type === "tool_call"));
}

function toolCallPartText(part: { name?: string; arguments?: unknown }, opts: { toolArgMaxChars: number; toolCallMaxChars: number }): string {
	const name = part.name || "?";
	const args = truncArgs(part.arguments, opts.toolArgMaxChars, opts.toolCallMaxChars);
	return `[TOOL_CALL ${name}(${args})]`;
}

function contentText(content: string | Part[] | undefined): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return content
		.map((p) => partText(p))
		.filter((t) => t)
		.join("\n");
}

export interface PriorSummary {
	/** Serialized text of the earlier compaction's bounded archive, if any. */
	text: string;
}

/**
 * Serialize the compressible middle into conversation-dense archive text.
 *
 * `priorSummaries` re-embeds earlier compaction archives (the durable bounded
 * source each prior snapcompact pass stored on its entry), so re-compaction
 * never needs to read the frames back.
 */
export function serializeMessages(
	middle: LlmMessage[],
	options: SerializeOptions = {},
	priorSummaries: PriorSummary[] = [],
): string {
	const toolResultMaxChars = options.tool_result_max_chars ?? 2_000;
	const toolResultHeadRatio = options.tool_result_head_ratio ?? 0.6;
	const toolArgMaxChars = options.tool_arg_max_chars ?? 500;
	const toolCallMaxChars = options.tool_call_max_chars ?? 2_000;
	const caps = { toolArgMaxChars, toolCallMaxChars };

	const blocks: string[] = [];
	for (const prior of priorSummaries) {
		if (prior.text.trim()) {
			blocks.push(`[PRIOR CONTEXT SUMMARY]\n${prior.text}`);
		}
	}
	for (const msg of middle) {
		if (!msg || typeof msg !== "object") continue;
		const role = msg.role;
		const text = contentText(msg.content);
		if (role === "toolResult") {
			const name = msg.toolName || msg.toolCallId || "tool";
			const body = truncHeadTail(text, toolResultMaxChars, toolResultHeadRatio);
			blocks.push(body ? `[TOOL ${name}${msg.isError ? " ERROR" : ""}]\n${body}` : "");
		} else if (role === "assistant") {
			const parts: string[] = [];
			if (text) parts.push(text);
			// pi shape: tool calls ride inside content; keep a toolCalls fallback
			// for callers already holding extracted calls.
			const contentParts = Array.isArray(msg.content) ? msg.content : [];
			for (const part of contentParts) {
				if (isToolCallPart(part)) parts.push(toolCallPartText(part, caps));
			}
			for (const tc of msg.toolCalls ?? []) {
				const fnName = tc.name || tc.id || "?";
				const args = truncArgs(tc.arguments, toolArgMaxChars, toolCallMaxChars);
				parts.push(`[TOOL_CALL ${fnName}(${args})]`);
			}
			if (parts.length) blocks.push("[ASSISTANT]\n" + parts.join("\n"));
		} else if (role === "user" || role === "system" || role === "developer") {
			if (text) blocks.push(`[${role.toUpperCase()}]\n${text}`);
		} else if (text) {
			blocks.push(`[${role.toUpperCase()}]\n${text}`);
		}
	}
	return blocks.filter((b) => b).join("\n\n");
}

/** Bound the persistent archive source (kept in the compaction entry details). */
export function boundArchiveText(text: string, maxChars: number, headRatio = 0.34): string {
	return truncHeadTail(text, maxChars, headRatio);
}
