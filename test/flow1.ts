/**
 * Event-flow harness, part 1 (fresh process = empty stash):
 * frames pass -> context rebuild, nonvision default, text-archive mode, command.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
void createRequire;

const require_ = createRequire(import.meta.url);
const { default: createExtension } = await import("../src/extension.ts");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>> = {};
const commands: Record<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }> = {};
const notifies: string[] = [];
let sessionEntries: unknown[] = [];
let visionModel: unknown = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	input: ["text", "image"],
};

const tmpDir = mkdtempSync(join(tmpdir(), "snapcompact-test-"));

let usagePercent: number | null = null;
let compactCalls = 0;

function makeCtx() {
	return {
		cwd: tmpDir,
		mode: "json",
		hasUI: false,
		ui: { notify: (message: string) => void notifies.push(message) },
		getContextUsage: () => (usagePercent === null ? undefined : { tokens: 1000, contextWindow: 1000, percent: usagePercent }),
		compact: () => { compactCalls++; },
		get model() {
			return visionModel;
		},
		sessionManager: { getEntries: () => sessionEntries, getSessionId: () => "test-session" },
	};
}

const middle: unknown[] = [
	{ role: "user", content: "Fix the failing test in tests/test_compress.py. Symptom: KeyError 'token'. Trace so far: " + "the loader stages resolve build artifacts, env state and device maps in order. ".repeat(1200), timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal scratch" },
			{ type: "text", text: "Reading the test and loader, then device loader source." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "tests/test_compress.py" } },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "python -m pytest tests/test_compress.py -x" } },
		],
		timestamp: 2,
	},
	{
		role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, timestamp: 3,
		content: [{ type: "text", text: "def test_compress_empty_device_map():\n    devices = load_devices()\n    assert devices[\"token\"] == \"abc123\"   # fails: devices is {}\n" + Array.from({ length: 400 }, (_, i) => "    def stage_" + i + "(payload): return payload.postprocess(scale=" + (i % 7) + ")").join("\n") }],
	},
	{
		role: "toolResult", toolCallId: "call_2", toolName: "bash", isError: true, timestamp: 4,
		content: [{ type: "text", text: "AssertionError: devices is {}\n" }],
	},
];

createExtension({
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
		(handlers[event] ??= []).push(handler);
	},
	registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
		commands[name] = options;
	},
} as never);

const beforeCompact = handlers["session_before_compact"]![0]!;
const contextHook = handlers["context"]![0]!;
const results: Record<string, unknown> = {};

// --- pass 1: vision model -> frames; context hook rebuilds the summary row ---
{
	const event = {
		preparation: {
			messagesToSummarize: middle,
			turnPrefixMessages: [],
			previousSummary: undefined,
			tokensBefore: 90_000,
			firstKeptEntryId: "entry-9",
			settings: {},
		},
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: undefined,
	};
	const res = (await beforeCompact(event, makeCtx())) as {
		compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: Record<string, never> };
	};
	const d = res.compaction.details["_snapcompact_archive" as never] as unknown as Record<string, unknown>;
	results.framesPass = {
		returned: Boolean(res),
		keptEntryId: res.compaction.firstKeptEntryId === "entry-9",
		tokensBeforeKept: res.compaction.tokensBefore === 90_000,
		summaryMarker: res.compaction.summary.startsWith("[SNAPCOMPACT CONTEXT RESTORE]"),
		frames: d.frames,
		economics: d.economics,
		omitted: d.omitted_oldest,
		shape: d.shape,
		middle: d.middle_messages,
		boundedArchiveChars: d.archive.length,
		estMiddlePersisted: (d.est_middle_tokens as number) > 0,
		estFramesPersisted: (d.est_frame_tokens as number) > 0,
		pagesPersisted: (d.pages as number) >= d.frames,
		thinkingLeak: d.archive.includes("internal scratch"),
	};
	sessionEntries = [{ type: "compaction", summary: res.compaction.summary, tokensBefore: 90_000, timestamp: Date.now(), details: res.compaction.details }];

	const summaryRow = { role: "compactionSummary", summary: res.compaction.summary, tokensBefore: 90_000, timestamp: 7 };
	const kept = { role: "user", content: "follow-up", timestamp: 9 };
	const ctxEvent = { type: "context", messages: [{ ...summaryRow }, kept] };
	await contextHook(ctxEvent, makeCtx());
	const rebuilt = (ctxEvent.messages as {
		role: string; content: { type: string; text?: string; data?: string; mimeType?: string }[];
	}[])[0];
	const imagePart = rebuilt.content.find((c) => c.type === "image");
	const pngMagic = imagePart ? Buffer.from(imagePart.data!, "base64").subarray(1, 4).toString() : "";
	results.contextRebuild = {
		rowRole: rebuilt.role,
		partKinds: rebuilt.content.map((c) => c.type).join("+"),
		wrappedInPiSummary: rebuilt.content[0].text!.startsWith("The conversation history before this point was compacted"),
		summaryKept: rebuilt.content[0].text!.includes("[SNAPCOMPACT CONTEXT RESTORE]"),
		pngMagicValid: pngMagic === "PNG",
		mimeType: imagePart?.mimeType,
		keptRowUntouched: ctxEvent.messages[1] === kept,
	};
}

// --- pass 2: nonvision model, default mode -> undefined (default compaction) --
{
	visionModel = { provider: "openai", id: "gpt-5.2-mini", input: ["text"] };
	const event = {
		preparation: { messagesToSummarize: middle, turnPrefixMessages: [], previousSummary: undefined, tokensBefore: 50_000, firstKeptEntryId: "e2", settings: {} },
		branchEntries: [], reason: "threshold", willRetry: false, signal: undefined,
	};
	const res = await beforeCompact(event, makeCtx());
	results.nonvisionDefault = { fallsBackToDefaultCompaction: res === undefined };
}

// --- pass 3: nonvision + text_archive mode -> deterministic bounded text ------
{
	process.env.PI_SNAPCOMPACT_NONVISION_MODE = "text_archive";
	const event = {
		preparation: { messagesToSummarize: middle, turnPrefixMessages: [], previousSummary: undefined, tokensBefore: 50_000, firstKeptEntryId: "e3", settings: {} },
		branchEntries: [], reason: "threshold", willRetry: false, signal: undefined,
	};
	const res = (await beforeCompact(event, makeCtx())) as { compaction: { summary: string; details: Record<string, never> } };
	delete process.env.PI_SNAPCOMPACT_NONVISION_MODE;
	const d = res.compaction.details["_snapcompact_archive" as never] as unknown as Record<string, unknown>;
	results.nonvisionTextArchive = {
		returned: Boolean(res),
		hasTextArchiveHeader: res.compaction.summary.includes("bounded text archive follows"),
		carriesArchiveText: res.compaction.summary.length > 1000,
		framesInDetails: d.frames,
		economics: d.economics,
		estFramesZeroWhenNoVision: d.est_frame_tokens === 0 && d.pages === 0,
	};
	// A text-archive summary is self-contained: pi renders compactionSummary
	// rows natively, so the context hook must leave it untouched (no frames to
	// rehydrate, nothing to rebuild).
	const summaryRow = { role: "compactionSummary", summary: res.compaction.summary, tokensBefore: 50_000, timestamp: 8 };
	const ctxEvent = { type: "context", messages: [summaryRow] };
	const hookRes = (await contextHook(ctxEvent, makeCtx())) as unknown;
	const row = ctxEvent.messages[0] as { role: string; summary?: string };
	results.nonvisionContextRow = {
		hookReturnsNothing: hookRes === undefined,
		rowLeftAsSummary: row.role === "compactionSummary",
		archiveReadableFromSummary: row.summary!.includes("[TOOL bash ERROR]"),
	};
}

// --- turn_end percentage trigger -----------------------------------------------
{
	const turnEnd = handlers["turn_end"]![0]!;

	// default (100): never fires ctx.compact() itself -- at 100% pi's own trigger governs
	usagePercent = 100;
	compactCalls = 0;
	await turnEnd({}, makeCtx());
	results.pctDefault = { at100: compactCalls === 0 };

	// opt-in percent (e.g. 90): fires only at/above the threshold
	process.env.PI_SNAPCOMPACT_COMPACT_AT_PERCENT = "90";
	usagePercent = 89.9;
	compactCalls = 0;
	await turnEnd({}, makeCtx());
	const notYet = compactCalls === 0;
	usagePercent = 90;
	await turnEnd({}, makeCtx());
	const atThreshold = compactCalls === 1;
	usagePercent = 99.9;
	await turnEnd({}, makeCtx());
	const above = compactCalls === 2;
	// no usage info -> never fires
	usagePercent = null;
	await turnEnd({}, makeCtx());
	const noUsage = compactCalls === 2;
	delete process.env.PI_SNAPCOMPACT_COMPACT_AT_PERCENT;
	results.pctTrigger = { notYet, atThreshold, above, noUsage };
}

// --- /snapcompile command reports status --------------------------------------
await commands["snapcompact"].handler("", makeCtx());
results.command = {
	notified: notifies.some((n) => n.includes("last pass")),
	mentionsShape: notifies.some((n) => n.includes("shape:")),
};

rmSync(tmpDir, { recursive: true, force: true });
writeFileSync("/tmp/pi-flow1.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
void sha;
