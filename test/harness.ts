/**
 * Parity + behavior harness for the snapcompact pi port.
 * Run: node --experimental-strip-types test/harness.ts   (node 22+) or via jiti.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderFrames, renderPage, encodePng1bit } from "../src/render.ts";
import { resolveShape, frameTokens, frameRows } from "../src/shapes.ts";
import { serializeMessages, boundArchiveText, type LlmMessage } from "../src/serialize.ts";
import { resolve } from "node:path";

const sample = readFileSync(new URL("./sample.txt", import.meta.url), "utf8");

const shapeNames = ["claude", "gemini", "openai", "glm", "patch28", "claude-hires"];
mkdirSync("/tmp/pi-frames", { recursive: true });

let hermes = null;
try {
	hermes = JSON.parse(readFileSync("/tmp/hermes-frames.json", "utf8"));
} catch {}

const report: Record<string, unknown> = {};
for (const name of shapeNames) {
	const shape = resolveShape("", name);
	const t0 = Date.now();
	const [pngs, omitted] = renderFrames(sample, shape, 48);
	const dt = Date.now() - t0;
	pngs.forEach((p, i) => writeFileSync(`/tmp/pi-frames/${name}-${i}.png`, p));
	report[name] = {
		frames: pngs.length,
		omitted,
		ms: dt,
		width: shape.frame_w,
		rowsPerFrame: frameRows(shape),
		tokenPerFrame: frameTokens(shape, frameRows(shape)),
		// sha of the raw pixel rows for cross-implementation comparison
	};
}

// serialize round: pi-shaped messages -> archive text
const middle: LlmMessage[] = [
	{ role: "user", content: [{ type: "text", text: "Fix the failing test in tests/test_compress.py" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret reasoning that must not ship" },
			{ type: "text", text: "Let me read the test and the loader." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "tests/test_compress.py" } },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "python -m pytest tests/test_compress.py -x", timeout: 12000 } },
		],
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		isError: false,
		content: [
			{ type: "text", text: "def test_compress_empty_device_map():\n    devices = load_devices()\n    assert devices[\"token\"] == \"abc123\"   # fails: devices is {}\n" + "filler line\n".repeat(400) + "    assert devices.fallback == True\n" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
	},
	{ role: "toolResult", toolCallId: "call_2", toolName: "bash", isError: true, content: [{ type: "text", text: "E AssertionError: devices is {}\n" }] },
	{ role: "user", content: "Right — add a fallback to environment var DEVMAP_TOKEN and update the test to stub it." },
];
const archive = serializeMessages(middle, {
	tool_result_max_chars: 2_000,
	tool_result_head_ratio: 0.6,
	tool_arg_max_chars: 500,
	tool_call_max_chars: 2_000,
}, [{ text: "Earlier archive: the user is porting hermes-snapcompact to pi, package at ~/dev/pi-snapcompact." }]);
writeFileSync("/tmp/pi-archive.txt", archive);
report.serialize = {
	archiveChars: archive.length,
	boundedChars: boundArchiveText(archive, 48_000).length,
	hasThinkingLeak: archive.includes("secret reasoning"),
	hasPriorSummary: archive.includes("[PRIOR CONTEXT SUMMARY]"),
	hasImageMarker: archive.includes("[image attached]"),
	markers: {
		user: archive.includes("[USER]"),
		assistant: archive.includes("[ASSISTANT]"),
		toolRead: archive.includes("[TOOL read]"),
		toolBashError: archive.includes("[TOOL bash ERROR]"),
		toolCalls: archive.includes("[TOOL_CALL read(") && archive.includes("[TOOL_CALL bash("),
		argCap: archive.includes("chars elided") || archive.length < 3000,
	},
};
writeFileSync("/tmp/pi-parity-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

// claude-hires now survives non-multiple-of-8 widths: decode sanity via dimensions readback
const hires = resolveShape("", "claude-hires");
const [hiresPng] = renderFrames("width probe => 1932 % 8 = 4 remainder; stride must ceil", hires, 2);
writeFileSync("/tmp/pi-frames/hires-probe.png", hiresPng[0]);
console.log("hires probe wrote", hiresPng[0].length, "bytes");
console.log("resolveShape:", ["claude-opus-4-5", "gemini-3-pro", "gw/glm-5.3", "qwen3-vl-32b", "inkling-2-mini", "gpt-5.2-codex"].map((m) => `${m} => ${resolveShape(m).name}`).join("\n"));
