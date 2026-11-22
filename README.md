# pi-snapcompact

Bitmap-frame context compression for [pi](https://github.com/earendil-works/pi) — a
port of the `hermes-snapcompact` Hermes plugin (and namesake of omp's snapcompact
strategy).

Instead of asking a summarizer LLM to paraphrase the discarded middle of a
conversation, the middle is **serialized to bounded dense text, rasterized onto
model-shaped 1-bit PNG frames of 8x16 pixel glyphs, and handed back to the
vision-capable model as image parts on the compaction summary row**. The pass is
local, deterministic and LLM-free — so it is also safe for overflow recovery.

A page-sized 1-bit PNG of monospaced pixel text bills at a small fraction of the
tokens the same text would cost as plain context (e.g. ~2–4k tokens worth of text
per 1120-token Gemini image or ~1.6k-token Claude frame), while staying an *exact
record* the model can re-read like text, not a lossy summary.

```
compacted middle ──serialize──▶ bounded dense text ──rasterize──▶ 1-bit PNG frames
                                                                       │
LLM context  ◀── user-role summary row with image parts ───────────────┘
```

## Install

```bash
pi install ~/dev/pi-snapcompact
```

Local packages load from the resolved path without copying and are **never touched
by `pi update` / `pi update self` / `pi update --extensions`** — pi only reconciles
npm and git sources, so a local install survives every kind of update.

Verify:

```bash
pi list                # shows ~/dev/pi-snapcompact
pi -e ~/dev/pi-snapcompact   # try without installing
```

Inside pi, `/snapcompact` prints the resolved shape, vision capability, frame
cache, and the outcome of the last compaction pass.

## How it hooks pi

| Hook | Role |
|------|------|
| `session_before_compact` | Replaces the summarizer: middle → bounded archive text → PNG frames; returns a custom compaction whose `details` carry the durable bounded archive. No LLM call. |
| `context` | Rebuilds the `compactionSummary` row as a user message carrying the summary text plus the frame images, before every LLM call. The persisted transcript and the TUI display are untouched. |
| `/snapcompact` | Status command. |

Frames are re-rendered deterministically from the durable archive text whenever
they are missing from the in-memory stash (resume, fork, tree navigation, model
switch) — same text + shape ⇒ same bytes.

## Fallback ladder

1. **Vision model** → bitmap frames, always. No shrink-gate, no text fallback:
   the frames are the exact record, and no LLM summarizer is ever invoked.
2. **No image input** → pass handed to pi's built-in (LLM-summary) compaction,
   exactly as stock pi.

If the active model loses image input after a frames pass, the `context` hook
carries the bounded *text* archive inline instead of a bare lead-in (an
improvement over the Hermes original, which kept only the lead-in until the next
compaction). Legacy v1.x `text_archive` compaction entries rehydrate the same
way: their durable archive text is re-rendered to frames on vision models and
carried inline on non-vision ones.

## Configuration

Under the `snapcompact` key in `~/.pi/agent/settings.json` or project
`.pi/settings.json` (env: `PI_SNAPCOMPACT_<KEY>`):

| Key | Default | Meaning |
|-----|---------|---------|
| `max_frames` | `48` | Cap per compaction; oldest pages are dropped first. |
| `shape` | `auto` | Force a frame shape: `claude`, `claude-hires`, `gemini`, `openai`, `glm`, `patch28`. |
| `assume_vision` | `auto` | Force the vision path on/off regardless of model metadata. |
| `archive_source_max_chars` | `48000` | Bound of the durable archive text kept in `details`. |
| `tool_result_max_chars` | `2000` | Tool result bound (head+tail kept). |
| `tool_result_head_ratio` | `0.6` | Head share of a truncated tool result. |
| `tool_arg_max_chars` | `500` | Per-value cap of tool-call arguments. |
| `tool_call_max_chars` | `2000` | Per-call cap of tool-call arguments. |
| `compact_at_percent` | `100` | Compact when context usage ≥ this % of the **live** window (from `turn_end`). `100` defers to pi's own `reserveTokens` trigger — set it below 100 for window-relative control regardless of which model is active. Pair the model with `reserveTokens: 0` in `compaction.modelOverrides` so the absolute check never fires first. |

Compaction *triggers* (`reserveTokens`, `keepRecentTokens`) stay pi's own — see
pi's compaction docs.

## License & credits

- **Code:** GPL-2.0-or-later (`LICENSE`). A port of
  [hermes-snapcompact](https://github.com/vimona3ds/hermes-snapcompact) by
  vimona3ds — the engine semantics, serializer, layout and billing models come
  from that plugin; this repo reimplements them on pi's extension hooks in
  TypeScript.
- **Font:** the renderer embeds a glyph cache extracted from
  [GNU Unifont](https://mirrors.kernel.org/gnu/unifont/unifont-17.0.04/)
  (GPL-2.0-or-later with the GNU Font Embedding Exception) — see
  `assets/fonts/NOTICE-Unifont`.

## Frame shapes (from the original)

| Shape | Layout | Billing model |
|-------|--------|---------------|
| `claude` / `claude-hires` | 11px advance, 16px leading, 1568/1932px wide | Anthropic `min(w·h/750, 4784)` |
| `gemini` | 8px advance, 22px leading, 2048px wide | Google flat 1120/image |
| `openai` (default) | 8px advance, 22px leading, 1568px wide | OpenAI `85 + 170·⌈w/512⌉·⌈h/512⌉` |
| `glm`, `patch28` | 8px advance, 16px leading, 1568px wide | 28px patches, 2×2 merge |

Shape auto-selection matches the model id: Claude ids get the Claude shape even
when routed through a gateway; Gemini → `gemini`; GLM/Kimi → `glm`; Qwen-VL →
`patch28`; everything else → `openai`.

## Compatibility notes vs. the Hermes original

- Compaction *triggering* remains pi's (`reserveTokens`/`keepRecentTokens`, cut
  points, split-turn handling); the plugin design of hermes subclassed a
  compressor that did this itself. The serializer, rasterizer, shapes, fallback
  ladder, economics gate and durability semantics are ported 1:1.
- Split user-message spans (pi) are folded into the one archive, chronologically.
- Prior archives re-embed from the previous compaction entry's durable bounded
  text (`details`), matching hermes' summary-row archive re-embed.
- The PNG frames are encoded by a purpose-built 1-bit PNG writer (the original
  used PIL); pixel bytes are identical (PRES filtered PackBits-style rows,
  MSB-first), determinism preserved.

## Provenance

Ported from `vimona3ds/hermes-snapcompact` @ `8a274ca` (tier: community, category:
memory) by way of the installed copy at `~/.hermes/hermes-agent/plugins/context_engine/snapcompact`.

The 8x16 glyph set is GNU Unifont — GPL 2+ with the font embedding exception
(`assets/fonts/NOTICE-Unifont`).
