// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = { fieldProviders: [], activeModal: null, pointerClaim: null };
    g[KEY] = kit;
  }
  return kit;
}
function resolveFieldProvider(widget, node) {
  let best = null;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const p of getKit().fieldProviders) {
    let matched = false;
    try {
      matched = p.match(widget, node);
    } catch (e) {
      console.warn(`[comfy-modal-kit] field provider "${p.id}" match() threw`, e);
      matched = false;
    }
    if (!matched)
      continue;
    const priority = p.priority ?? 0;
    if (priority > bestPriority) {
      best = p;
      bestPriority = priority;
    }
  }
  return best;
}
var guardInstalled = false;
function setActiveModal(handle) {
  installPointerGuard();
  dismissActiveModal();
  getKit().activeModal = handle;
}
function dismissActiveModal() {
  const kit = getKit();
  const active = kit.activeModal;
  if (!active)
    return;
  kit.activeModal = null;
  try {
    active.close();
  } catch (e) {
    console.warn("[comfy-modal-kit] active modal close() threw", e);
  }
}
function getActiveModal() {
  return getKit().activeModal;
}
function patchWidgetPointer(widget, opener) {
  const original = widget.onPointerDown;
  function patched(pointer, node, canvas) {
    try {
      if (typeof original === "function") {
        const consumed = original.call(this, pointer, node, canvas);
        if (consumed)
          return consumed;
      }
      return opener(pointer, node, canvas);
    } catch (e) {
      console.warn("[comfy-modal-kit] patched onPointerDown threw", e);
      return false;
    }
  }
  widget.onPointerDown = patched;
  return {
    restore() {
      widget.onPointerDown = original;
    }
  };
}
function installPointerGuard() {
  if (guardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  guardInstalled = true;
  window.addEventListener("pointerdown", pointerGuard, true);
}
function pointerGuard(e) {
  const active = getKit().activeModal;
  if (!active)
    return;
  const target = e.target;
  if (active.element && target && active.element.contains(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
var STYLE_ID = "cmn-notify-style";
var CONTAINER_ID = "cmn-notify-container";
function defaultLife(severity) {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 8000;
    default:
      return 4000;
  }
}
function defaultCopyable(severity) {
  return severity === "error" || severity === "warn";
}
function notifyClipboardText(summary, detail) {
  return detail ? `${summary}
${detail}` : summary;
}
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document === "undefined")
      return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
var CSS = `
.cmn-container {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 24px));
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cmn-toast {
    pointer-events: auto;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-left-width: 4px;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.4;
    animation: cmn-in 0.16s ease-out;
}
@keyframes cmn-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
.cmn-toast.cmn-success { border-left-color: #4caf50; }
.cmn-toast.cmn-info    { border-left-color: #6ba6ff; }
.cmn-toast.cmn-warn    { border-left-color: #e0a83a; }
.cmn-toast.cmn-error   { border-left-color: #e0533a; }
.cmn-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.cmn-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
}
.cmn-summary { font-weight: 600; }
.cmn-detail  { color: #b8b8c0; margin-top: 2px; white-space: pre-wrap; }
.cmn-close {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
}
.cmn-close:hover { color: #fff; }
.cmn-actions { display: flex; gap: 8px; }
.cmn-copy {
    background: #2a2a36;
    color: #d8d8e0;
    border: 1px solid #3a3a44;
    border-radius: 5px;
    /* Touch-first: comfortable tap target, 13px text. */
    min-height: 32px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.cmn-copy:hover  { background: #34343f; color: #fff; }
.cmn-copy.cmn-copied { background: #2f4a30; border-color: #4caf50; color: #cfe8d0; }
`;
function ensureStyle() {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(STYLE_ID))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    return null;
  }
  ensureStyle();
  const container = ensureContainer();
  const life = opts.life ?? defaultLife(severity);
  const copyable = opts.copyable ?? defaultCopyable(severity);
  const toast = document.createElement("div");
  toast.className = `cmn-toast cmn-${severity}`;
  toast.setAttribute("role", severity === "error" ? "alert" : "status");
  let timer;
  const close = () => {
    if (timer)
      clearTimeout(timer);
    toast.remove();
    if (container.childElementCount === 0)
      container.remove();
  };
  const row = document.createElement("div");
  row.className = "cmn-row";
  const text = document.createElement("div");
  text.className = "cmn-text";
  const summaryEl = document.createElement("div");
  summaryEl.className = "cmn-summary";
  summaryEl.textContent = summary;
  text.appendChild(summaryEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "cmn-detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmn-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", close);
  row.append(text, closeBtn);
  toast.appendChild(row);
  if (copyable) {
    const actions = document.createElement("div");
    actions.className = "cmn-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "cmn-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(notifyClipboardText(summary, detail));
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      copyBtn.classList.toggle("cmn-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("cmn-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
    toast.appendChild(actions);
  }
  container.appendChild(toast);
  if (life > 0) {
    timer = setTimeout(close, life);
  }
  return { close, el: toast };
}
var STYLE_ID2 = "cmp-shell-style";
var CSS2 = `
.cmp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 9998;
    backdrop-filter: blur(2px);
    touch-action: manipulation;
}
.cmp-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 9999;
    width: min(960px, calc(100vw - 24px));
    max-height: min(85vh, 800px);
    touch-action: manipulation;
    display: flex;
    flex-direction: column;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    overflow: hidden;
}
.cmp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #21212a;
    flex-shrink: 0;
}
.cmp-title {
    flex: 1;
    font-weight: 600;
    color: #9ec6ff;
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-subtitle {
    color: #888;
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
}
.cmp-close {
    background: transparent;
    color: #aaa;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    width: 36px;
    height: 36px;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
}
.cmp-close:hover {
    background: #2a2a32;
    color: #fff;
}
.cmp-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #1f1f26;
    flex-shrink: 0;
}
.cmp-toolbar:empty {
    display: none;
}
.cmp-searchrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a32;
    flex-shrink: 0;
}
.cmp-search {
    flex: 1;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    color: #e8e8ea;
    padding: 8px 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    min-width: 0;
}
.cmp-search:focus {
    border-color: #6ba6ff;
}
.cmp-status {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
}
.cmp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px;
    position: relative;
}
.cmp-body.is-busy {
    opacity: 0.5;
    pointer-events: none;
}
.cmp-footer {
    padding: 8px 14px;
    border-top: 1px solid #2a2a32;
    color: #777;
    font-size: 11px;
    background: #1f1f26;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
}
.cmp-footer:empty {
    display: none;
}
.cmp-footer kbd {
    background: #2a2a36;
    border: 1px solid #3a3a44;
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #b8b8c0;
}
`;
function ensureStyle2() {
  if (document.getElementById(STYLE_ID2))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID2;
  s.textContent = CSS2;
  document.head.appendChild(s);
}
function openModalShell(opts = {}) {
  ensureStyle2();
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width)
    dialog.style.width = opts.width;
  if (opts.height)
    dialog.style.maxHeight = opts.height;
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }
  const headerEl = document.createElement("div");
  headerEl.className = "cmp-header";
  const titleEl = document.createElement("div");
  titleEl.className = "cmp-title";
  titleEl.textContent = opts.title || "";
  if (opts.subtitle) {
    const sub = document.createElement("span");
    sub.className = "cmp-subtitle";
    sub.textContent = opts.subtitle;
    titleEl.appendChild(sub);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  headerEl.append(titleEl, closeBtn);
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";
  const searchRow = document.createElement("div");
  searchRow.className = "cmp-searchrow";
  const searchEl = document.createElement("input");
  searchEl.type = "search";
  searchEl.className = "cmp-search";
  searchEl.placeholder = opts.placeholder || "Filter…";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const statusEl = document.createElement("div");
  statusEl.className = "cmp-status";
  searchRow.append(searchEl, statusEl);
  if (opts.showSearch === false)
    searchRow.style.display = "none";
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML)
      l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML)
      r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }
  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);
  let torn = false;
  const teardown = () => {
    if (torn)
      return;
    torn = true;
    try {
      backdrop.remove();
      dialog.remove();
      document.removeEventListener("keydown", onKey, true);
    } finally {
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn("[modal-shell] onClose threw", e);
      }
    }
  };
  const handle = { id: "modal-shell", element: dialog, close: teardown };
  const requestClose = () => {
    if (getActiveModal() === handle) {
      dismissActiveModal();
    } else {
      teardown();
    }
  };
  backdrop.addEventListener("pointerdown", requestClose);
  closeBtn.addEventListener("click", requestClose);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    try {
      opts.onKeyDown?.(e);
    } catch (err) {
      console.warn("[modal-shell] onKeyDown threw", err);
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop, dialog);
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    close: requestClose,
    _onKey: onKey,
    opts
  };
  setActiveModal(handle);
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (getActiveModal() === handle)
        searchEl.focus();
    });
  }
  return controller;
}

// src/index.ts
import { app } from "/scripts/app.js";
var EXT_NAME = "comfyui-prompt-editor";
var STYLE_ID3 = "pe-style";
var TARGET_WIDGET_NAMES = new Set([
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
  "wildcard_text"
]);
function isMultilineStringWidget(w) {
  if (!w || typeof w !== "object")
    return false;
  const widget = w;
  if (Array.isArray(widget.options?.values))
    return false;
  const opts = widget.options ?? {};
  const isTextarea = !!widget.inputEl && typeof widget.inputEl.tagName === "string" && widget.inputEl.tagName.toUpperCase() === "TEXTAREA";
  const typeStr = typeof widget.type === "string" ? widget.type.toLowerCase() : "";
  const looksMultiline = opts.multiline === true || isTextarea || typeStr === "customtext";
  if (!looksMultiline)
    return false;
  if (widget.value != null && typeof widget.value !== "string")
    return false;
  return true;
}
function isTargetWidget(w) {
  if (!w || typeof w !== "object")
    return false;
  const widget = w;
  if (isMultilineStringWidget(widget))
    return true;
  if (typeof widget.name !== "string" || !TARGET_WIDGET_NAMES.has(widget.name))
    return false;
  if (Array.isArray(widget.options?.values))
    return false;
  return typeof widget.value === "string";
}
function bumpWeight(text, selStart, selEnd, delta) {
  const src = typeof text === "string" ? text : "";
  let a = Number.isInteger(selStart) ? selStart : 0;
  let b = Number.isInteger(selEnd) ? selEnd : src.length;
  if (a > b)
    [a, b] = [b, a];
  a = Math.max(0, Math.min(a, src.length));
  b = Math.max(0, Math.min(b, src.length));
  let frag = src.slice(a, b);
  if (frag.trim() === "") {
    const isDelim = (ch) => ch === undefined || /[\s,]/.test(ch);
    let ws = a;
    let we = a;
    while (ws > 0 && !isDelim(src[ws - 1]))
      ws--;
    while (we < src.length && !isDelim(src[we]))
      we++;
    if (src.slice(ws, we).trim() !== "") {
      a = ws;
      b = we;
    } else {
      a = 0;
      b = src.length;
    }
    frag = src.slice(a, b);
  }
  if (frag.trim() === "") {
    return { text: src, selStart: a, selEnd: b };
  }
  const clamp = (n) => Math.max(0, Math.min(2, n));
  const fmt = (n) => {
    const r = Math.round(clamp(n) * 10) / 10;
    return r.toFixed(1);
  };
  const weighted = frag.match(/^\s*\((.*):\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/s);
  const emphasised = !weighted && frag.match(/^\s*\((.*)\)\s*$/s);
  let inner;
  let baseWeight;
  if (weighted) {
    inner = weighted[1] ?? "";
    baseWeight = Number.parseFloat(weighted[2] ?? "1");
  } else if (emphasised) {
    inner = emphasised[1] ?? "";
    baseWeight = 1.1;
  } else {
    inner = frag;
    baseWeight = 1;
  }
  const next = clamp(baseWeight + delta);
  const replacement = `(${inner}:${fmt(next)})`;
  const out = src.slice(0, a) + replacement + src.slice(b);
  return { text: out, selStart: a, selEnd: a + replacement.length };
}
function classifyEditableWidget(w) {
  if (!w || typeof w !== "object")
    return null;
  const widget = w;
  const typeStr = typeof widget.type === "string" ? widget.type.toLowerCase() : "";
  if (typeStr === "button" || typeStr === "converted-widget")
    return null;
  if (widget.hidden === true)
    return null;
  if (typeof widget.name !== "string" || widget.name === "")
    return null;
  if (Array.isArray(widget.options?.values))
    return "combo";
  if (isMultilineStringWidget(widget))
    return "multiline";
  const val = widget.value;
  if (typeof val === "boolean" || typeStr === "toggle")
    return "boolean";
  if (typeof val === "number" || typeStr === "number")
    return "number";
  if (typeof val === "string" || typeStr === "text" || typeStr === "string")
    return "text";
  return null;
}
function resolveNumberFormat(options) {
  const opts = options ?? {};
  const precision = opts.precision;
  const step2 = opts.step2;
  const legacyStep = opts.step;
  let isInt;
  if (typeof precision === "number") {
    isInt = precision === 0;
  } else if (typeof step2 === "number") {
    isInt = Number.isInteger(step2);
  } else if (typeof legacyStep === "number") {
    isInt = Number.isInteger(legacyStep / 10);
  } else {
    isInt = false;
  }
  const finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const realStep = typeof step2 === "number" ? step2 : typeof legacyStep === "number" ? legacyStep / 10 : undefined;
  const step = finite(realStep);
  return {
    isInt,
    min: finite(opts.min),
    max: finite(opts.max),
    step: step !== undefined && step > 0 ? step : undefined
  };
}
var CSS3 = `
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
`;
function ensureStyle3() {
  if (document.getElementById(STYLE_ID3))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID3;
  s.textContent = CSS3;
  document.head.appendChild(s);
}
function applyWidgetValue(widget, node, value) {
  widget.value = value;
  if (widget.inputEl && typeof widget.inputEl.value === "string" && typeof value === "string") {
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
function makeBtn(label, title, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pe-btn${cls ? ` ${cls}` : ""}`;
  b.textContent = label;
  if (title)
    b.title = title;
  return b;
}
function buildField(widget, kind, node = null) {
  const provider = resolveFieldProvider(widget, node);
  if (provider) {
    try {
      const ctl = provider.create({ widget, node, initialValue: widget.value });
      return {
        widget,
        kind,
        el: ctl.el,
        read: () => ctl.getValue(),
        changed: () => ctl.hasChanged(),
        focus: () => ctl.focus?.(),
        _destroy: () => ctl.destroy?.()
      };
    } catch (e) {
      console.warn(`[${EXT_NAME}] field provider for ${widget.name} failed; using built-in`, e);
    }
  }
  const el = document.createElement("div");
  el.className = "pe-field";
  const label = document.createElement("label");
  label.className = "pe-label";
  label.textContent = widget.name ?? "";
  el.appendChild(label);
  if (kind === "boolean") {
    const initial2 = widget.value === true;
    const row = document.createElement("div");
    row.className = "pe-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = initial2;
    const labelText = document.createElement("span");
    labelText.className = "pe-hint";
    const sync = () => {
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
      changed: () => input.checked !== initial2,
      focus: () => input.focus()
    };
  }
  if (kind === "combo") {
    const values = widget.options?.values ?? [];
    const initial2 = widget.value;
    const select = document.createElement("select");
    select.className = "pe-select";
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = String(v);
      if (String(v) === String(initial2))
        opt.selected = true;
      select.appendChild(opt);
    }
    el.appendChild(select);
    const read = () => {
      const hit = values.find((v) => String(v) === select.value);
      return hit === undefined ? select.value : hit;
    };
    return {
      widget,
      kind,
      el,
      read,
      changed: () => String(read()) !== String(initial2),
      focus: () => select.focus()
    };
  }
  if (kind === "number") {
    const originalValue = widget.value;
    const rawInitial = typeof originalValue === "number" ? originalValue : Number(originalValue);
    const initial2 = Number.isFinite(rawInitial) ? rawInitial : 0;
    const { isInt, min, max, step } = resolveNumberFormat(widget.options);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pe-input";
    input.value = String(initial2);
    input.inputMode = isInt ? "numeric" : "decimal";
    if (min !== undefined)
      input.min = String(min);
    if (max !== undefined)
      input.max = String(max);
    if (step !== undefined)
      input.step = String(step);
    el.appendChild(input);
    const read = () => {
      const n = Number.parseFloat(input.value);
      if (!Number.isFinite(n))
        return initial2;
      let v = n;
      if (min !== undefined)
        v = Math.max(min, v);
      if (max !== undefined)
        v = Math.min(max, v);
      return isInt ? Math.round(v) : v;
    };
    return {
      widget,
      kind,
      el,
      read,
      changed: () => read() !== originalValue,
      focus: () => input.focus()
    };
  }
  if (kind === "text") {
    const initial2 = typeof widget.value === "string" ? widget.value : "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pe-input";
    input.value = initial2;
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
      changed: () => input.value !== initial2,
      focus: () => input.focus()
    };
  }
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
  const stepWeight = (delta) => {
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
    }
  };
}
function openEditor(focusWidget, node) {
  ensureStyle3();
  const wrap = document.createElement("div");
  wrap.className = "pe-wrap";
  const fields = [];
  for (const w of node?.widgets ?? []) {
    const kind = classifyEditableWidget(w);
    if (!kind)
      continue;
    const field = buildField(w, kind, node);
    fields.push(field);
    wrap.appendChild(field.el);
  }
  if (fields.length === 0 && focusWidget) {
    const field = buildField(focusWidget, "multiline", node);
    fields.push(field);
    wrap.appendChild(field.el);
  }
  let committed = false;
  const commit = () => {
    if (committed)
      return;
    committed = true;
    const failedNames = [];
    for (const f of fields) {
      try {
        if (f.changed())
          applyWidgetValue(f.widget, node, f.read());
      } catch (e) {
        console.warn(`[${EXT_NAME}] write-back failed for ${f.widget.name}`, e);
        failedNames.push(f.widget.name ?? "(unnamed)");
      }
    }
    if (failedNames.length > 0) {
      notify({
        severity: "error",
        summary: "Some fields did not save",
        detail: failedNames.join(", ")
      });
    }
    modal.close();
  };
  const nodeTitle = node?.title ?? node?.type ?? "node";
  const modal = openModalShell({
    title: "Edit node",
    subtitle: nodeTitle,
    showSearch: false,
    showFooter: true,
    width: "min(960px, calc(100vw - 16px))",
    height: "min(92vh, 900px)",
    footerLeftHTML: '<span class="pe-hint">Cmd/Ctrl+Enter to save · Esc to cancel</span>',
    onKeyDown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    },
    onClose: () => {
      for (const f of fields) {
        try {
          f._destroy?.();
        } catch (e) {
          console.warn(`[${EXT_NAME}] field destroy failed for ${f.widget.name}`, e);
        }
      }
    }
  });
  modal.bodyEl.appendChild(wrap);
  const saveBtn = makeBtn("Save", "Save (Cmd/Ctrl+Enter)", "pe-btn-primary");
  saveBtn.addEventListener("click", commit);
  modal.footerEl.appendChild(saveBtn);
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
function enhanceNode(node) {
  if (!node?.widgets)
    return;
  const hasEditable = node.widgets.some((w) => classifyEditableWidget(w) !== null);
  if (!hasEditable)
    return;
  for (const w of node.widgets) {
    if (!isTargetWidget(w))
      continue;
    if (w._promptEditorPointerPatched)
      continue;
    w._promptEditorPointerPatched = true;
    patchWidgetPointer(w, (_pointer, ownerNode) => {
      openEditor(w, ownerNode || node);
      return true;
    });
  }
  if (!node._promptEditorNodeButtonAdded) {
    node._promptEditorNodeButtonAdded = true;
    try {
      const btn = node.addWidget?.("button", "⤢ Edit fields", null, () => {
        try {
          openEditor(null, node);
        } catch (e) {
          console.warn(`[${EXT_NAME}] open from button failed`, e);
        }
      }, { serialize: false });
      if (btn)
        btn.serialize = false;
      node.setDirtyCanvas?.(true, true);
    } catch (e) {
      console.warn(`[${EXT_NAME}] addWidget(button) failed`, e);
    }
  }
}
function refreshAllNodes() {
  const graph = app?.graph;
  if (!graph?._nodes)
    return;
  for (const node of graph._nodes)
    enhanceNode(node);
}
app.registerExtension({
  name: "comfy.prompt-editor",
  async setup() {
    refreshAllNodes();
  },
  async nodeCreated(node) {
    enhanceNode(node);
  },
  async loadedGraphNode(node) {
    enhanceNode(node);
  }
});
export {
  resolveNumberFormat,
  isTargetWidget,
  isMultilineStringWidget,
  classifyEditableWidget,
  bumpWeight,
  buildField,
  TARGET_WIDGET_NAMES
};
