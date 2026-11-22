/**
 * GNU Unifont 8x16 glyph cache for snapcompact (pi port).
 *
 * Ported from hermes-snapcompact glyphs.py. Glyphs are pre-extracted from
 * `unifont-17.0.04.bdf` (GNU GPLv2+ with the font embedding exception; see
 * NOTICE-Unifont) into a compact binary: `SCF1` magic, u32 glyph count, then
 * per glyph u32 codepoint, u8 width, u8 height, followed by
 * `(width / 8) * height` bytes of MSB-first packed bitmap rows.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GLYPH_FALLBACK_W = 8;

const FALLBACK_CPS = [0x3f, 0x20]; // '?' then space

type Glyph = { width: number; rows: Uint8Array };

let cache: Map<number, Glyph> | null = null;

function fontPath(): string {
	// Resolve next to the compiled module; overridable for tests.
	const here = dirname(fileURLToPath(import.meta.url));
	return process.env.SNAPCOMPACT_FONT_PATH || join(here, "..", "assets", "fonts", "unifont16.bin");
}

function load(): Map<number, Glyph> {
	if (cache) return cache;
	const data = new Uint8Array(readFileSync(fontPath()));
	const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
	if (magic !== "SCF1") {
		throw new Error("unifont16.bin: bad magic");
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const count = view.getUint32(4, true);
	const glyphs = new Map<number, Glyph>();
	let off = 8;
	for (let i = 0; i < count; i++) {
		const cp = view.getUint32(off, true);
		const w = data[off + 4];
		const h = data[off + 5];
		off += 6;
		const rowBytes = w / 8;
		const nbytes = rowBytes * h;
		glyphs.set(cp, { width: w, rows: data.slice(off, off + nbytes) });
		off += nbytes;
	}
	cache = glyphs;
	return glyphs;
}

/** Cell width in px for `ch`: 8 for narrow glyphs, 16 for wide (CJK) ones. */
export function glyphWidth(ch: string): number {
	const entry = load().get(ch.codePointAt(0) ?? 0);
	return entry ? entry.width : GLYPH_FALLBACK_W;
}

/**
 * Bitmap for `ch` as `{widthPx, rows}` with MSB-first packed rows.
 *
 * Missing codepoints fall back to '?' then space; a truly empty font returns a
 * blank 8px glyph so rendering never raises.
 */
export function glyph(ch: string): { widthPx: number; rows: Uint8Array } {
	const glyphs = load();
	const cp = ch.codePointAt(0) ?? 0;
	let entry = glyphs.get(cp);
	if (!entry) {
		for (const fallback of FALLBACK_CPS) {
			entry = glyphs.get(fallback);
			if (entry) break;
		}
	}
	if (!entry) {
		return { widthPx: 8, rows: new Uint8Array(16) };
	}
	return { widthPx: entry.width, rows: entry.rows };
}

export function fontGlyphCount(): number {
	return load().size;
}
