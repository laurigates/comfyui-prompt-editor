// Prompt Editor — ComfyUI frontend extension.
//
// Built to /extensions/comfyui-prompt-editor/dist/index.js — the pack
// directory name IS this URL segment. Do not rename the pack dir without
// syncing EXT_NAME below (used for log prefixes).
//
// Pattern (shared with gallery-loader / sampler-info):
//   registerExtension -> enhance each node (on create AND on graph load) ->
//   append a distinct "⤢ Edit fields" button (the universal entry point) to
//   every node that has editable widgets, AND wrap onPointerDown on multiline
//   STRING widgets (Strategy A) so tapping the on-canvas sliver opens the
//   editor focused on that field -> open a full-viewport HTML modal instead
//   of editing the keyboard-occluded on-canvas sliver. Additive + mobile-first:
//   always chain to the original handler, write back only on explicit confirm,
//   and fall back to the native control on dismiss / error.
//   The button is appended LAST (never the top) and marked serialize:false on
//   the widget itself — a non-serializable widget placed before real widgets
//   corrupts widgets_values on save/restore (see enhanceNode for the details).
//   Strategy A needs the modern Vue frontend's onPointerDown hook
//   (comfyui-frontend-package >= 1.40); the button is the version-skew safety
//   net and the entry point on nodes with no text widget at all.
//
// Scope: the modal is an ALL-FIELDS node editor. Tapping any multiline text
// widget (the detection target) opens a touch form with a control for EVERY
// editable widget on the node — multiline + single-line STRING, INT/FLOAT,
// combos, booleans, and rgthree Power Lora Loader rows (the per-lora on/off +
// strength widgets) — with the tapped widget focused. Each multiline field
// keeps its own weight ± steppers; each lora row keeps its own strength
// steppers. Write-back is per-field and only churns widgets whose value
// actually changed, so a cancelled edit leaves the serialized workflow
// byte-for-byte unchanged.
//
// The modal-shell primitive is consumed from @laurigates/comfy-modal-kit
// (bundled INLINE into the build output). The fzf-lite fuzzy matcher also
// lives in the kit, reserved for the v0.4 embedding palette. See ADR-0011.

import {
  appendButtonWidget,
  type ButtonWidgetHost,
  ensureStyleOnce,
  type ModalShellController,
  type ModelPicker,
  notify,
  openModalShell,
  openShellOverlay,
  type PointerPatchableWidget,
  patchWidgetPointer,
  resolveFieldProvider,
  resolveModelPicker,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-prompt-editor";
const STYLE_ID = "pe-style";

// The folder_paths category every rgthree Power Lora Loader row draws from.
// Fixed, not derived: a lora row is always a lora.
const LORA_CATEGORY = "loras";

// The node-level entry-point button's label. Doubles as its widget NAME (the
// second argument to LiteGraph's addWidget), which is how we detect that it is
// still present — see enhanceNode.
const EDIT_BUTTON_LABEL = "⤢ Edit fields";

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
  // The frontend's widgets_values save/restore loops key on THIS flag (on the
  // widget itself), NOT on options.serialize — so a non-serialized widget must
  // set widget.serialize = false directly. See enhanceNode's button.
  serialize?: boolean;
  // Idempotency guard stamped on the widget so the tap interception applies once.
  // Stamped on the WIDGET, so a node that clears its widgets during configure()
  // (rgthree's Power Lora Loader) discards the stamp along with the widget and
  // gets re-patched — unlike a node-level stamp. See enhanceNode.
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

export type WidgetKind = "multiline" | "text" | "number" | "combo" | "boolean" | "lora";

// ============================================================
// Power Lora Loader rows — rgthree custom widgets
// ============================================================
//
// rgthree's Power Lora Loader (and kin) attaches one self-drawing "custom"
// widget PER lora, whose `value` is an object — not a primitive the generic
// controls understand. Shape (from rgthree's PowerLoraLoaderWidget):
//   { on: boolean, lora: string | null, strength: number, strengthTwo: number | null }
// `strengthTwo` is the separate CLIP strength, present (a number) only when the
// row is in model+clip mode and null otherwise (serializeValue drops it then).
//
// Detection is SHAPE-based, not tied to rgthree's class names or the "lora_N"
// widget-name convention, so it stays generic across forks/repackagings. The
// three keys (`on`, `lora`, a numeric `strength`) are specific enough that a
// stray object value on some unrelated widget won't misfire.

export interface LoraWidgetValue {
  on?: boolean;
  lora?: string | null;
  strength?: number;
  strengthTwo?: number | null;
}

export function isLoraWidgetValue(v: unknown): v is LoraWidgetValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return "on" in o && "lora" in o && typeof o.strength === "number";
}

// rgthree's node PROPERTY that decides whether a row shows one strength or two.
// It is the authoritative signal — `PowerLoraLoaderWidget.draw()` reads exactly
// this and writes `value.strengthTwo` from it — whereas a row's own
// `strengthTwo` merely reflects the last draw, so it is null on a row the user
// switched to separate mode but has not scrolled into view yet.
const PROP_SHOW_STRENGTHS = "Show Strengths";
const PROP_VALUE_SEPARATE = "Separate Model & Clip";

/**
 * Whether a row should offer a second (CLIP) strength. Prefers rgthree's node
 * property; falls back to the value's own shape for a node that doesn't carry
 * the property at all (a fork, a repackaging, or a synthetic test node).
 */
export function loraShowsDualStrength(node: unknown, value: LoraWidgetValue): boolean {
  const props = (node as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  const mode = props?.[PROP_SHOW_STRENGTHS];
  if (typeof mode === "string") return mode === PROP_VALUE_SEPARATE;
  return value.strengthTwo != null;
}

/**
 * Whether a stored lora filename means "nothing selected". rgthree's own
 * chooser prepends a literal `"None"` entry (`utils_menu.js`), which its
 * backend `get_lora_by_filename` cannot resolve — so it is a sentinel, not a
 * file.
 *
 * DISPLAY ONLY. The sentinel is never normalised away on write-back: rewriting
 * an untouched row's `"None"` to `""` would churn `widgets_values` on a row the
 * user never touched, breaking the byte-identical round-trip this editor
 * promises.
 */
export function isEmptyLoraFile(lora: unknown): boolean {
  if (typeof lora !== "string") return true;
  const t = lora.trim();
  return t === "" || t.toLowerCase() === "none";
}

/** The basename to show for a lora file, or "" when nothing is selected. */
export function loraFileLabel(lora: unknown): string {
  if (isEmptyLoraFile(lora)) return "";
  return (lora as string).split(/[\\/]/).pop() ?? "";
}

// ============================================================
// Power Lora Loader row management — plain node.widgets splices
// ============================================================
//
// rgthree gates remove/reorder behind a right-click context menu and "➕ Add
// Lora" behind a LiteGraph menu — all three unreachable on touch. Its own menu
// handlers are plain `node.widgets` array operations (`removeArrayItem` /
// `moveArrayItem` in power_lora_loader.js), so we do exactly what they do.
//
// Detection stays SHAPE-based (isLoraWidgetValue) rather than rgthree's
// name-based `startsWith("lora_")`, matching this pack's existing classifier, so
// a fork that renames the rows still reorders correctly.

/** The lora rows on a node, in node order. */
export function loraRowWidgets(node: PromptNode | null): PromptWidget[] {
  return (node?.widgets ?? []).filter((w) => isLoraWidgetValue(w.value));
}

/** Remove one lora row. Returns false when the widget isn't on the node. */
export function removeLoraRow(node: PromptNode | null, widget: PromptWidget): boolean {
  const list = node?.widgets;
  if (!list) return false;
  const i = list.indexOf(widget);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/**
 * Move one lora row one position earlier (`dir` -1) or later (`dir` +1) among
 * the OTHER lora rows, stepping over rgthree's interleaved divider / header /
 * spacer / button widgets. Returns false when there is no row to swap with (the
 * row is already first/last) — the caller disables the affordance.
 *
 * `node.widgets` order IS the `widgets_values` serialization order, so this is
 * the operation that actually reorders the LoRA stack.
 */
export function moveLoraRow(node: PromptNode | null, widget: PromptWidget, dir: -1 | 1): boolean {
  const list = node?.widgets;
  if (!list) return false;
  const from = list.indexOf(widget);
  if (from < 0) return false;
  let to = -1;
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
    if (isLoraWidgetValue(list[i]?.value)) {
      to = i;
      break;
    }
  }
  if (to < 0) return false;
  list.splice(from, 1);
  list.splice(to, 0, widget);
  return true;
}

/**
 * Whether this node exposes rgthree's row factory. TypeScript `private` erases
 * at compile time, so `addNewLoraWidget` is a plain prototype method on the
 * shipped `web/comfyui/power_lora_loader.js` — but it is still rgthree's
 * internal API, so every entry point that uses it sits behind this probe. A
 * future refactor there degrades to a missing button, never a throw.
 */
export function canAddLoraRow(node: PromptNode | null): boolean {
  return typeof (node as LoraLoaderNode | null)?.addNewLoraWidget === "function";
}

/** The rgthree-specific surface the row-management affordances reach into. */
interface LoraLoaderNode extends PromptNode {
  addNewLoraWidget?: (lora?: string) => PromptWidget | undefined;
  computeSize?: () => number[];
  size?: number[];
}

/**
 * Re-fit the node to its widgets after a structural change, then redraw. Set
 * (not `Math.max`'d) so a removed row actually shrinks the node; a user's manual
 * enlargement is not worth preserving across an add/remove.
 */
function refitNode(node: PromptNode | null): void {
  try {
    const n = node as LoraLoaderNode | null;
    const computed = n?.computeSize?.();
    if (computed && n?.size && typeof computed[1] === "number") n.size[1] = computed[1];
  } catch (e) {
    console.warn(`[${EXT_NAME}] node re-fit failed`, e);
  }
  node?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

export function classifyEditableWidget(w: unknown): WidgetKind | null {
  if (!w || typeof w !== "object") return null;
  const widget = w as PromptWidget & { hidden?: boolean };
  const typeStr = typeof widget.type === "string" ? widget.type.toLowerCase() : "";

  // Skip non-data widgets and widgets converted to graph inputs.
  if (typeStr === "button" || typeStr === "converted-widget") return null;
  if (widget.hidden === true) return null;
  // Our own serialize:false expand button (and any unnamed control) is skipped.
  if (typeof widget.name !== "string" || widget.name === "") return null;

  // rgthree Power Lora Loader rows: value = { on, lora, strength, strengthTwo }.
  // Recognise these before the "custom" skip below so we can render a proper
  // per-lora control instead of dropping them.
  if (isLoraWidgetValue(widget.value)) return "lora";

  // Other self-drawing "custom" widgets (rgthree's header row, the "➕ Add Lora"
  // button whose value is an empty string, etc.) have no generic mapping.
  // Rendering their raw value as a text box is wrong — the button was showing up
  // as an empty input titled "➕ Add Lora" — so skip anything still typed
  // "custom" once the lora rows above are handled.
  if (typeStr === "custom") return null;

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
// Number-widget formatting — int/float + bounds resolution
// ============================================================

export interface NumberFormat {
  /** Round on read (INT widgets); never round FLOAT widgets. */
  isInt: boolean;
  /** Lower bound, only when finite (a non-finite bound is ignored). */
  min: number | undefined;
  /** Upper bound, only when finite. */
  max: number | undefined;
  /** The real (un-scaled) step for the HTML spinner, when positive/finite. */
  step: number | undefined;
}

/**
 * Resolve how a number widget should be parsed and constrained, from its
 * options. Pure (options -> format), so it is unit-tested.
 *
 * Integer-ness is taken from the widget's DECLARED shape, never from "the
 * current value happens to be whole": FLOAT widgets are frequently whole
 * (cfg 8.0, denoise 1.0), and rounding a fractional value the user deliberately
 * typed is destructive. Signals, most authoritative first:
 *   - `options.precision === 0`   -> integer (ComfyUI's canonical marker)
 *   - `options.precision > 0`     -> float
 *   - `options.step2` integral    -> integer (`step2` is the REAL step)
 *
 * `options.step` is DEPRECATED and scaled up 10x by the legacy frontend
 * (a real 0.1 step is stored as 1), so a fractional-step float looks integral
 * through it — the exact misdetection that silently rounded `cfg` edits to whole
 * numbers. We recover the real step (÷10) only as a last resort, and otherwise
 * default to FLOAT (the non-destructive choice).
 *
 * `min`/`max` are honoured only when FINITE. A NaN or Infinity bound — some node
 * specs carry them — would poison `Math.max`/`Math.min` in the reader and make
 * the field serialize as `NaN`.
 */
export function resolveNumberFormat(options: Record<string, unknown> | undefined): NumberFormat {
  const opts = options ?? {};
  const precision = opts.precision;
  const step2 = opts.step2;
  const legacyStep = opts.step;

  let isInt: boolean;
  if (typeof precision === "number") {
    isInt = precision === 0;
  } else if (typeof step2 === "number") {
    isInt = Number.isInteger(step2);
  } else if (typeof legacyStep === "number") {
    // Legacy step is the real step scaled up 10x; recover it before testing.
    isInt = Number.isInteger(legacyStep / 10);
  } else {
    isInt = false;
  }

  const finite = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  // Prefer the canonical step2; otherwise un-scale the legacy 10x step.
  const realStep =
    typeof step2 === "number"
      ? step2
      : typeof legacyStep === "number"
        ? legacyStep / 10
        : undefined;
  const step = finite(realStep);

  return {
    isInt,
    min: finite(opts.min),
    max: finite(opts.max),
    step: step !== undefined && step > 0 ? step : undefined,
  };
}

// ============================================================
// Modal CSS (pack-specific; modal-shell injects its own .cmp-* styles)
// ============================================================

const CSS = `
.pe-wrap {
    /* Plain layout column — NOT a scroll container. The modal shell's
       .cmp-body (flex:1; overflow-y:auto) is the single scroll region.
       A second nested scroll container here broke touch scrolling on mobile
       Safari: the dialog height comes from max-height (the shell applies the
       height option as maxHeight), so this element height:100% never resolved
       to a definite height — it captured the touch-scroll gesture but had
       nothing to scroll, swallowing it before .cmp-body could scroll. */
    display: flex;
    flex-direction: column;
    gap: 14px;
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
.pe-lora {
    /* Each lora reads as a card so a stack of them is scannable on mobile. */
    border: 1px solid #2a2a36;
    border-radius: 8px;
    padding: 12px;
    background: #17171f;
}
.pe-lora-head {
    display: flex;
    align-items: center;
    gap: 10px;
}
.pe-lora-on {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    touch-action: manipulation;
}
.pe-lora-name {
    /* Shrink to share the row with the toggle; min-width:0 lets it truncate. */
    flex: 1;
    width: auto;
    min-width: 0;
}
.pe-lora-strengths {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.pe-lora-strength-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.pe-lora-strength {
    flex: 1;
    width: auto;
    min-width: 0;
    text-align: center;
}
/* The filename control when a cross-pack ModelPicker is available: a big tap
   target showing the basename, opening the card grid. Replaces the text input
   (which stays as the additive fallback when no picker is registered). */
.pe-lora-pick {
    flex: 1;
    min-width: 0;
    text-align: left;
    /* The basename can be long; keep the row one line tall. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.pe-lora-summary {
    margin: 8px 0 2px;
}
.pe-lora-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 10px;
}
.pe-lora-act {
    min-width: 44px;
}
.pe-lora-del {
    color: #ff9eb0;
    border-color: #78384a;
}
.pe-lora-add {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
/* The picker overlay's scroll region. .cmp-ov-card is a max-height-capped flex
   column with NO scroll of its own, and a ModelPickerControl.el is contractually
   not a scroll container — so the host owns this element or the grid is clipped
   and unreachable. min-height:0 defeats the flex item's default
   min-height:auto, which would otherwise refuse to shrink below its content and
   blow past the card's max-height. */
.pe-pick-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
}
.pe-pick-card {
    /* Give the grid room: the picker is the overlay's whole purpose. */
    width: min(860px, calc(100% - 24px));
    height: min(80vh, 720px);
}
`;

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
  /**
   * Tear down a provider-supplied control when the modal closes. Only set for
   * fields backed by a cross-pack {@link FieldControl}; the built-in controls
   * hold no listeners/timers that outlive the modal DOM, so they omit it.
   */
  _destroy?: () => void;
}

// ============================================================
// Sibling-field bus — live cross-field context within one modal session
// ============================================================
//
// This editor edits MANY widgets at once and only writes values back to the
// node on commit(). So node.widgets[] holds the COMMITTED value — the one from
// before the modal opened — not the uncommitted value the user just picked in
// another field. A sibling-aware control (e.g. sampler-info's scheduler picker
// highlighting the schedulers that pair with the currently-selected SAMPLER)
// must read the LIVE in-modal value, which is exactly what this bus provides.
//
// It is the host half of the kit's field-provider contract (comfy-modal-kit
// >= 0.7.0): the kit ships FieldControlContext.getSiblingValue /
// .onSiblingChange and FieldControl.onValueChange, but no runtime — the host
// owns the state, because the host owns the field rows.
//
// The bus closes over the live `fields` array BY REFERENCE and looks a sibling
// up lazily at call time. Fields are built in a loop, so a control may ask for
// a sibling whose row does not exist yet; a snapshot taken at create() time
// would miss it forever.

export interface FieldBus {
  /**
   * The live in-modal value of the widget named `widgetName`, or the node's
   * committed value when no field row is live for that name.
   */
  getSiblingValue: (widgetName: string) => unknown;
  /**
   * Subscribe `cb` on behalf of `owner`. The owner is never notified of its own
   * change — re-notifying the originator is an easy feedback/infinite-loop
   * footgun. Returns an unsubscribe.
   */
  subscribe: (
    owner: PromptWidget | null,
    cb: (widgetName: string, value: unknown) => void,
  ) => () => void;
  /** Fan `origin`'s new value out to every subscriber except `origin` itself. */
  notify: (origin: PromptWidget, value: unknown) => void;
  /** Drop every subscriber (called when the modal closes). */
  destroy: () => void;
}

export function createFieldBus(fields: FieldRow[], node: PromptNode | null): FieldBus {
  const subs: { owner: PromptWidget | null; cb: (name: string, value: unknown) => void }[] = [];

  const committedValue = (widgetName: string): unknown =>
    node?.widgets?.find((w) => w.name === widgetName)?.value;

  return {
    getSiblingValue: (widgetName) => {
      const row = fields.find((f) => f.widget.name === widgetName);
      if (!row) return committedValue(widgetName);
      try {
        return row.read();
      } catch (e) {
        // One throwing control must never break a sibling — fall back to the
        // committed value rather than propagating.
        console.warn(`[${EXT_NAME}] read() threw for ${widgetName}; using committed value`, e);
        return committedValue(widgetName);
      }
    },
    subscribe: (owner, cb) => {
      const entry = { owner, cb };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    notify: (origin, value) => {
      const name = origin.name;
      if (typeof name !== "string" || name === "") return;
      // Copy first: a subscriber may unsubscribe itself while we iterate.
      for (const s of [...subs]) {
        if (s.owner === origin) continue;
        try {
          s.cb(name, value);
        } catch (e) {
          console.warn(`[${EXT_NAME}] sibling subscriber threw for ${name}`, e);
        }
      }
    },
    destroy: () => {
      subs.length = 0;
    },
  };
}

function makeBtn(label: string, title: string, cls?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pe-btn${cls ? ` ${cls}` : ""}`;
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

// ============================================================
// Model-file picker overlay — the cross-pack card grid, in-shell
// ============================================================
//
// A lora row's filename is a `folder_paths` "loras" entry, and a sibling pack
// (comfyui-model-gallery) can render a searchable card grid for exactly that.
// It registers a kit ModelPicker keyed on the CATEGORY, because a lora row is a
// `type: "custom"` widget with no `options.values` and so cannot be matched by
// the widget-keyed FieldProvider registry (kit ADR-0003).
//
// Single-modal discipline means this cannot be a second openModalShell — it is
// an in-shell overlay (kit ADR-0002).

/** What the LoRA row needs from its host modal. Both members are optional: a
 *  caller with neither (the unit tests, a future single-field host) gets the
 *  built-in text input and no row-management strip. */
export interface LoraRowHooks {
  /**
   * The open shell, resolved LAZILY. The first batch of fields is built before
   * `openModalShell` returns, so a plain value would be null forever.
   */
  getShell?: () => ModalShellController | null;
  /**
   * Apply pending edits, then re-render the modal body. Called after a
   * structural change to `node.widgets` (add / remove / reorder), because the
   * field list the modal is rendering no longer matches the node.
   */
  rebuild?: () => void;
}

/**
 * Open the registered model picker for `category` as an in-shell overlay.
 * Resolves the chosen filename, or null on Cancel / Esc / backdrop tap.
 *
 * The Choose button starts disabled and enables on the first selection, so
 * confirming can never write back a value the user did not actually pick.
 */
function pickModelFile(
  shell: ModalShellController,
  picker: ModelPicker,
  category: string,
  initialValue: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        ctl.destroy?.();
      } catch (e) {
        console.warn(`[${EXT_NAME}] picker destroy failed`, e);
      }
      resolve(value);
    };

    const ov = openShellOverlay(shell, {
      onDismiss: () => finish(null),
    });
    ov.card.classList.add("pe-pick-card");

    const title = document.createElement("div");
    title.className = "cmp-ov-title";
    title.textContent = "Choose LoRA";

    // THE detail that breaks this otherwise: `.cmp-ov-card` is a max-height-
    // capped `display:flex` column with NO scroll region of its own, while a
    // ModelPickerControl.el is contractually NOT a scroll container (kit
    // ADR-0003). Without this wrapper the grid is clipped and every file below
    // the fold is unreachable. `min-height: 0` is required too — a flex item's
    // default `min-height: auto` refuses to shrink below its content, which
    // would push the card straight past its max-height.
    const scroll = document.createElement("div");
    scroll.className = "pe-pick-scroll";

    const ctl = picker.create({ category, initialValue });
    scroll.appendChild(ctl.el);

    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = makeBtn("Cancel", "Keep the current file");
    cancel.addEventListener("click", () => {
      ov.close();
      finish(null);
    });
    const choose = makeBtn("Choose", "Use the selected file", "pe-btn-primary");
    choose.disabled = true;
    choose.addEventListener("click", () => {
      ov.close();
      finish(ctl.getValue());
    });
    try {
      ctl.onValueChange?.(() => {
        choose.disabled = false;
      });
    } catch (e) {
      // A picker without a change signal still works — the user just has to
      // tap a card and then Choose, so enable the button up front instead.
      console.warn(`[${EXT_NAME}] picker onValueChange wiring failed`, e);
      choose.disabled = false;
    }
    if (!ctl.onValueChange) choose.disabled = false;

    row.append(cancel, choose);
    ov.card.append(title, scroll, row);
    try {
      ctl.focus?.();
    } catch (e) {
      console.warn(`[${EXT_NAME}] picker focus failed`, e);
    }
  });
}

export function buildField(
  widget: PromptWidget,
  kind: WidgetKind,
  node: PromptNode | null = null,
  bus?: FieldBus,
  hooks?: LoraRowHooks,
): FieldRow {
  // Every control announces its change through the bus so sibling-aware
  // controls see the LIVE value. Fail-soft: no bus (an existing call site, a
  // test) → a no-op.
  const announce = (value: unknown): void => {
    try {
      bus?.notify(widget, value);
    } catch (e) {
      console.warn(`[${EXT_NAME}] sibling notify failed for ${widget.name}`, e);
    }
  };

  // Cross-pack provider first: if a sibling pack (e.g. touch-numeric's seed
  // keypad, sampler-info's fuzzy list) registered a richer inline control for
  // this widget, mount it in place of the built-in control. Additive-fallback:
  // resolveFieldProvider returns null when nothing matches, and we fall through
  // to the built-in <input>/<select>/toggle path below — never broken by the
  // absence of a peer pack. (Kit ADR-0001; consumer ADR-0002.)
  const provider = resolveFieldProvider(widget, node);
  if (provider) {
    try {
      // Hand the provider the sibling-context members only when a bus exists.
      // They are optional in the kit's contract, so a single-widget host (or a
      // test) that omits them is a supported shape, not a degraded one.
      const ctl = provider.create({
        widget,
        node,
        initialValue: widget.value,
        ...(bus
          ? {
              getSiblingValue: (name: string) => bus.getSiblingValue(name),
              onSiblingChange: (cb: (widgetName: string, value: unknown) => void) =>
                bus.subscribe(widget, cb),
            }
          : {}),
      });
      // The other end of the contract: fan this control's changes out to its
      // siblings. A provider that has nothing to tell anyone omits onValueChange.
      try {
        ctl.onValueChange?.((value) => announce(value));
      } catch (e) {
        console.warn(`[${EXT_NAME}] onValueChange wiring failed for ${widget.name}`, e);
      }
      return {
        widget,
        kind,
        el: ctl.el,
        read: () => ctl.getValue(),
        changed: () => ctl.hasChanged(),
        focus: () => ctl.focus?.(),
        _destroy: () => ctl.destroy?.(),
      };
    } catch (e) {
      // A misbehaving provider must never break the editor — fall through to
      // the built-in control for this field.
      console.warn(`[${EXT_NAME}] field provider for ${widget.name} failed; using built-in`, e);
    }
  }

  const el = document.createElement("div");
  el.className = "pe-field";

  const label = document.createElement("label");
  label.className = "pe-label";
  label.textContent = widget.name ?? "";
  el.appendChild(label);

  if (kind === "lora") {
    // One rgthree Power Lora Loader row: an on/off toggle, the lora filename,
    // and one (or two, in model+clip mode) touch-friendly strength steppers.
    // We only ever read/write the widget's own {on, lora, strength, strengthTwo}
    // value object — additive, and rgthree's value setter re-normalises it.
    el.classList.add("pe-lora");
    const initial = (isLoraWidgetValue(widget.value) ? widget.value : {}) as LoraWidgetValue;
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const initialOn = initial.on !== false; // rgthree default is on:true
    const initialLora = typeof initial.lora === "string" ? initial.lora : "";
    const initialStrength = num(initial.strength, 1);
    // Dual model/clip mode comes from rgthree's node PROPERTY, which is what its
    // own draw() reads. A row's `strengthTwo` only reflects the last draw, so it
    // is still null on a row switched to separate mode but not yet redrawn —
    // deriving the mode from it alone hides the CLIP strength on exactly those
    // rows.
    const hasTwo = loraShowsDualStrength(node, initial);
    const initialStrengthTwo = num(initial.strengthTwo, initialStrength);

    // A friendlier section label than the internal "lora_N" widget name: the
    // filename the user actually recognises. Falls back to the widget name.
    label.textContent = loraFileLabel(initialLora) || widget.name || "lora";

    const fmtStrength = (n: number): string =>
      String(Math.round((Number.isFinite(n) ? n : 0) * 100) / 100);

    // Head row: on/off toggle + the lora filename control.
    const head = document.createElement("div");
    head.className = "pe-lora-head";
    const onInput = document.createElement("input");
    onInput.type = "checkbox";
    onInput.className = "pe-lora-on";
    onInput.checked = initialOn;
    onInput.title = "Toggle this LoRA on/off";

    // The chosen filename, tracked in one place so read-back is identical on
    // both the picker and the text-input path. Seeded with the RAW stored string
    // (not a normalised one) so an untouched row — including one holding
    // rgthree's "None" sentinel — round-trips byte-for-byte.
    let currentLora = initialLora;

    // The picker path: a sibling pack (comfyui-model-gallery) registers a
    // category-keyed ModelPicker, so tapping the filename opens a searchable
    // card grid with trigger words and training metadata. Requires a host shell
    // to mount the overlay in. Additive-fallback: no picker registered (or no
    // shell) → the plain text input below, exactly as before.
    const shell = hooks?.getShell?.() ?? null;
    const picker = shell ? resolveModelPicker(LORA_CATEGORY) : null;

    let nameInput: HTMLInputElement | undefined;
    let nameBtn: HTMLButtonElement | undefined;
    let summaryEl: HTMLElement | undefined;

    const renderSummary = (): void => {
      if (!summaryEl || !picker?.createSummary) return;
      summaryEl.replaceChildren();
      if (isEmptyLoraFile(currentLora)) return;
      try {
        summaryEl.appendChild(
          picker.createSummary({ category: LORA_CATEGORY, value: currentLora }),
        );
      } catch (e) {
        // The strip is decoration; a provider that fails must not take the row
        // (or the modal) with it.
        console.warn(`[${EXT_NAME}] lora summary failed for ${currentLora}`, e);
      }
    };

    if (picker && shell) {
      nameBtn = makeBtn(
        loraFileLabel(currentLora) || "None",
        "Choose a LoRA file",
        "pe-lora-name pe-lora-pick",
      );
      nameBtn.addEventListener("click", () => {
        pickModelFile(shell, picker, LORA_CATEGORY, isEmptyLoraFile(currentLora) ? "" : currentLora)
          .then((chosen) => {
            if (chosen === null) return; // cancelled — leave the row untouched
            currentLora = chosen;
            if (nameBtn) nameBtn.textContent = loraFileLabel(chosen) || "None";
            label.textContent = loraFileLabel(chosen) || widget.name || "lora";
            renderSummary();
            onAnyChange();
          })
          .catch((e) => {
            console.warn(`[${EXT_NAME}] lora picker failed`, e);
            notify({
              severity: "error",
              summary: "LoRA picker failed",
              detail: e instanceof Error ? e.message : String(e),
            });
          });
      });
      head.append(onInput, nameBtn);
      if (picker.createSummary) {
        summaryEl = document.createElement("div");
        summaryEl.className = "pe-lora-summary";
      }
    } else {
      nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "pe-input pe-lora-name";
      nameInput.value = initialLora;
      nameInput.spellcheck = false;
      nameInput.autocapitalize = "off";
      nameInput.autocomplete = "off";
      nameInput.setAttribute("autocorrect", "off");
      head.append(onInput, nameInput);
    }

    let strengthInput: HTMLInputElement | undefined;
    let strengthTwoInput: HTMLInputElement | undefined;
    const readNum = (input: HTMLInputElement | undefined, fallback: number): number => {
      if (!input) return fallback;
      const n = Number.parseFloat(input.value);
      return Number.isFinite(n) ? n : fallback;
    };
    const readValue = (): LoraWidgetValue => ({
      on: onInput.checked,
      lora: currentLora,
      strength: readNum(strengthInput, initialStrength),
      // Preserve rgthree's dual-strength contract: only carry a second value in
      // model+clip mode; otherwise keep whatever was there (null) untouched —
      // never normalise a row the user didn't edit.
      strengthTwo: hasTwo
        ? readNum(strengthTwoInput, initialStrengthTwo)
        : (initial.strengthTwo ?? null),
    });
    const onAnyChange = (): void => announce(readValue());

    const makeStrengthRow = (
      text: string,
      initNum: number,
    ): { row: HTMLElement; input: HTMLInputElement } => {
      const row = document.createElement("div");
      row.className = "pe-lora-strength-row";
      const lab = document.createElement("label");
      lab.className = "pe-hint";
      lab.textContent = text;
      const bar = document.createElement("div");
      bar.className = "pe-bar";
      const minus = makeBtn("−", `Decrease ${text}`);
      const input = document.createElement("input");
      input.type = "number";
      input.className = "pe-input pe-lora-strength";
      input.step = "0.05";
      input.inputMode = "decimal";
      input.value = fmtStrength(initNum);
      const plus = makeBtn("+", `Increase ${text}`);
      const step = (delta: number): void => {
        const cur = Number.parseFloat(input.value);
        input.value = fmtStrength((Number.isFinite(cur) ? cur : initNum) + delta);
        onAnyChange();
      };
      minus.addEventListener("click", () => step(-0.05));
      plus.addEventListener("click", () => step(0.05));
      input.addEventListener("input", onAnyChange);
      bar.append(minus, input, plus);
      row.append(lab, bar);
      return { row, input };
    };

    onInput.addEventListener("change", onAnyChange);
    nameInput?.addEventListener("input", () => {
      currentLora = nameInput?.value ?? "";
      onAnyChange();
    });

    const strengths = document.createElement("div");
    strengths.className = "pe-lora-strengths";
    const sRow = makeStrengthRow(hasTwo ? "model strength" : "strength", initialStrength);
    strengthInput = sRow.input;
    strengths.appendChild(sRow.row);
    if (hasTwo) {
      const s2Row = makeStrengthRow("clip strength", initialStrengthTwo);
      strengthTwoInput = s2Row.input;
      strengths.appendChild(s2Row.row);
    }

    el.append(head);
    if (summaryEl) el.appendChild(summaryEl);
    el.appendChild(strengths);
    renderSummary();

    // Row management: reorder + remove, unreachable on touch in rgthree (they
    // live behind a right-click context menu). Only offered when there is a host
    // that can re-render itself — the field list changes underneath the modal, so
    // a host with no rebuild() would be left rendering a stale list.
    if (hooks?.rebuild && node?.widgets) {
      const actions = document.createElement("div");
      actions.className = "pe-lora-actions";
      const rows = loraRowWidgets(node);
      const pos = rows.indexOf(widget);

      const structural = (label: string, run: () => boolean): HTMLButtonElement => {
        const b = makeBtn(label, "", "pe-lora-act");
        b.addEventListener("click", () => {
          try {
            if (!run()) return;
          } catch (e) {
            console.warn(`[${EXT_NAME}] lora row ${label} failed`, e);
            notify({
              severity: "error",
              summary: "Row change failed",
              detail: e instanceof Error ? e.message : String(e),
            });
            return;
          }
          refitNode(node);
          hooks.rebuild?.();
        });
        return b;
      };

      const up = structural("↑", () => moveLoraRow(node, widget, -1));
      up.title = "Move this LoRA earlier in the stack";
      up.disabled = pos <= 0;
      const down = structural("↓", () => moveLoraRow(node, widget, 1));
      down.title = "Move this LoRA later in the stack";
      down.disabled = pos < 0 || pos >= rows.length - 1;
      const del = structural("⨯", () => removeLoraRow(node, widget));
      del.title = "Remove this LoRA row";
      del.classList.add("pe-lora-del");

      actions.append(up, down, del);
      el.appendChild(actions);
    }

    return {
      widget,
      kind,
      el,
      read: readValue,
      changed: () => {
        const v = readValue();
        if (v.on !== initialOn) return true;
        if (v.lora !== initialLora) return true;
        if (v.strength !== initialStrength) return true;
        if (hasTwo && v.strengthTwo !== initialStrengthTwo) return true;
        return false;
      },
      focus: () => (strengthInput ?? nameInput ?? nameBtn)?.focus(),
    };
  }

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
    input.addEventListener("change", () => {
      sync();
      announce(input.checked);
    });
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
      // Match by string: a numeric combo whose value is stored as a string (or
      // vice-versa) would fail strict `===` and silently default to the first
      // option, corrupting the saved value.
      if (String(v) === String(initial)) opt.selected = true;
      select.appendChild(opt);
    }
    el.appendChild(select);
    // Map the chosen option string back to the original-typed list entry.
    const read = (): unknown => {
      const hit = values.find((v) => String(v) === select.value);
      return hit === undefined ? select.value : hit;
    };
    // The built-in combo is the common host for the OTHER half of a pair (e.g.
    // sampler-info provides the scheduler control while `sampler_name` stays a
    // plain <select>), so it must feed the bus or the feature is half-dead.
    select.addEventListener("change", () => announce(read()));
    return {
      widget,
      kind,
      el,
      read,
      // Compare by string so a type-only difference (number 8 vs "8") isn't
      // treated as an edit and churned back through the widget callback.
      changed: () => String(read()) !== String(initial),
      focus: () => select.focus(),
    };
  }

  if (kind === "number") {
    // The widget's value at open time. Kept verbatim for change detection so a
    // pre-existing NaN / string value is seen as "changed" and gets normalised
    // to a finite number on save, while an untouched valid number is not.
    const originalValue = widget.value;
    const rawInitial = typeof originalValue === "number" ? originalValue : Number(originalValue);
    // Seed the control with a finite number — never "NaN"/"" — so the field can
    // neither display nor round-trip a non-finite value.
    const initial = Number.isFinite(rawInitial) ? rawInitial : 0;
    const { isInt, min, max, step } = resolveNumberFormat(widget.options);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pe-input";
    input.value = String(initial);
    input.inputMode = isInt ? "numeric" : "decimal";
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    if (step !== undefined) input.step = String(step);
    el.appendChild(input);
    const read = (): number => {
      const n = Number.parseFloat(input.value);
      if (!Number.isFinite(n)) return initial;
      let v = n;
      // Bounds are pre-filtered to finite values, so clamping can never inject
      // a NaN here. Preserve the widget's native int/float-ness.
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      return isInt ? Math.round(v) : v;
    };
    input.addEventListener("input", () => announce(read()));
    return {
      widget,
      kind,
      el,
      read,
      changed: () => read() !== originalValue,
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
    input.addEventListener("input", () => announce(input.value));
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
  downBtn.addEventListener("click", () => {
    stepWeight(-0.1);
    announce(textarea.value);
  });
  upBtn.addEventListener("click", () => {
    stepWeight(0.1);
    announce(textarea.value);
  });
  textarea.addEventListener("input", () => announce(textarea.value));

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
// "➕ Add LoRA" strip — the node-level structural affordance
// ============================================================
//
// rgthree's own "➕ Add Lora" is a canvas button that opens a LiteGraph menu, so
// it is as unreachable on touch as the per-row context menu. This strip is the
// node-level counterpart to the per-row ↑/↓/⨯ buttons, and it also carries the
// one-line warning that structural edits are not undone by Cancel.
//
// Returns null unless the node actually exposes rgthree's row factory AND the
// host can re-render — an entry point that can't complete its own action is
// worse than an absent one.

function buildLoraAddStrip(node: PromptNode | null, hooks: LoraRowHooks): HTMLElement | null {
  if (!hooks.rebuild || !canAddLoraRow(node)) return null;
  const shell = hooks.getShell?.() ?? null;
  const picker = shell ? resolveModelPicker(LORA_CATEGORY) : null;

  const strip = document.createElement("div");
  strip.className = "pe-lora-add";

  const addRow = (chosen?: string): void => {
    try {
      (node as LoraLoaderNode).addNewLoraWidget?.(chosen);
    } catch (e) {
      console.warn(`[${EXT_NAME}] addNewLoraWidget failed`, e);
      notify({
        severity: "error",
        summary: "Could not add a LoRA row",
        detail: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    refitNode(node);
    hooks.rebuild?.();
  };

  const btn = makeBtn("➕ Add LoRA", "Append a new LoRA row to this node");
  btn.addEventListener("click", () => {
    // With a picker: choose the file first, so the new row lands populated
    // instead of empty. Without one: append an empty row and let the user type
    // into its text input (the additive fallback).
    if (!picker || !shell) {
      addRow();
      return;
    }
    pickModelFile(shell, picker, LORA_CATEGORY, "")
      .then((chosen) => {
        if (chosen === null) return; // cancelled — add nothing
        addRow(chosen);
      })
      .catch((e) => {
        console.warn(`[${EXT_NAME}] lora picker failed`, e);
        notify({
          severity: "error",
          summary: "LoRA picker failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      });
  });

  const hint = document.createElement("span");
  hint.className = "pe-hint";
  hint.textContent = "Row changes apply immediately (and save pending edits)";

  strip.append(btn, hint);
  return strip;
}

// ============================================================
// Modal — full-viewport all-fields node editor
// ============================================================

// Exported for the cross-pack integration suite, which drives the REAL editor
// (build loop -> buildField -> provider resolution -> writeBack -> commit) with
// a real provider pack installed. Testing through buildField alone would miss
// the loop's own decisions — which widgets it renders rows for is exactly where
// a provider's duplicate control shows up. Not part of the runtime API; the
// extension calls it through the pointer patch and the button widget below.
export function openEditor(
  focusWidget: PromptWidget | null,
  node: PromptNode | null,
): ReturnType<typeof openModalShell> {
  ensureStyleOnce(STYLE_ID, CSS);

  const wrap = document.createElement("div");
  wrap.className = "pe-wrap";

  // The bus is created first and closes over `fields` BY REFERENCE, so a control
  // built early can still resolve a sibling whose row is built later — and so a
  // rebuild must MUTATE `fields` in place, never reassign it.
  const fields: FieldRow[] = [];
  const bus = createFieldBus(fields, node);

  const destroyFields = (): void => {
    for (const f of fields) {
      try {
        f._destroy?.();
      } catch (e) {
        console.warn(`[${EXT_NAME}] field destroy failed for ${f.widget.name}`, e);
      }
    }
  };

  // Apply every changed field to its widget. Extracted from commit() because a
  // structural row change also has to flush: rebuilding re-reads the field list
  // from node.widgets, so an unsaved edit in an unrelated field (a prompt the
  // user just typed) would otherwise be silently discarded by tapping ⨯ on a
  // LoRA row.
  const writeBack = (): void => {
    // Collect fields whose write-back throws so a partially-failed save is
    // surfaced via a copyable popup — on a touch/mobile frontend there is no
    // devtools trail to inspect the console.warn below.
    const failedNames: string[] = [];
    for (const f of fields) {
      try {
        if (f.changed()) applyWidgetValue(f.widget, node, f.read());
      } catch (e) {
        console.warn(`[${EXT_NAME}] write-back failed for ${f.widget.name}`, e);
        failedNames.push(f.widget.name ?? "(unnamed)");
      }
    }
    if (failedNames.length > 0) {
      notify({
        severity: "error",
        summary: "Some fields did not save",
        detail: failedNames.join(", "),
      });
    }
  };

  // Structural row edits (add / remove / reorder) change the very list the modal
  // is rendering, so they apply IMMEDIATELY and re-render — Cancel will not undo
  // them (the strip says so). Flush first so nothing already typed is lost.
  const rebuild = (): void => {
    writeBack();
    destroyFields();
    fields.length = 0;
    wrap.replaceChildren();
    build();
  };

  // Lazily resolved: the first build runs before openModalShell returns, so a
  // shell captured by value would be null forever.
  const hooks: LoraRowHooks = { getShell: () => modal ?? null, rebuild };

  // Build a field for every editable widget on the node, in node order.
  function build(): void {
    for (const w of node?.widgets ?? []) {
      const kind = classifyEditableWidget(w);
      if (!kind) continue;
      const field = buildField(w, kind, node, bus, hooks);
      fields.push(field);
      wrap.appendChild(field.el);
    }

    // Degenerate fallback: nothing classified (e.g. a lone text widget the
    // classifier somehow skipped) → still edit the tapped widget as multiline.
    if (fields.length === 0 && focusWidget) {
      const field = buildField(focusWidget, "multiline", node, bus, hooks);
      fields.push(field);
      wrap.appendChild(field.el);
    }

    const addStrip = buildLoraAddStrip(node, hooks);
    if (addStrip) wrap.appendChild(addStrip);
  }

  build();

  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    writeBack();
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
    onClose: () => {
      // Tear down any provider-supplied controls (listeners/timers) when the
      // modal closes — whether via Save, Esc, or a coordinator dismiss.
      destroyFields();
      // The bus lives for exactly one modal session; drop any subscriber a
      // control forgot to unsubscribe.
      bus.destroy();
    },
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

export function enhanceNode(node: PromptNode | null): void {
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
    // The shared kit wrapper: chains the original onPointerDown, honors its
    // consumed-return, runs our opener otherwise, and falls back to the native
    // control on error. Replaces the pack's hand-rolled wrapper so provider
    // clicks and the editor open coordinate through the kit (kit ADR-0001).
    patchWidgetPointer(w as PointerPatchableWidget, (_pointer, ownerNode) => {
      openEditor(w, (ownerNode as PromptNode) || node);
      return true; // consume — suppress the native sliver edit
    });
  }

  // A distinct node-level "Edit fields" button appended to every node with
  // editable widgets. This is the universal entry point (works on nodes with no
  // text widget at all) and doubles as the version-skew safety net for Strategy
  // A. Opens with no specific focus (the first field). The serialize:false /
  // keep-last workflow-corruption hazard handling lives in the kit's
  // appendButtonWidget.
  //
  // Idempotency is by PRESENCE, not by a once-per-node boolean stamp. A stamp is
  // wrong for any node that clears its own widgets during configure(): rgthree's
  // Power Lora Loader does exactly that —
  //   `while (this.widgets?.length) this.removeWidget(0)`
  // (power_lora_loader.js) — and configure() runs AFTER nodeCreated on a loaded
  // graph. So the sequence was: nodeCreated adds the button and sets the stamp →
  // configure() deletes the button → loadedGraphNode sees the stamp and skips
  // re-adding → the editor is unreachable on every LOADED Power Lora Loader,
  // while working fine on a freshly dropped one. Checking that the widget is
  // still there is both correct and cheap.
  if (!hasEditButton(node)) {
    appendButtonWidget(node as ButtonWidgetHost, EDIT_BUTTON_LABEL, () => openEditor(null, node), {
      logPrefix: EXT_NAME,
    });
  }
}

/** Is our node-level entry-point button still on the node? */
function hasEditButton(node: PromptNode): boolean {
  return !!node.widgets?.some((w) => w.name === EDIT_BUTTON_LABEL);
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
