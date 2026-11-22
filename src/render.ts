/**
 * Text -> PNG frame rasterizer for snapcompact (pi port).
 *
 * Ported from hermes-snapcompact render.py. Deterministic, local, no network:
 * normalized text is word-wrapped to the shape's column count, paginated into
 * frames that hug their rows, and rasterized as 1-bit black-on-white PNGs from
 * 8x16 Unifont glyph bitmaps. Same text + shape => same bytes, so repeated
 * compactions are stable.
 *
 * The Python original encoded PNGs via PIL; this port emits the 1-bit PNG
 * directly (node:zlib deflate, CRC-32 chunks) with byte-identical pixel data.
 */

import { deflateSync } from "node:zlib";
import { glyph, glyphWidth } from "./glyphs.ts";
import { GLYPH_H, type Shape } from "./shapes.ts";

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const PARA_BLOCK = "\u2588".repeat(16); // full-block paragraph separator line

/** Strip ANSI, expand tabs, fold blank-line runs into a visible block line. */
export function normalizeText(text: string): string {
	const stripped = text.replace(ANSI_RE, "").replace(/\r/g, "").replace(/\t/g, "    ");
	const lines: string[] = [];
	let blankRun = 0;
	for (const line of stripped.split("\n")) {
		if (!line.trim()) {
			blankRun += 1;
			if (blankRun === 2) {
				lines.push(PARA_BLOCK);
			}
			continue;
		}
		blankRun = 0;
		lines.push(line.replace(/\s+$/g, ""));
	}
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	return lines.join("\n");
}

function charCells(ch: string): number {
	return glyphWidth(ch) > 8 ? 2 : 1;
}

function lineCells(line: string): number {
	let n = 0;
	for (const ch of line) n += charCells(ch);
	return n;
}

/** Greedy word wrap with hard-break fallback for overlong tokens. */
function wrap(text: string, cols: number): string[] {
	const rows: string[] = [];
	for (const logical of text.split("\n")) {
		if (lineCells(logical) <= cols) {
			rows.push(logical);
			continue;
		}
		let cur = "";
		let curCells = 0;
		for (const token of logical.split(" ")) {
			const tokenCells = lineCells(token);
			const sepCells = cur ? lineCells(" ") : 0;
			if (cur && curCells + sepCells + tokenCells <= cols) {
				cur += " " + token;
				curCells += sepCells + tokenCells;
				continue;
			}
			if (cur) {
				rows.push(cur);
				cur = "";
				curCells = 0;
			}
			if (tokenCells <= cols) {
				cur = token;
				curCells = tokenCells;
				continue;
			}
			// Hard-break the token cell by cell.
			let piece = "";
			let pieceCells = 0;
			for (const ch of token) {
				const chCells = charCells(ch);
				if (pieceCells + chCells > cols) {
					rows.push(piece);
					piece = "";
					pieceCells = 0;
				}
				piece += ch;
				pieceCells += chCells;
			}
			cur = piece;
			curCells = pieceCells;
		}
		if (cur) rows.push(cur);
	}
	return rows;
}

/** OR one glyph's packed rows into the frame buffer at pixel (x, y). */
function blitGlyph(buf: Uint8Array, stride: number, x: number, y: number, gbytes: Uint8Array, gw: number): void {
	const rowBytes = gw / 8;
	for (let r = 0; r < GLYPH_H; r++) {
		const base = (y + r) * stride;
		for (let bi = 0; bi < rowBytes; bi++) {
			const v = gbytes[r * rowBytes + bi];
			if (!v) continue;
			const px = x + bi * 8;
			const byteI = base + (px >> 3);
			const sh = px % 8;
			if (sh === 0) {
				buf[byteI] |= v;
			} else {
				buf[byteI] |= v >>> sh;
				buf[byteI + 1] |= (v << (8 - sh)) & 0xff;
			}
		}
	}
}

// ---- minimal 1-bit grayscale PNG encoder (what PIL did above) ---------------

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
	if (CRC_TABLE) return CRC_TABLE;
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[n] = c >>> 0;
	}
	CRC_TABLE = t;
	return t;
}

function crc32(data: Uint8Array): number {
	const t = crcTable();
	let c = 0xffffffff;
	for (const byte of data) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(out: number[], type: string, data: Uint8Array): void {
	const len = data.length;
	for (let i = 3; i >= 0; i--) out.push((len >>> (i * 8)) & 0xff);
	const typeBytes = Array.from(type, (ch) => ch.charCodeAt(0));
	const crc = crc32(new Uint8Array([...typeBytes, ...data]));
	for (const b of typeBytes) out.push(b);
	for (const b of data) out.push(b);
	for (let i = 3; i >= 0; i--) out.push((crc >>> (i * 8)) & 0xff);
}

/** Encode a 1-bit grayscale PNG (black ink on white) from packed MSB-first rows. */
export function encodePng1bit(buf: Uint8Array, width: number, height: number): Uint8Array {
	const stride = width >> 3; // buf already holds exactly one packed row per image row
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter type 0 per scanline
		raw.set(buf.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const ihdr = new Uint8Array(13);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, width);
	ihdrView.setUint32(4, height);
	ihdr[8] = 1; // bit depth
	ihdr[9] = 0; // color type: grayscale
	// compression (10), filter (11), interlace (12) all 0

	const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	chunk(out, "IHDR", ihdr);
	chunk(out, "IDAT", deflateSync(raw, { level: 9 }));
	chunk(out, "IEND", new Uint8Array(0));
	return new Uint8Array(out);
}

/** Rasterize one page of text rows into a 1-bit PNG (black ink on white). */
export function renderPage(rows: string[], shape: Shape): Uint8Array {
	const width = shape.frame_w;
	const height = Math.max(1, rows.length) * shape.leading;
	const stride = width >> 3;
	const buf = new Uint8Array(stride * height);
	let y = 0;
	for (const line of rows) {
		let x = 0;
		for (const ch of line) {
			const { widthPx: gw, rows: gbytes } = glyph(ch);
			if (x + gw > width) break; // clip: layout should never exceed, but never corrupt memory
			blitGlyph(buf, stride, x, y, gbytes, gw);
			x += gw > 8 ? 16 : shape.advance;
		}
		y += shape.leading;
	}
	return encodePng1bit(buf, width, height);
}

/**
 * Count the frames `text` would occupy for `shape` without rendering.
 *
 * Returns `[frameCount, omittedOldestPages]` — the cheap economics probe the
 * engine runs before committing to the vision path.
 */
export function planFrames(text: string, shape: Shape, maxFrames: number): [number, number] {
	const rows = wrap(normalizeText(text), Math.floor(shape.frame_w / shape.advance));
	const rpf = Math.max(1, Math.floor(shape.frame_w / shape.leading));
	const nPages = Math.ceil(rows.length / rpf);
	if (maxFrames > 0 && nPages > maxFrames) {
		return [maxFrames, nPages - maxFrames];
	}
	return [nPages, 0];
}

/**
 * Lay out `text` for `shape` and render at most `maxFrames` PNGs.
 *
 * Returns `[pngBytesOldestToNewest, omittedOldestPages]`. When the text exceeds
 * the cap the OLDEST pages are dropped (the newest survive), and the count is
 * returned so the summary can say so honestly.
 */
export function renderFrames(text: string, shape: Shape, maxFrames: number): [Uint8Array[], number] {
	const rows = wrap(normalizeText(text), Math.floor(shape.frame_w / shape.advance));
	const rpf = Math.max(1, Math.floor(shape.frame_w / shape.leading));
	const pages: string[][] = [];
	for (let i = 0; i < rows.length; i += rpf) pages.push(rows.slice(i, i + rpf));
	let omitted = 0;
	if (pages.length > maxFrames && maxFrames > 0) {
		omitted = pages.length - maxFrames;
		pages.splice(0, omitted);
	}
	return [pages.map((p) => renderPage(p, shape)), omitted];
}
