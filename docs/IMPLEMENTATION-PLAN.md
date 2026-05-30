# comfyui-prompt-editor — implementation plan

*Derived from the brainstorm report
`/Users/lgates/repos/laurigates/comfyui-node-ideas.md` (candidate
`comfyui-prompt-editor`, rank #2). A near-exact gallery-loader clone pointed at
the most central field in any workflow.*

## The pain

Every `multiline: True` STRING widget (CLIPTextEncode plus ~31 prompt-semantic
encoders across SD3 / Flux / HiDream / Qwen / Hunyuan) renders as a 1–3 line
on-canvas sliver pinned to the node:

- The soft keyboard covers it; caret/selection in a transform-scaled textarea
  is broken on touch.
- Weighting grammar means hand-typing `()` and a decimal on a number-hostile
  keyboard.
- Embeddings must be typed by exact filename — a typo silently no-ops.
- No token / 77-window counter.
- Multi-encoder nodes stack several tiny textareas in one node.

## Target widgets

Detected by widget **name** + the multiline STRING shape (generic across packs):
`text`, `prompt`, `clip_l`, `clip_g`, `t5xxl`, `llama`, `qwen25_7b`, `bert`,
`mt5xl`, `tags`, `lyrics`, `string`, … (match any widget whose options mark it
multiline, with this name set as the fast path).

## Approach (established pattern)

`app.registerExtension` → `nodeCreated` + `loadedGraphNode` → detect multiline
STRING widgets → add an **expand** affordance / wrap `onPointerDown` → open a
**full-screen HTML textarea modal** via `openModalShell` (16px font,
scroll-into-view above the keyboard, write back on close). Frontend-only, no
Python for v1. Additive; never alters serialized text except by explicit user
action; falls back to the native textarea.

### Toolbar (pure DOM ops on the modal value)

- **Weight**: wrap-selection-in-`()` and ± steppers that rewrite `(word:N.N)`
  per ComfyUI's `comfy/sd1_clip.py` grammar.
- **Embedding insert palette**: fuzzy list, inserts `embedding:<name>` at the
  caret. (Data source deferred — see milestones.)
- **LoRA inserter** (optional): `<lora:name:weight>` at caret.
- **Counter**: live char / word / approx-token + `BREAK`-chunk display.
- **Tabs**: when a node has multiple multiline widgets, present them as tabs in
  one modal.

## Mobile benefit

Turns a keyboard-occluded 2-line sliver into a focused full-screen editor and
replaces the worst-case touch interactions (hand-typed parens and exact
embedding filenames) with big-button insert palettes and steppers.

## Differs from existing packs

pythongosssss Custom-Scripts and comfyui-prompt-control provide desktop
autocomplete/weighting helpers — keyboard-and-mouse oriented, some adding
Python deps. None offers a full-screen mobile editor, touch weight steppers, a
tap-to-insert embedding palette, or tabbed multi-encoder editing.

## Milestones

1. **v0.1 — full-screen editor, frontend-only.** Expand affordance + 16px
   textarea + keyboard-aware scroll + write-back. The single highest-value
   slice; ship it alone.
2. **v0.2 — weight toolbar.** wrap-in-`()` + ± steppers rewriting `(word:N.N)`.
   Pure DOM, no data source needed.
3. **v0.3 — token counter.** char/word/approx-token + BREAK-chunk. Approximate
   tokenization (whitespace + punctuation heuristic); label it approximate.
4. **v0.4 — embedding/LoRA insert palette.** Needs a name source: read from the
   frontend object-info, or add a tiny `folder_paths`-backed endpoint (the one
   place this pack might gain a Python backend — keep it optional / a companion
   if it would break the frontend-only promise).
5. **v0.5 — tabbed multi-encoder editing.**

## Open decisions

- **Embedding-name source** (v0.4): object-info (frontend-only, may be stale)
  vs a small endpoint (breaks frontend-only). Prefer frontend-only; fall back
  to an opt-in companion endpoint only if object-info proves insufficient.
- **Token counter accuracy**: ship an approximate counter (no tokenizer in the
  browser) and say so, vs. an endpoint that runs the real CLIP tokenizer.
  Start approximate.
- **Expand affordance**: intercept `onPointerDown` (consistent with the family)
  vs. an explicit ⤢ button widget (more discoverable). Likely both — button as
  the Strategy-B safety net.

## References

- Brainstorm report: `../comfyui-node-ideas.md` (row: prompt-editor #2).
- Weighting grammar: ComfyUI `comfy/sd1_clip.py`.
- Pattern reference packs: `../comfyui-gallery-loader` (`modal-shell.js`), `../comfyui-sampler-info`.
- taskwarrior: `project:comfyui-nodes` task 152.
