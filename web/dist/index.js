// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var STYLE_ID = "cmp-shell-style";
var ACTIVE = null;
var CSS = `
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
function ensureStyle() {
  if (document.getElementById(STYLE_ID))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
function dismissActive() {
  if (!ACTIVE)
    return;
  const a = ACTIVE;
  ACTIVE = null;
  try {
    a.backdrop.remove();
    a.dialog.remove();
    document.removeEventListener("keydown", a._onKey, true);
  } finally {
    try {
      a.opts.onClose?.();
    } catch (e) {
      console.warn("[modal-shell] onClose threw", e);
    }
  }
}
function openModalShell(opts = {}) {
  ensureStyle();
  dismissActive();
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  backdrop.addEventListener("pointerdown", dismissActive);
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
  closeBtn.addEventListener("click", dismissActive);
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
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissActive();
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
    close: dismissActive,
    _onKey: onKey,
    opts
  };
  ACTIVE = controller;
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (ACTIVE === controller)
        searchEl.focus();
    });
  }
  return controller;
}

// src/index.ts
import { app } from "/scripts/app.js";
var EXT_NAME = "comfyui-prompt-editor";
var STYLE_ID2 = "pe-style";
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
var CSS2 = `
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
function ensureStyle2() {
  if (document.getElementById(STYLE_ID2))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID2;
  s.textContent = CSS2;
  document.head.appendChild(s);
}
function applyValue(widget, node, value) {
  if (typeof value !== "string")
    return;
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
function openEditor(widget, node) {
  ensureStyle2();
  const initial = typeof widget?.value === "string" ? widget.value : "";
  const wrap = document.createElement("div");
  wrap.className = "pe-wrap";
  const bar = document.createElement("div");
  bar.className = "pe-bar";
  const makeBtn = (label, title, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `pe-btn${cls ? ` ${cls}` : ""}`;
    b.textContent = label;
    if (title)
      b.title = title;
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
  const commit = () => {
    if (committed)
      return;
    committed = true;
    try {
      if (textarea.value !== initial) {
        applyValue(widget, node, textarea.value);
      }
    } catch (e) {
      console.warn(`[${EXT_NAME}] write-back failed`, e);
    }
    modal.close();
  };
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
  const modal = openModalShell({
    title: "Edit prompt",
    subtitle: widget?.name,
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
    onClose: () => {}
  });
  modal.bodyEl.appendChild(wrap);
  const saveBtn = makeBtn("Save", "Save (Cmd/Ctrl+Enter)", "pe-btn-primary");
  saveBtn.addEventListener("click", commit);
  bar.appendChild(saveBtn);
  requestAnimationFrame(() => {
    try {
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
      textarea.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      console.warn(`[${EXT_NAME}] focus/scroll failed`, e);
    }
  });
  return modal;
}
function enhanceNode(node) {
  if (!node?.widgets)
    return;
  for (const w of node.widgets) {
    if (!isTargetWidget(w))
      continue;
    if (!w._promptEditorPointerPatched) {
      w._promptEditorPointerPatched = true;
      const origDown = w.onPointerDown;
      w.onPointerDown = function(pointer, ownerNode, canvas) {
        try {
          if (typeof origDown === "function") {
            const consumed = origDown.call(this, pointer, ownerNode, canvas);
            if (consumed)
              return consumed;
          }
          openEditor(w, ownerNode || node);
          return true;
        } catch (e) {
          console.warn(`[${EXT_NAME}] editor open failed`, e);
          return false;
        }
      };
    }
    if (!w._promptEditorButtonAdded) {
      w._promptEditorButtonAdded = true;
      try {
        const btn = node.addWidget?.("button", `⤢ ${w.name}`, null, () => {
          try {
            openEditor(w, node);
          } catch (e) {
            console.warn(`[${EXT_NAME}] open from button failed`, e);
          }
        }, { serialize: false });
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
  isTargetWidget,
  isMultilineStringWidget,
  bumpWeight,
  TARGET_WIDGET_NAMES
};
