/**
 * Per-model frame shapes for snapcompact (pi port).
 *
 * Ported from hermes-snapcompact shapes.py, which mirrors omp's snapcompact shape
 * table: glyph advance (px per char), leading (px per line), frame width, and an
 * image-token billing model per provider family. Glyphs are 8x16 Unifont bitmaps
 * (8 px wide, 16 px tall); wide (CJK etc.) glyphs span two cells.
 *
 * Frame height "hugs the rows actually printed": a frame is exactly
 * `rows * leading` pixels tall, never padded to a square.
 */

export const GLYPH_W = 8;
export const GLYPH_H = 16;

export interface Shape {
	name: string;
	/** px per narrow char */
	advance: number;
	/** px per line */
	leading: number;
	/** frame width in px */
	frame_w: number;
	/** billing model key */
	token_model: string;
}

export function frameCols(shape: Shape): number {
	return Math.floor(shape.frame_w / shape.advance);
}

export function frameRows(shape: Shape): number {
	// Frame height never exceeds its width (square-ish cap, like the reference).
	return Math.floor(shape.frame_w / shape.leading);
}

const tokensAnthropic = (w: number, h: number): number => Math.min(Math.trunc((w * h) / 750), 4_784);
const tokensGoogle = (_w: number, _h: number): number => 1_120;
const tokensOpenai = (w: number, h: number): number => 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
// 28px vision patches with 2x2 token merge (GLM-V style); documented estimate.
const tokensPatch28 = (w: number, h: number): number => Math.max(1, Math.floor(Math.floor(w / 28) * Math.floor(h / 28) / 4));

const TOKEN_MODELS: Record<string, (w: number, h: number) => number> = {
	anthropic: tokensAnthropic,
	google: tokensGoogle,
	openai: tokensOpenai,
	patch28: tokensPatch28,
	generic: tokensAnthropic,
};

/** Estimated billed tokens for a frame holding `rows` text lines. */
export function frameTokens(shape: Shape, rows: number): number {
	const w = shape.frame_w;
	const h = Math.max(rows, 1) * shape.leading;
	const fn = TOKEN_MODELS[shape.token_model] ?? tokensAnthropic;
	return fn(w, h);
}

interface BaseShapeSpec {
	advance: number;
	leading: number;
	frame_w: number;
	token_model: string;
	name: string;
}

const SHAPE_SPECS: Record<string, BaseShapeSpec> = {
	// Anthropic: X.org-style 8-wide glyphs on an 11px advance, 16px leading.
	claude: { name: "claude", advance: 11, leading: 16, frame_w: 1_568, token_model: "anthropic" },
	// High-res Claude lines: wider frames under the 4,784 visual-token cap.
	"claude-hires": { name: "claude-hires", advance: 11, leading: 16, frame_w: 1_932, token_model: "anthropic" },
	// Gemini: extra leading (22px), 2048px frames, fixed per-image budget.
	gemini: { name: "gemini", advance: 8, leading: 22, frame_w: 2_048, token_model: "google" },
	// GPT / Codex and the OpenAI-compatible default: 8on22 at 1568px.
	openai: { name: "openai", advance: 8, leading: 22, frame_w: 1_568, token_model: "openai" },
	// GLM / Kimi: 8-wide glyphs on a 16px pitch at 1568px (patch billing).
	glm: { name: "glm", advance: 8, leading: 16, frame_w: 1_568, token_model: "patch28" },
	// Qwen-VL and other 28px-patch local servers.
	patch28: { name: "patch28", advance: 8, leading: 16, frame_w: 1_568, token_model: "patch28" },
};

export const SHAPE_NAMES = Object.keys(SHAPE_SPECS).sort();

const HIRES_MARKERS = ["opus-4.7", "opus4.7", "opus-5", "opus5", "fable", "mythos"];

function specToShape(spec: BaseShapeSpec): Shape {
	return { ...spec };
}

/**
 * Pick the eval-optimal shape for a model id (matches on the id, not the provider:
 * a Claude routed through a gateway keeps the Claude shape).
 */
export function resolveShape(model: string, forced = "auto"): Shape {
	if (forced && forced !== "auto") {
		const spec = SHAPE_SPECS[forced];
		if (!spec) {
			throw new Error(`unknown snapcompact shape '${forced}' (known: ${SHAPE_NAMES.join(", ")})`);
		}
		return specToShape(spec);
	}
	const m = (model || "").toLowerCase();
	if (m.includes("claude") || m.includes("anthropic")) {
		return specToShape(SHAPE_SPECS[HIRES_MARKERS.some((t) => m.includes(t)) ? "claude-hires" : "claude"]);
	}
	if (m.includes("gemini")) {
		return specToShape(SHAPE_SPECS.gemini);
	}
	if (["glm", "zhipu", "chatglm", "kimi", "moonshot"].some((k) => m.includes(k))) {
		return specToShape(SHAPE_SPECS.glm);
	}
	if (["qwen", "internvl", "minicpm"].some((k) => m.includes(k))) {
		return specToShape(SHAPE_SPECS.patch28);
	}
	return specToShape(SHAPE_SPECS.openai);
}
