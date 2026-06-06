// Prompt Editor — ComfyUI frontend extension.
//
// Built to /extensions/comfyui-prompt-editor/dist/index.js — the pack
// directory name IS this URL segment. Do not rename the pack dir without
// syncing EXT_NAME below (used for log prefixes).
//
// Pattern (shared with gallery-loader / sampler-info):
//   registerExtension -> enhance each node (on create AND on graph load) ->
//   detect multiline STRING widgets BY NAME / by the multiline option flag ->
//   wrap widget.onPointerDown (Strategy A) AND add an explicit ⤢ expand button
//   widget (Strategy B) -> open a full-viewport HTML textarea modal instead of
//   editing the keyboard-occluded on-canvas sliver. Additive + mobile-first:
//   always chain to the original handler, write back only on explicit confirm,
//   and fall back to the native textarea on dismiss / error.
//   Requires the modern Vue frontend's onPointerDown hook
//   (comfyui-frontend-package >= 1.40) for Strategy A; Strategy B is the
//   version-skew safety net.
//
// v0.1 scope: the full-screen editor only. The weight ± stepper is included
// because it is a pure DOM op on the textarea (came for free). The weight
// toolbar proper, token counter, embedding palette, and tabbed multi-encoder
// editing are v0.2+.
//
// The modal-shell primitive is consumed from @laurigates/comfy-modal-kit
// (bundled INLINE into the build output). The fzf-lite fuzzy matcher also
// lives in the kit, reserved for the v0.4 embedding palette. See ADR-0011.

import { openModalShell } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-prompt-editor";
const STYLE_ID = "pe-style";

// ============================================================
// Types
// ============================================================
//
// The `@comfyorg/comfyui-frontend-types` package types `app` via the shim in
// comfyui-shims.d.ts, but does not re-export the LiteGraph widget/node shapes
// this pack reaches into. We model the small touched surface with local
// structural interfaces (the "local interface extension — narrower blast
// radius" approach), keeping the seam narrow.

interface PromptWidget {
  name?: string;
  type?: string;
  value?: unknown;
  options?: {
    multiline?: boolean;
    values?: unknown[];
    [key: string]: unknown;
  };
  inputEl?: { tagName?: string; value?: string } | null;
  callback?: (value: string, canvas: unknown, node: unknown) => void;
  onPointerDown?: ((pointer: unknown, node: unknown, canvas: unknown) => unknown) | undefined;
  // Idempotency guards stamped on the widget so each strategy applies once.
  _promptEditorPointerPatched?: boolean;
  _promptEditorButtonAdded?: boolean;
}

interface PromptNode {
  widgets?: PromptWidget[];
  setDirtyCanvas?: (fg: boolean, bg: boolean) => void;
  addWidget?: (
    type: string,
    name: string,
    value: unknown,
    callback: () => void,
    options?: Record<string, unknown>,
  ) => PromptWidget | undefined;
}

// ============================================================
// Widget detection — generic across node packs
// ============================================================
//
// A target is a multiline STRING widget. ComfyUI builds these from an input
// spec of `("STRING", {"multiline": True})`; the resulting widget exposes
// `options.multiline === true` and renders a DOM <textarea> as `inputEl`.
// We accept either signal so the pack works across frontend version skews:
//   - options.multiline truthy (the canonical marker), OR
//   - a DOM textarea inputEl (the rendered shape), OR
//   - the widget type is the multiline STRING widget ("customtext").
// The name fast-path is an additional accept, but never the sole gate — we
// still require the widget to look like editable text, never a combo/number.

// Name fast-path: widgets known to carry prompt-semantic multiline text across
// the SD3 / Flux / HiDream / Qwen / Hunyuan encoder zoo. Detection is NOT
// limited to this set — any multiline STRING widget qualifies (see
// isMultilineStringWidget). The set only short-circuits the common case and
// documents intent.
export const TARGET_WIDGET_NAMES = new Set<string>([
  "text",
  "prompt",
  "clip_l",
  "clip_g",
  "t5xxl",
  "llama",
  "qwen25_7b",
  "bert",
  "mt5xl",
  "tags",
  "lyrics",
  "string",
  "positive",
  "negative",
  "wildcard_text",
]);

export function isMultilineStringWidget(w: unknown): boolean {
  if (!w || typeof w !== "object") return false;
  const widget = w as PromptWidget;
  // Exclude combos and anything backed by a fixed value list (e.g. samplers).
  if (Array.isArray(widget.options?.values)) return false;

  const opts = widget.options ?? {};
  const isTextarea =
    !!widget.inputEl &&
    typeof widget.inputEl.tagName === "string" &&
    widget.inputEl.tagName.toUpperCase() === "TEXTAREA";
  const typeStr = typeof widget.type === "string" ? widget.type.toLowerCase() : "";
  const looksMultiline = opts.multiline === true || isTextarea || typeStr === "customtext";
  if (!looksMultiline) return false;

  // Value must be string-like (or absent → defaults to "") to be editable text.
  if (widget.value != null && typeof widget.value !== "string") return false;

  // Name fast-path is a bonus signal, but a genuinely multiline string widget
  // with an unknown name still qualifies — detection stays generic.
  return true;
}

/**
 * Decide whether `w` is a widget the prompt editor should enhance.
 *
 * Two accept paths, both gated so a combo / number widget never matches:
 *   1. Generic: `isMultilineStringWidget(w)` — the canonical, name-agnostic
 *      signal (multiline option, textarea inputEl, or "customtext" type).
 *   2. Name fast-path: the widget name is in `TARGET_WIDGET_NAMES` AND it
 *      carries a string value AND it is not a combo (fixed `options.values`).
 *      This catches a prompt widget on a frontend skew where none of the
 *      multiline signals are exposed yet, without ever matching a sampler /
 *      seed combo that happens to be named in the set.
 *
 * Pure: inspects the widget object only — no DOM mutation, no side effects.
 * This is the generic-across-node-packs contract, so it is unit-tested.
 */
export function isTargetWidget(w: unknown): boolean {
  if (!w || typeof w !== "object") return false;
  const widget = w as PromptWidget;
  if (isMultilineStringWidget(widget)) return true;
  // Name fast-path: must be string-valued and must not be a combo.
  if (typeof widget.name !== "string" || !TARGET_WIDGET_NAMES.has(widget.name)) return false;
  if (Array.isArray(widget.options?.values)) return false;
  return typeof widget.value === "string";
}

// ============================================================
// Pure helpers (unit-tested in tests/js/)
// ============================================================

export interface WeightResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/**
 * Adjust the ComfyUI prompt weight of `text`, optionally restricted to the
 * substring [selStart, selEnd). Implements the `(token:weight)` grammar from
 * ComfyUI's comfy/sd1_clip.py:
 *   - bare text         -> wrap in `(text:1.1)` (or 0.9 when stepping down)
 *   - `(text:N.N)`      -> rewrite N.N by `delta`, clamped to [0, 2], 1-decimal
 *   - `(text)`          -> treated as weight 1.1 (LiteGraph implicit emphasis)
 *
 * With no real selection (a bare caret, `selStart === selEnd`), the range is
 * expanded to the "inner word": the run of non-delimiter characters the caret
 * sits in, where delimiters are whitespace and commas. This lets a user weight
 * the token their caret is in without selecting it. Parentheses are NOT
 * delimiters, so a caret inside `(cat:1.1)` expands over the whole weighted
 * token and rewrites its weight in place. When the caret isn't inside a word
 * (e.g. it sits in whitespace), it falls back to the whole value so an empty
 * prompt or a between-words nudge still does something sensible.
 *
 * Returns { text, selStart, selEnd } with the selection re-anchored over the
 * (possibly re-wrapped) token so repeated steps keep operating on it.
 *
 * Pure: no DOM, no side effects. The modal calls this then writes the result
 * back into the textarea and restores the selection.
 */
export function bumpWeight(
  text: string,
  selStart: number,
  selEnd: number,
  delta: number,
): WeightResult {
  const src = typeof text === "string" ? text : "";
  let a = Number.isInteger(selStart) ? selStart : 0;
  let b = Number.isInteger(selEnd) ? selEnd : src.length;
  if (a > b) [a, b] = [b, a];
  a = Math.max(0, Math.min(a, src.length));
  b = Math.max(0, Math.min(b, src.length));

  // No real selection (a bare caret, or a whitespace-only range) → expand to the
  // "inner word": the run of non-delimiter characters around the caret, so the
  // user can weight the token their caret is in without selecting it. Delimiters
  // are whitespace and commas; parentheses are intentionally NOT delimiters, so
  // a caret inside `(cat:1.1)` expands over the whole weighted token. Falls back
  // to the whole value when the caret isn't inside a word (e.g. in whitespace),
  // preserving the original whole-prompt nudge.
  let frag = src.slice(a, b);
  if (frag.trim() === "") {
    const isDelim = (ch: string | undefined): boolean => ch === undefined || /[\s,]/.test(ch);
    // Collapse a whitespace-only range to its start so we expand from one caret.
    let ws = a;
    let we = a;
    while (ws > 0 && !isDelim(src[ws - 1])) ws--;
    while (we < src.length && !isDelim(src[we])) we++;
    if (src.slice(ws, we).trim() !== "") {
      a = ws;
      b = we;
    } else {
      a = 0;
      b = src.length;
    }
    frag = src.slice(a, b);
  }

  // Empty/whitespace-only value → no token to weight; leave it untouched.
  if (frag.trim() === "") {
    return { text: src, selStart: a, selEnd: b };
  }

  const clamp = (n: number): number => Math.max(0, Math.min(2, n));
  const fmt = (n: number): string => {
    // 1 decimal place, no trailing-zero noise beyond one digit ("1.0", "1.1").
    const r = Math.round(clamp(n) * 10) / 10;
    return r.toFixed(1);
  };

  // Match an already-weighted token: ( inner : weight ) with optional spaces.
  const weighted = frag.match(/^\s*\((.*):\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/s);
  // Match an implicitly-emphasised token: ( inner ) — LiteGraph weight 1.1.
  const emphasised = !weighted && frag.match(/^\s*\((.*)\)\s*$/s);

  let inner: string;
  let baseWeight: number;
  if (weighted) {
    inner = weighted[1] ?? "";
    baseWeight = Number.parseFloat(weighted[2] ?? "1");
  } else if (emphasised) {
    inner = emphasised[1] ?? "";
    baseWeight = 1.1;
  } else {
    inner = frag;
    baseWeight = 1.0;
  }

  const next = clamp(baseWeight + delta);
  // Stepping a bare token down from 1.0 should read as 0.9, not 1.0 - 0.1
  // rounding noise; fmt() already handles that. Re-wrap with the new weight.
  const replacement = `(${inner}:${fmt(next)})`;
  const out = src.slice(0, a) + replacement + src.slice(b);
  return { text: out, selStart: a, selEnd: a + replacement.length };
}

// ============================================================
// Modal CSS (pack-specific; modal-shell injects its own .cmp-* styles)
// ============================================================

const CSS = `
.pe-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
}
.pe-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
}
.pe-btn {
    /* >=44px tap target; 16px text avoids iOS zoom. */
    min-height: 44px;
    min-width: 44px;
    padding: 0 14px;
    background: #2a2a36;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    font-size: 16px;
    font-family: inherit;
    cursor: pointer;
    line-height: 1;
    touch-action: manipulation;
}
.pe-btn:hover {
    background: #34343f;
}
.pe-btn:active {
    background: #3f3f4d;
}
.pe-btn-primary {
    background: #2f5fae;
    border-color: #3a6ec0;
    color: #fff;
    font-weight: 600;
    margin-left: auto;
}
.pe-btn-primary:hover {
    background: #366ac0;
}
.pe-textarea {
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    min-height: 220px;
    resize: vertical;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ea;
    padding: 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    line-height: 1.5;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    outline: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
}
.pe-textarea:focus {
    border-color: #6ba6ff;
}
.pe-hint {
    color: #888;
    font-size: 12px;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ============================================================
// Write-back — additive, only on explicit confirm
// ============================================================
//
// Mirrors the gallery-loader applyValue() contract: set widget.value, sync the
// DOM textarea (inputEl) so the canvas shows the change before redraw, fire the
// widget's own callback so downstream listeners (serialization, linked widgets)
// see the new value, then mark the canvas dirty. We never write on dismiss, so
// a cancelled edit leaves the serialized workflow byte-for-byte unchanged.

function applyValue(widget: PromptWidget, node: PromptNode | null, value: string): void {
  if (typeof value !== "string") return;
  widget.value = value;
  if (widget.inputEl && typeof widget.inputEl.value === "string") {
    widget.inputEl.value = value;
  }
  try {
    widget.callback?.call(widget, value, app.canvas, node);
  } catch (e) {
    console.warn(`[${EXT_NAME}] widget callback threw`, e);
  }
  node?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

// ============================================================
// Modal — full-viewport textarea editor
// ============================================================

function openEditor(
  widget: PromptWidget,
  node: PromptNode | null,
): ReturnType<typeof openModalShell> {
  ensureStyle();

  const initial = typeof widget?.value === "string" ? widget.value : "";

  const wrap = document.createElement("div");
  wrap.className = "pe-wrap";

  // Toolbar: weight steppers (free pure-DOM op) + a hint. The weight toolbar
  // proper is v0.2; these two steppers are all that comes for free here.
  const bar = document.createElement("div");
  bar.className = "pe-bar";

  const makeBtn = (label: string, title: string, cls?: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `pe-btn${cls ? ` ${cls}` : ""}`;
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };

  const downBtn = makeBtn("weight −", "Decrease weight of selection (or the word at the caret)");
  const upBtn = makeBtn("weight +", "Increase weight of selection (or the word at the caret)");
  const hint = document.createElement("span");
  hint.className = "pe-hint";
  hint.textContent = "select a token, or just place the caret in a word, then weight ±";

  bar.append(downBtn, upBtn, hint);

  const textarea = document.createElement("textarea");
  textarea.className = "pe-textarea";
  textarea.value = initial;
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("autocorrect", "off");

  wrap.append(bar, textarea);

  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    try {
      // Only churn the widget when the text actually changed.
      if (textarea.value !== initial) {
        applyValue(widget, node, textarea.value);
      }
    } catch (e) {
      console.warn(`[${EXT_NAME}] write-back failed`, e);
    }
    modal.close();
  };

  const stepWeight = (delta: number): void => {
    try {
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const res = bumpWeight(textarea.value, start, end, delta);
      textarea.value = res.text;
      textarea.focus();
      textarea.setSelectionRange(res.selStart, res.selEnd);
    } catch (e) {
      console.warn(`[${EXT_NAME}] weight step failed`, e);
    }
  };
  downBtn.addEventListener("click", () => stepWeight(-0.1));
  upBtn.addEventListener("click", () => stepWeight(0.1));

  const modal = openModalShell({
    title: "Edit prompt",
    subtitle: widget?.name,
    // No fuzzy search row — this is a free-text editor, not a picker.
    showSearch: false,
    showFooter: true,
    // Full-viewport on mobile; generous on desktop.
    width: "min(960px, calc(100vw - 16px))",
    height: "min(92vh, 900px)",
    footerLeftHTML: '<span class="pe-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>',
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    },
    // onClose fires for BOTH the save button and a dismiss (Esc / backdrop).
    // If we never committed, this was a cancel → leave the widget untouched.
    onClose: () => {},
  });

  // modal-shell's contract: the consumer fills `modal.bodyEl` AFTER the shell
  // is opened (there is no `body` option — see openModalShell's opts). Mirror
  // gallery-loader's `modal.bodyEl.appendChild(...)`. Without this the dialog
  // renders empty.
  modal.bodyEl.appendChild(wrap);

  // A primary "Save" action: the shell's toolbar/search row is for pickers, so
  // append the Save button into our own toolbar row (already inside `wrap`).
  const saveBtn = makeBtn("Save", "Save (Cmd/Ctrl+Enter)", "pe-btn-primary");
  saveBtn.addEventListener("click", commit);
  bar.appendChild(saveBtn);

  // Seed selection at the end and lift the textarea above the soft keyboard.
  // Defer past the opening tap so iOS doesn't fight the focus, mirroring
  // modal-shell's own deferred search focus.
  requestAnimationFrame(() => {
    try {
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
      // Scroll the editor into view above the mobile keyboard.
      textarea.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      console.warn(`[${EXT_NAME}] focus/scroll failed`, e);
    }
  });

  return modal;
}

// ============================================================
// Wiring
// ============================================================

function enhanceNode(node: PromptNode | null): void {
  if (!node?.widgets) return;
  for (const w of node.widgets) {
    // Generic multiline-string detection OR the name fast-path — both gated so
    // a combo / number widget never matches (see isTargetWidget).
    if (!isTargetWidget(w)) continue;

    // Strategy A: wrap onPointerDown. Chain the original first; only open our
    // editor if the original didn't consume the event.
    if (!w._promptEditorPointerPatched) {
      w._promptEditorPointerPatched = true;
      const origDown = w.onPointerDown;
      w.onPointerDown = function (
        this: PromptWidget,
        pointer: unknown,
        ownerNode: unknown,
        canvas: unknown,
      ): unknown {
        try {
          if (typeof origDown === "function") {
            const consumed = origDown.call(this, pointer, ownerNode, canvas);
            if (consumed) return consumed;
          }
          openEditor(w, (ownerNode as PromptNode) || node);
          return true; // consume — suppress the native sliver edit
        } catch (e) {
          console.warn(`[${EXT_NAME}] editor open failed`, e);
          return false; // fall back to native textarea on error
        }
      };
    }

    // Strategy B safety net: an explicit ⤢ expand button widget keeps the
    // editor reachable even if a future frontend drops the onPointerDown hook.
    // serialize:false so it never enters the saved workflow. Guard so we add at
    // most one button per target widget.
    if (!w._promptEditorButtonAdded) {
      w._promptEditorButtonAdded = true;
      try {
        const btn = node.addWidget?.(
          "button",
          `⤢ ${w.name}`,
          null,
          () => {
            try {
              openEditor(w, node);
            } catch (e) {
              console.warn(`[${EXT_NAME}] open from button failed`, e);
            }
          },
          { serialize: false },
        );
        // Drop the expand button just after its target widget for proximity.
        if (btn && node.widgets) {
          const targetIdx = node.widgets.indexOf(w);
          const btnIdx = node.widgets.indexOf(btn);
          if (targetIdx !== -1 && btnIdx !== -1 && btnIdx !== targetIdx + 1) {
            node.widgets.splice(btnIdx, 1);
            node.widgets.splice(targetIdx + 1, 0, btn);
          }
        }
        node.setDirtyCanvas?.(true, true);
      } catch (e) {
        console.warn(`[${EXT_NAME}] addWidget(button) failed`, e);
      }
    }
  }
}

function refreshAllNodes(): void {
  const graph = app?.graph as unknown as { _nodes?: PromptNode[] } | undefined;
  if (!graph?._nodes) return;
  for (const node of graph._nodes) enhanceNode(node);
}

app.registerExtension({
  name: "comfy.prompt-editor",
  async setup() {
    refreshAllNodes();
  },
  // Handle freshly created nodes AND nodes restored from a saved graph.
  async nodeCreated(node: unknown) {
    enhanceNode(node as PromptNode);
  },
  async loadedGraphNode(node: unknown) {
    enhanceNode(node as PromptNode);
  },
});
