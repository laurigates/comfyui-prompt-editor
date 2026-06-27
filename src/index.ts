// Prompt Editor — ComfyUI frontend extension.
//
// Built to /extensions/comfyui-prompt-editor/dist/index.js — the pack
// directory name IS this URL segment. Do not rename the pack dir without
// syncing EXT_NAME below (used for log prefixes).
//
// Pattern (shared with gallery-loader / sampler-info):
//   registerExtension -> enhance each node (on create AND on graph load) ->
//   pin a distinct "⤢ Edit fields" button to the TOP of every node that has
//   editable widgets (the universal entry point), AND wrap onPointerDown on
//   multiline STRING widgets (Strategy A) so tapping the on-canvas sliver opens
//   the editor focused on that field -> open a full-viewport HTML modal instead
//   of editing the keyboard-occluded on-canvas sliver. Additive + mobile-first:
//   always chain to the original handler, write back only on explicit confirm,
//   and fall back to the native control on dismiss / error.
//   Strategy A needs the modern Vue frontend's onPointerDown hook
//   (comfyui-frontend-package >= 1.40); the top button is the version-skew
//   safety net and the entry point on nodes with no text widget at all.
//
// Scope: the modal is an ALL-FIELDS node editor. Tapping any multiline text
// widget (the detection target) opens a touch form with a control for EVERY
// editable widget on the node — multiline + single-line STRING, INT/FLOAT,
// combos, and booleans — with the tapped widget focused. Each multiline field
// keeps its own weight ± steppers. Write-back is per-field and only churns
// widgets whose value actually changed, so a cancelled edit leaves the
// serialized workflow byte-for-byte unchanged.
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
  // Idempotency guard stamped on the widget so the tap interception applies once.
  _promptEditorPointerPatched?: boolean;
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
  // Idempotency guard: the node-level "Edit fields" button is added once.
  _promptEditorNodeButtonAdded?: boolean;
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
// Editable-widget classification — the all-fields form
// ============================================================
//
// The editor edits EVERY editable widget on a node, not just the prompt text.
// We bucket each widget into one of a small set of control kinds so the modal
// can render the right input. Classification is pure (object -> kind), so it is
// unit-tested alongside isTargetWidget.
//
// Buckets:
//   - "multiline" : multiline STRING (textarea + weight steppers)
//   - "text"      : single-line STRING (text input)
//   - "number"    : INT / FLOAT (number input)
//   - "combo"     : fixed values list (select)
//   - "boolean"   : BOOLEAN (toggle)
//   - null        : not editable here (buttons, converted/linked inputs, …)

export type WidgetKind = "multiline" | "text" | "number" | "combo" | "boolean";

export function classifyEditableWidget(w: unknown): WidgetKind | null {
  if (!w || typeof w !== "object") return null;
  const widget = w as PromptWidget & { hidden?: boolean };
  const typeStr = typeof widget.type === "string" ? widget.type.toLowerCase() : "";

  // Skip non-data widgets and widgets converted to graph inputs.
  if (typeStr === "button" || typeStr === "converted-widget") return null;
  if (widget.hidden === true) return null;
  // Our own serialize:false expand button (and any unnamed control) is skipped.
  if (typeof widget.name !== "string" || widget.name === "") return null;

  // A fixed values list marks a combo regardless of value type.
  if (Array.isArray(widget.options?.values)) return "combo";

  // Multiline STRING first — the original prompt-editor target.
  if (isMultilineStringWidget(widget)) return "multiline";

  const val = widget.value;
  if (typeof val === "boolean" || typeStr === "toggle") return "boolean";
  if (typeof val === "number" || typeStr === "number") return "number";
  if (typeof val === "string" || typeStr === "text" || typeStr === "string") return "text";

  return null;
}

// ============================================================
// Modal CSS (pack-specific; modal-shell injects its own .cmp-* styles)
// ============================================================

const CSS = `
.pe-wrap {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 2px;
}
.pe-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.pe-label {
    color: #b8b8c0;
    font-size: 13px;
    font-weight: 600;
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
}
.pe-btn-primary:hover {
    background: #366ac0;
}
.pe-input,
.pe-select {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ea;
    padding: 0 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    touch-action: manipulation;
}
.pe-input:focus,
.pe-select:focus {
    border-color: #6ba6ff;
}
.pe-textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 160px;
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
.pe-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
}
.pe-toggle input {
    width: 24px;
    height: 24px;
    touch-action: manipulation;
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

function applyWidgetValue(widget: PromptWidget, node: PromptNode | null, value: unknown): void {
  widget.value = value;
  // Sync the DOM control (string widgets render a textarea/input via inputEl).
  if (widget.inputEl && typeof widget.inputEl.value === "string" && typeof value === "string") {
    widget.inputEl.value = value;
  }
  try {
    widget.callback?.call(widget, value as string, app.canvas, node);
  } catch (e) {
    console.warn(`[${EXT_NAME}] widget callback threw`, e);
  }
  node?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

// ============================================================
// Field rows — one editable control per widget on the node
// ============================================================
//
// Each field knows how to read its current control value back in the widget's
// native type, so commit() only churns widgets whose value actually changed.

interface FieldRow {
  widget: PromptWidget;
  kind: WidgetKind;
  el: HTMLElement;
  /** Read the control's current value coerced to the widget's native type. */
  read: () => unknown;
  /** Whether the control differs from the widget's value at open time. */
  changed: () => boolean;
  /** Focus this field's primary control (used for the tapped widget). */
  focus: () => void;
}

function makeBtn(label: string, title: string, cls?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pe-btn${cls ? ` ${cls}` : ""}`;
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

function buildField(widget: PromptWidget, kind: WidgetKind): FieldRow {
  const el = document.createElement("div");
  el.className = "pe-field";

  const label = document.createElement("label");
  label.className = "pe-label";
  label.textContent = widget.name ?? "";
  el.appendChild(label);

  if (kind === "boolean") {
    const initial = widget.value === true;
    const row = document.createElement("div");
    row.className = "pe-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = initial;
    const labelText = document.createElement("span");
    labelText.className = "pe-hint";
    const sync = (): void => {
      labelText.textContent = input.checked ? "enabled" : "disabled";
    };
    sync();
    input.addEventListener("change", sync);
    row.append(input, labelText);
    el.appendChild(row);
    return {
      widget,
      kind,
      el,
      read: () => input.checked,
      changed: () => input.checked !== initial,
      focus: () => input.focus(),
    };
  }

  if (kind === "combo") {
    const values = (widget.options?.values as unknown[] | undefined) ?? [];
    const initial = widget.value;
    const select = document.createElement("select");
    select.className = "pe-select";
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = String(v);
      if (v === initial) opt.selected = true;
      select.appendChild(opt);
    }
    el.appendChild(select);
    // Map the chosen option string back to the original-typed list entry.
    const read = (): unknown => {
      const hit = values.find((v) => String(v) === select.value);
      return hit === undefined ? select.value : hit;
    };
    return {
      widget,
      kind,
      el,
      read,
      changed: () => read() !== initial,
      focus: () => select.focus(),
    };
  }

  if (kind === "number") {
    const initial = typeof widget.value === "number" ? widget.value : Number(widget.value) || 0;
    const opts = widget.options ?? {};
    // Integer widget: integer-valued and no fractional step (seed, steps, …).
    const stepOpt = opts.step;
    const isInt =
      Number.isInteger(initial) && (typeof stepOpt !== "number" || Number.isInteger(stepOpt));
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pe-input";
    input.value = String(initial);
    input.inputMode = "decimal";
    if (typeof opts.min === "number") input.min = String(opts.min);
    if (typeof opts.max === "number") input.max = String(opts.max);
    if (typeof opts.step === "number") input.step = String(opts.step);
    el.appendChild(input);
    const read = (): number => {
      const n = Number.parseFloat(input.value);
      if (!Number.isFinite(n)) return initial;
      let v = n;
      if (typeof opts.min === "number") v = Math.max(opts.min, v);
      if (typeof opts.max === "number") v = Math.min(opts.max, v);
      // Preserve integer-valued widgets (seed, steps, …).
      return isInt ? Math.round(v) : v;
    };
    return {
      widget,
      kind,
      el,
      read,
      changed: () => read() !== initial,
      focus: () => input.focus(),
    };
  }

  if (kind === "text") {
    const initial = typeof widget.value === "string" ? widget.value : "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pe-input";
    input.value = initial;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.setAttribute("autocorrect", "off");
    el.appendChild(input);
    return {
      widget,
      kind,
      el,
      read: () => input.value,
      changed: () => input.value !== initial,
      focus: () => input.focus(),
    };
  }

  // kind === "multiline" — textarea with weight steppers.
  const initial = typeof widget.value === "string" ? widget.value : "";
  const textarea = document.createElement("textarea");
  textarea.className = "pe-textarea";
  textarea.value = initial;
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("autocorrect", "off");

  const bar = document.createElement("div");
  bar.className = "pe-bar";
  const downBtn = makeBtn("weight −", "Decrease weight of selection (or the word at the caret)");
  const upBtn = makeBtn("weight +", "Increase weight of selection (or the word at the caret)");
  bar.append(downBtn, upBtn);

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

  el.append(bar, textarea);
  return {
    widget,
    kind,
    el,
    read: () => textarea.value,
    changed: () => textarea.value !== initial,
    focus: () => {
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    },
  };
}

// ============================================================
// Modal — full-viewport all-fields node editor
// ============================================================

function openEditor(
  focusWidget: PromptWidget | null,
  node: PromptNode | null,
): ReturnType<typeof openModalShell> {
  ensureStyle();

  const wrap = document.createElement("div");
  wrap.className = "pe-wrap";

  // Build a field for every editable widget on the node, in node order.
  const fields: FieldRow[] = [];
  for (const w of node?.widgets ?? []) {
    const kind = classifyEditableWidget(w);
    if (!kind) continue;
    const field = buildField(w, kind);
    fields.push(field);
    wrap.appendChild(field.el);
  }

  // Degenerate fallback: nothing classified (e.g. a lone text widget the
  // classifier somehow skipped) → still edit the tapped widget as multiline.
  if (fields.length === 0 && focusWidget) {
    const field = buildField(focusWidget, "multiline");
    fields.push(field);
    wrap.appendChild(field.el);
  }

  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    for (const f of fields) {
      try {
        if (f.changed()) applyWidgetValue(f.widget, node, f.read());
      } catch (e) {
        console.warn(`[${EXT_NAME}] write-back failed for ${f.widget.name}`, e);
      }
    }
    modal.close();
  };

  const nodeTitle =
    (node as unknown as { title?: string; type?: string } | null)?.title ??
    (node as unknown as { type?: string } | null)?.type ??
    "node";

  const modal = openModalShell({
    title: "Edit node",
    subtitle: nodeTitle,
    showSearch: false,
    showFooter: true,
    width: "min(960px, calc(100vw - 16px))",
    height: "min(92vh, 900px)",
    footerLeftHTML: '<span class="pe-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>',
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    },
    onClose: () => {},
  });

  modal.bodyEl.appendChild(wrap);

  // A primary "Save" action in the footer-right cell.
  const saveBtn = makeBtn("Save", "Save (Cmd/Ctrl+Enter)", "pe-btn-primary");
  saveBtn.addEventListener("click", commit);
  modal.footerEl.appendChild(saveBtn);

  // Focus the widget the user actually tapped, scrolling it into view above the
  // soft keyboard. Defer past the opening tap so iOS doesn't fight the focus.
  requestAnimationFrame(() => {
    try {
      const target = fields.find((f) => f.widget === focusWidget) ?? fields[0];
      if (target) {
        target.focus();
        target.el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
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

  // Does the node have any widget the all-fields editor can edit? The button
  // (and the tap interception) are pointless on a node with nothing to edit
  // (e.g. a pure image preview / reroute).
  const hasEditable = node.widgets.some((w) => classifyEditableWidget(w) !== null);
  if (!hasEditable) return;

  // Strategy A: on text widgets, wrap onPointerDown so tapping the on-canvas
  // sliver opens the all-fields editor focused on THAT widget. Chain the
  // original first; only open ours if the original didn't consume the event.
  for (const w of node.widgets) {
    if (!isTargetWidget(w)) continue;
    if (w._promptEditorPointerPatched) continue;
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
        return false; // fall back to native control on error
      }
    };
  }

  // A distinct node-level "Edit fields" button pinned to the TOP of every node
  // with editable widgets. This is the universal entry point (works on nodes
  // with no text widget at all) and doubles as the version-skew safety net for
  // Strategy A. serialize:false so it never enters the saved workflow. Opens
  // with no specific focus (the first field). Added at most once per node.
  if (!node._promptEditorNodeButtonAdded) {
    node._promptEditorNodeButtonAdded = true;
    try {
      const btn = node.addWidget?.(
        "button",
        "⤢ Edit fields",
        null,
        () => {
          try {
            openEditor(null, node);
          } catch (e) {
            console.warn(`[${EXT_NAME}] open from button failed`, e);
          }
        },
        { serialize: false },
      );
      // Pin the button to the very top of the widget stack.
      if (btn && node.widgets) {
        const btnIdx = node.widgets.indexOf(btn);
        if (btnIdx > 0) {
          node.widgets.splice(btnIdx, 1);
          node.widgets.unshift(btn);
        }
      }
      node.setDirtyCanvas?.(true, true);
    } catch (e) {
      console.warn(`[${EXT_NAME}] addWidget(button) failed`, e);
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
