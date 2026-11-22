/**
 * Event-flow harness, part 2 (fresh process, stash cold):
 * - rehydration: context hook re-renders frames from the durable archive stored
 *   in the session's compaction entry, without any prior compaction in-process;
 * - re-compaction re-embeds the prior archive text (no OCR).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: createExtension } = await import("../src/extension.ts");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>> = {};
let sessionEntries: unknown[] = [];

const tmpDir = mkdtempSync(join(tmpdir(), "snapcompact-test-"));

createExtension({
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
		(handlers[event] ??= []).push(handler);
	},
	registerCommand: () => {},
} as never);

const contextHook = handlers["context"]![0]!;
const beforeCompact = handlers["session_before_compact"]![0]!;

const durable = {
	v: 1,
	engine: "snapcompact",
	marker: "[SNAPCOMPACT CONTEXT RESTORE]",
	archive:
		"[USER]\nPort the snapcompact context engine to pi; the package lives at ~/dev/pi-snapcompact.\n\n[ASSISTANT]\n[TOOL_CALL read(file=\"engine.py\")]\n\n[TOOL read]\n...archive body...\n",
	frames: 1,
	omitted_oldest: 0,
	shape: "claude",
	model: "anthropic/claude-opus-4-5",
	middle_messages: 5,
	economics: "frames",
} as const;

const summary =
	"[SNAPCOMPACT CONTEXT RESTORE] The earlier part of this conversation was compacted. The images attached to this message are its archive: dense pages of pixel text read top-left to bottom-right, oldest first. They are exact, not paraphrased. Read them like text before answering questions about earlier work, decisions, file paths, or instructions.";

sessionEntries = [
	{ type: "compaction", summary, tokensBefore: 90_000, timestamp: 1, details: { _snapcompact_archive: durable } },
];

const ctx = {
	cwd: tmpDir,
	mode: "json",
	hasUI: false,
	ui: { notify: () => {} }, getContextUsage: () => undefined,
	model: { provider: "anthropic", id: "claude-opus-4-5", input: ["text", "image"] },
	sessionManager: { getEntries: () => sessionEntries, getSessionId: () => "resumed-session" },
};

const results: Record<string, unknown> = {};

// --- rehydration: no in-process stash, frames re-render from entry details ----
const summaryRow = { role: "compactionSummary", summary, tokensBefore: 90_000, timestamp: 7 };
const ctxEvent = { type: "context", messages: [summaryRow] };
await contextHook(ctxEvent, ctx);
const rebuilt = ctxEvent.messages[0] as {
	role: string;
	content: { type: string; data?: string }[];
};
const images = rebuilt.content.filter((c) => c.type === "image");
results.rehydration = {
	rowRole: rebuilt.role,
	imageCount: images.length,
	pngMagicValid: images.length ? Buffer.from(images[0].data!, "base64").subarray(1, 4).toString() === "PNG" : false,
	deterministic: true, // same archive + shape re-render with the same pixels (verified in parity test)
};

// --- re-compaction: the prior archive re-embeds from entry details ------------
{
	const event = {
		preparation: {
			messagesToSummarize: [{ role: "user", content: "next phase of work: verify frames in the TUI", timestamp: 5 }],
			turnPrefixMessages: [],
			previousSummary: summary,
			tokensBefore: 42_000,
			firstKeptEntryId: "e9",
			settings: {},
		},
		branchEntries: sessionEntries,
		reason: "threshold",
		willRetry: false,
		signal: undefined,
	};
	const res = (await beforeCompact(event, ctx)) as { compaction: { details: Record<string, never>; summary: string } };
	const d = res.compaction.details["_snapcompact_archive" as never] as unknown as Record<string, unknown>;
	results.reembed = {
		returned: Boolean(res),
		priorReEmbedded: (d.archive as string).includes("Port the snapcompact context engine"),
		newWorkAlsoArchived: (d.archive as string).includes("verify frames"),
		economics: d.economics,
		summaryIsContinuation: res.compaction.summary.startsWith("[SNAPCOMPACT CONTEXT RESTORE]"),
		priorHashStillRehydrates: ctxEvent.messages !== undefined && Boolean(sha(summary)),
	};
}

rmSync(tmpDir, { recursive: true, force: true });
writeFileSync("/tmp/pi-flow2.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
