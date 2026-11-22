/**
 * snapcompact: bitmap-frame context compression extension for pi.
 *
 * Ported from hermes-snapcompact (engine.py) onto pi's extension hooks:
 *
 * - `session_before_compact` replaces the LLM summarizer: the discarded middle is
 *   serialized to bounded dense text, rasterized onto model-shaped 1-bit PNG frames
 *   of 8x16 pixel glyphs, and the compaction summary row carries the archive. The
 *   pass is local, deterministic and LLM-free — so it is also safe for overflow
 *   recovery. On models without image input the pass is handed to pi's default
 *   compaction (`nonvision_mode: "llm_summary"`, the default) or, with
 *   `nonvision_mode: "text_archive"`, to a deterministic bounded text archive;
 *   when frames would not actually shrink the transcript it falls back to that
 *   same bounded text archive.
 * - `context` re-attaches the archive before every LLM call: the summary row is
 *   rebuilt as a user message whose content carries the compaction summary text
 *   plus the frame images (or the bounded archive text when the active model has
 *   no image input — an improvement over hermes, where such rows kept only the
 *   lead-in until the next compaction).
 *
 * Durability follows hermes' principle: the bounded archive TEXT is the durable
 * source of truth, persisted in the compaction entry's `details`; frames are
 * re-rendered deterministically from it on demand (same text + shape => same
 * bytes), so nothing bulky is stored and archives survive resume, fork and tree
 * navigation without OCR.
 *
 * Activate by installing this package; it replaces the default compaction
 * summary globally. Configuration (all optional) lives under the `snapcompact`
 * key in `~/.pi/agent/settings.json` (or project `.pi/settings.json`), with
 * `PI_SNAPCOMPACT_*` env overrides:
 *
 *   max_frames (48), shape (auto), assume_vision (auto), nonvision_mode
 *   (llm_summary | text_archive), archive_source_max_chars (48000),
 *   nonvision_max_chars (24000), tool_result_max_chars (2000),
 *   tool_result_head_ratio (0.6), tool_arg_max_chars (500),
 *   tool_call_max_chars (2000), min_middle_tokens (1200),
 *   min_shrink_ratio (0.9)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CompactionEntry, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import * as render from "./render.ts";
import { SNAPCOMPACT_ARCHIVE_KEY, boundArchiveText, serializeMessages, type LlmMessage } from "./serialize.ts";
import { SHAPE_NAMES, frameRows, frameTokens, resolveShape, type Shape } from "./shapes.ts";

const snapVersion = "1.0.0";

// pi's compaction-summary framing (dist/core/messages.js, v1.6.0). Not exported
// from the public entry; inlined so the rebuilt summary row reads exactly like a
// stock pi compaction summary row. If pi ever changes these, only the framing
// wrapper changes — snapcompact's own marker stays first for detection.
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const MARKER = "[SNAPCOMPACT CONTEXT RESTORE]";
const FRAME_NOTE =
	"[snapcompact archive] The images above are a bitmap archive of the earlier " +
	"conversation that was compacted away: pages of monospaced pixel text, read " +
	"top-left to bottom-right, oldest first. They are an exact record, not a " +
	"summary — consult them before claiming anything from earlier in the session " +
	"is unknown.";
const NONVISION_HEADER =
	MARKER +
	" The earlier part of this conversation was " +
	"compacted with no vision model active, so a bounded text archive follows " +
	"(head and tail kept, middle elided).\n\n";
const TEXT_ARCHIVE_HEADER =
	MARKER +
	" The earlier part of this conversation was " +
	"compacted into a bounded text archive instead of bitmap frames (head and " +
	"tail kept, middle elided).\n\n";

const DEFAULTS: Record<string, unknown> = {
	max_frames: 48,
	shape: "auto",
	assume_vision: "auto", // auto | true | false
	nonvision_mode: "llm_summary", // llm_summary (default compaction) | text_archive
	archive_source_max_chars: 48_000,
	nonvision_max_chars: 24_000,
	tool_result_max_chars: 2_000,
	tool_result_head_ratio: 0.6,
	tool_arg_max_chars: 500,
	tool_call_max_chars: 2_000,
	min_middle_tokens: 1_200, // never bother below this
	min_shrink_ratio: 0.9, // frames must shrink the middle by >= 10%
	compact_at_percent: 100, // compact when usage >= pct of window (100 = pi's own trigger governs)
};

/** Interface of the archive payload this extension stores on compaction entries. */
interface SnapCompactDetails {
	v: 1;
	engine: "snapcompact";
	marker: string;
	archive: string; // bounded archive text (durable re-render + re-embed source)
	frames: number; // frames rendered for the pass (0 => text archive pass)
	omitted_oldest: number;
	shape: string;
	model: string;
	middle_messages: number;
	economics: "frames" | "text_archive";
}

interface Stash {
	pngs: string[]; // base64, oldest first
	omitted: number;
	shape: Shape;
	details: SnapCompactDetails;
}

function envOverride(key: string): unknown {
	return process.env[`PI_SNAPCOMPACT_${key.toUpperCase()}`];
}

/** When PI_SNAPCOMPACT_DEBUG=1, append one line per hook to /tmp/snapcompact-debug.log. */
function dbg(line: string): void {
	try {
		if (process.env.PI_SNAPCOMPACT_DEBUG === "1") {
			// lazy import keeps the happy path import-light
			const { appendFileSync } = require("node:fs");
			appendFileSync("/tmp/snapcompact-debug.log", `${new Date().toISOString()} ${line}\n`);
		}
	} catch {}
}

function readSettingsFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): Record<string, unknown> {
	const cfg: Record<string, unknown> = { ...DEFAULTS };
	const globalSettings = readSettingsFile(join(homedir(), ".pi", "agent", "settings.json"));
	const projectSettings = readSettingsFile(resolve(cwd, ".pi", "settings.json"));
	for (const source of [globalSettings, projectSettings]) {
		const sc = source.snapcompact;
		if (sc && typeof sc === "object") {
			for (const [k, v] of Object.entries(sc as Record<string, unknown>)) {
				if (k in DEFAULTS) cfg[k] = v;
			}
		}
	}
	for (const key of Object.keys(DEFAULTS)) {
		const env = envOverride(key);
		if (env !== undefined) cfg[key] = env;
	}
	return cfg;
}

/** Deterministic rough token estimate: chars/4 with per-message overhead. */
function estimateMessagesTokensRough(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) total += estimateTokens(msg);
	return total;
}

function modelId(ctx: ExtensionContext): string {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : "";
}

function visionCapable(ctx: ExtensionContext, cfg: Record<string, unknown>): boolean {
	const mode = cfg.assume_vision;
	if (mode === true || mode === "true") return true;
	if (mode === false || mode === "false") return false;
	const model = ctx.model;
	return Boolean(model && Array.isArray(model.input) && model.input.includes("image"));
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

interface CompactionLike {
	summary: string;
	details?: unknown;
}

function entrySnapCompact(entry: unknown): SnapCompactDetails | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as CompactionLike & { type?: string };
	if (e.type !== "compaction") return null;
	const details = e.details as Record<string, unknown> | undefined;
	const sc = details?.[SNAPCOMPACT_ARCHIVE_KEY] as SnapCompactDetails | undefined;
	return sc && sc.engine === "snapcompact" ? sc : null;
}

function findPriorArchive(branchEntries: unknown[]): string | null {
	/**
	 * Latest snapcompact archive on this branch (entries are chronological) —
	 * the durable source later compactions re-embed (hermes: the summary-row
	 * archive key).
	 */
	let found: string | null = null;
	for (const entry of branchEntries) {
		const sc = entrySnapCompact(entry);
		if (sc?.archive?.trim()) found = sc.archive;
	}
	return found;
}

/** Clean a previous (possibly ours or pi's) summary down to reusable raw text. */
function cleanPreviousSummary(previousSummary: string | undefined): string | null {
	if (!previousSummary?.trim()) return null;
	let text = previousSummary;
	if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) text = text.slice(COMPACTION_SUMMARY_PREFIX.length);
	if (text.endsWith(COMPACTION_SUMMARY_SUFFIX)) text = text.slice(0, -COMPACTION_SUMMARY_SUFFIX.length);
	if (text.includes(MARKER)) return null; // our own frames-only lead-in carries no reusable text
	return text.trim();
}

function num(cfg: Record<string, unknown>, key: string, fallback: number): number {
	const v = cfg[key];
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function str(cfg: Record<string, unknown>, key: string, fallback: string): string {
	const v = cfg[key];
	return typeof v === "string" ? v : fallback;
}

let lastStatus: {
	model: string;
	shape: string | null;
	vision: boolean | null;
	last_pass: { economics: string; frames: number; omitted: number; middle: number } | null;
} = { model: "", shape: null, vision: null, last_pass: null };

/** In-memory frame stash keyed by hash(summary); LRU-bounded. */
const stash = new Map<string, Stash>();
const STASH_MAX = 8;

function stashPut(key: string, value: Stash): void {
	stash.delete(key);
	stash.set(key, value);
	while (stash.size > STASH_MAX) {
		const oldest = stash.keys().next().value as string;
		stash.delete(oldest);
	}
}

function stashGet(key: string, ctx: ExtensionContext): Stash | undefined {
	const hit = stash.get(key);
	if (hit) {
		// refresh LRU order
		stash.delete(key);
		stash.set(key, hit);
		return hit;
	}
	return rehydrate(key, ctx);
}

/**
 * Re-render frames deterministically from the durable archive text persisted in
 * the session's compaction entries (hermes: the summary-row archive key).
 */
function rehydrate(key: string, ctx: ExtensionContext): Stash | undefined {
	try {
		const entries = ctx.sessionManager.getEntries() as unknown as Array<
			CompactionLike & { type?: string }
		>;
		for (const entry of entries) {
			if (sha256(entry.summary) !== key) continue;
			const sc = entrySnapCompact(entry);
			if (!sc?.archive?.trim()) return undefined;
			const cfg = loadConfig(ctx.cwd);
			// The recorded shape is authoritative; absent/corrupt entries fall back
			// to the configured or model-resolved shape.
			const modelForShape = sc.model ?? modelId(ctx);
			const shape = sc.shape && SHAPE_NAMES.includes(sc.shape)
				? resolveShape(modelForShape, sc.shape)
				: resolveShape(modelForShape, str(cfg, "shape", "auto"));
			const [pngs, omitted] = render.renderFrames(
				sc.archive,
				shape,
				num(cfg, "max_frames", 48),
			);
			const st: Stash = {
				pngs: pngs.map((b) => Buffer.from(b).toString("base64")),
				omitted: sc.omitted_oldest ?? omitted,
				shape,
				details: sc,
			};
			stashPut(key, st);
			return st;
		}
	} catch {
		// fail-open: a text-only summary remains
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		dbg(`before_compact reason=${event.reason} middle=${event.preparation?.messagesToSummarize?.length ?? "?"} prefix=${event.preparation?.turnPrefixMessages?.length ?? "?"} model=${modelId(ctx)}`);
		const cfg = loadConfig(ctx.cwd);
		const { preparation, reason, branchEntries, signal } = event;
		if (signal?.aborted) return { cancel: true };

		const vision = visionCapable(ctx, cfg);
		lastStatus.vision = vision;
		lastStatus.model = modelId(ctx);

		const nonvisionMode = str(cfg, "nonvision_mode", "llm_summary").toLowerCase();
		if (!vision && nonvisionMode !== "text_archive") {
			// No image input on the active model and the default path is selected:
			// hand the whole pass to pi's built-in compaction, exactly as stock pi
			// would. No frames, no stash for this pass.
			lastStatus.last_pass = { economics: "llm_summary", frames: 0, omitted: 0, middle: 0 };
			return undefined;
		}

		// Deterministic summary text; the archive itself rides on the frames.
		// No LLM call is made in either path, so compression cannot fail on a
		// summary-model outage and stays safe for overflow recovery.
		const middleMsgs: AgentMessage[] = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (middleMsgs.length === 0) return undefined;

		// Re-embed the earlier compaction's bounded archive (durable), so prior
		// archives survive re-compaction without OCR.
		const priorSummaries: { text: string }[] = [];
		const priorArchive = findPriorArchive(branchEntries as unknown[]);
		if (priorArchive) priorSummaries.push({ text: priorArchive });
		else {
			const prev = cleanPreviousSummary(preparation.previousSummary);
			if (prev) priorSummaries.push({ text: prev });
		}

		const archive = serializeMessages(convertToLlm(middleMsgs) as unknown as LlmMessage[], cfg, priorSummaries);
		if (!archive.trim()) return undefined;

		const shape = resolveShape(modelId(ctx), str(cfg, "shape", "auto"));
		const maxFrames = Math.trunc(num(cfg, "max_frames", 48));
		const minMiddleTokens = num(cfg, "min_middle_tokens", 1_200);
		const minShrinkRatio = num(cfg, "min_shrink_ratio", 0.9);

		let useFrames = false;
		let pngs: Uint8Array[] = [];
		let omitted = 0;
		const estMiddle = estimateMessagesTokensRough(middleMsgs);
		const rowsPerFrame = frameRows(shape);
		// Cheap pre-gate: middles smaller than ~2 image tokens-worth can never
		// shrink into frames; skip without side effects (hermes compress() gate).
		const floor = vision ? Math.max(minMiddleTokens, 2 * frameTokens(shape, rowsPerFrame)) : minMiddleTokens;
		const gate = reason === "manual" || estMiddle >= floor; // manual /compact: honor the user (hermes: force)
		if (vision && archive.trim() && gate) {
			const [nFrames, omittedPlan] = render.planFrames(archive, shape, maxFrames);
			// Frames must shrink the middle by >= min_shrink_ratio of its tokens.
			const estFrames = nFrames * frameTokens(shape, rowsPerFrame);
			useFrames = Boolean(nFrames && estMiddle && estFrames < estMiddle * minShrinkRatio);
			if (useFrames) {
				[pngs, omitted] = render.renderFrames(archive, shape, maxFrames);
			}
		}

		const summaryText = useFrames
			? MARKER + " The earlier part of this conversation was compacted. The images attached to this message are its archive: dense pages of pixel text read top-left to bottom-right, oldest first. They are exact, not paraphrased. Read them like text before answering questions about earlier work, decisions, file paths, or instructions."
			: (vision ? TEXT_ARCHIVE_HEADER : NONVISION_HEADER) +
				boundArchiveText(archive, num(cfg, "nonvision_max_chars", 24_000));

		const details: SnapCompactDetails = {
			v: 1,
			engine: "snapcompact",
			marker: MARKER,
			archive: boundArchiveText(archive, num(cfg, "archive_source_max_chars", 48_000)),
			frames: useFrames ? pngs.length : 0,
			omitted_oldest: omitted,
			shape: shape.name,
			model: modelId(ctx),
			middle_messages: middleMsgs.length,
			economics: useFrames ? "frames" : "text_archive",
		};

		if (useFrames) {
			stashPut(sha256(summaryText), { pngs: pngs.map((b) => Buffer.from(b).toString("base64")), omitted, shape, details });
		}
		lastStatus.shape = shape.name;
		lastStatus.last_pass = {
			economics: details.economics,
			frames: details.frames,
			omitted: details.omitted_oldest,
			middle: details.middle_messages,
		};

		return {
			compaction: {
				summary: summaryText,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { [SNAPCOMPACT_ARCHIVE_KEY]: details },
			},
		};
	});

	pi.on("context", async (event, ctx) => {
		dbg(`context: ${event.messages.length} messages; usage=${JSON.stringify(ctx.getContextUsage())}`);
		const cfg = loadConfig(ctx.cwd);
		let changed = false;
		const messages = event.messages;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i] as AgentMessage & { role: string; summary?: string; timestamp?: number };
			if (msg?.role !== "compactionSummary" || !msg.summary?.includes(MARKER)) continue;
			const key = sha256(msg.summary);
			const hit = stashGet(key, ctx);
			if (!hit) continue;
			// Frames belong inside a user-role row: convertToLlm passes user
			// messages through untouched, while it would discard image content on
			// a compactionSummary row (it rebuilds that role from summary text).
			const text = String(msg.summary ?? "");
			const parts: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
				{ type: "text", text: COMPACTION_SUMMARY_PREFIX + text + COMPACTION_SUMMARY_SUFFIX },
			];
			if (visionCapable(ctx, cfg)) {
				parts.push({ type: "text", text: FRAME_NOTE });
				for (const b64 of hit.pngs) {
					parts.push({ type: "image", data: b64, mimeType: "image/png" });
				}
			} else {
				// Active model has no image input: carry the bounded text archive
				// inline instead of the frames (strict improvement over hermes,
				// where such rows kept only the lead-in until the next compaction).
				parts.push({ type: "text", text: hit.details.archive });
			}
			messages[i] = {
				role: "user",
				content: parts,
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
			} as unknown as AgentMessage;
			changed = true;
		}
		return changed ? { messages } : undefined;
	});

	// Percentage-based late compaction: pi's trigger is absolute (reserveTokens in
	// tokens), which fires proportionally early on small windows; this fires from
	// the live window of whatever model is active. 100 (default) means "as late as
	// possible" -- compaction only when the context is at hard-window capacity
	// (pair with reserveTokens: 0 so pi's absolute check never pre-empts it).
	pi.on("turn_end", async (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		const pct = num(cfg, "compact_at_percent", 100);
		const usage = ctx.getContextUsage();
		if (!usage?.percent || usage.percent < pct) return;
		dbg(`turn_end: usage ${usage.tokens}/${usage.contextWindow} = ${usage.percent}% >= ${pct}% -> compact()`);
		ctx.compact();
	});

	pi.registerCommand("snapcompact", {
		description: "Show snapcompact context-engine status",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const cfg = loadConfig(ctx.cwd);
			const model = ctx.model;
			const shape = model ? resolveShape(modelId(ctx), str(cfg, "shape", "auto")) : null;
			const lines = [
				`snapcompact ${snapVersion} — bitmap-frame context compaction (hermes-snapcompact port)`,
				`model: ${model ? `${model.provider}/${model.id}` : "(none)"}`,
				`vision input: ${visionCapable(ctx, cfg) ? "yes" : "no"}`,
				`shape: ${shape ? `${shape.name} (${shape.frame_w / shape.advance} cols x ${frameRows(shape)} rows/frame)` : "?"}`,
				`max_frames: ${num(cfg, "max_frames", 48)}  nonvision_mode: ${str(cfg, "nonvision_mode", "llm_summary")}`,
				`frames cached in memory: ${stash.size}`,
				lastStatus.last_pass
					? `last pass: ${lastStatus.last_pass.economics} (${lastStatus.last_pass.frames} frame(s), ${lastStatus.last_pass.omitted} oldest page(s) omitted, ${lastStatus.last_pass.middle} middle messages)`
					: "last pass: none yet",
				"",
				"Frame images ride on the compaction summary row at request time; the",
				"bounded archive text on each compaction entry is the durable source.",
			];
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

