// @vitest-environment jsdom
//
// Power Lora Loader ROW MANAGEMENT + the cross-pack model-picker path.
//
// Two halves:
//   1. Pure logic — dual-strength derivation from rgthree's node property, the
//      "None" sentinel, and the node.widgets splices that add/remove/reorder.
//   2. Real DOM (jsdom) — the filename control, the in-shell picker overlay, and
//      the row-action strip. This is the modal-DOM coverage the editor has
//      historically lacked; an empty-modal bug once shipped green because of it.
import { getModelPickers, openModalShell, registerModelPicker } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildField,
  canAddLoraRow,
  enhanceNode,
  isEmptyLoraFile,
  loraFileLabel,
  loraRowWidgets,
  loraShowsDualStrength,
  moveLoraRow,
  removeLoraRow,
} from "../../src/index.ts";

const row = (lora, extra = {}) => ({
  name: `lora_${lora}`,
  type: "custom",
  value: { on: true, lora, strength: 1, strengthTwo: null, ...extra },
});
// A non-lora widget of the kind rgthree interleaves between rows (divider,
// header, spacer, the "➕ Add Lora" button).
const chrome = (name) => ({ name, type: "custom", value: { type: name } });

// ============================================================
// Dual-strength mode
// ============================================================

describe("loraShowsDualStrength", () => {
  it("takes rgthree's node property as authoritative", () => {
    const separate = { properties: { "Show Strengths": "Separate Model & Clip" } };
    const single = { properties: { "Show Strengths": "Single Strength" } };
    // The property wins even when it disagrees with the row's own strengthTwo —
    // strengthTwo only reflects the LAST DRAW, so it is still null on a row
    // switched to separate mode but not yet redrawn. Deriving from it alone hid
    // the CLIP strength on exactly those rows.
    expect(loraShowsDualStrength(separate, { strengthTwo: null })).toBe(true);
    expect(loraShowsDualStrength(single, { strengthTwo: 0.5 })).toBe(false);
  });

  it("falls back to the value's own shape when the node has no property", () => {
    expect(loraShowsDualStrength(null, { strengthTwo: 0.5 })).toBe(true);
    expect(loraShowsDualStrength(null, { strengthTwo: null })).toBe(false);
    expect(loraShowsDualStrength({}, { strengthTwo: 0.5 })).toBe(true);
    expect(loraShowsDualStrength({ properties: {} }, { strengthTwo: null })).toBe(false);
  });

  it("renders two strength rows when the property says separate", () => {
    const node = { properties: { "Show Strengths": "Separate Model & Clip" }, widgets: [] };
    const w = row("x.safetensors");
    const f = buildField(w, "lora", node);
    expect(f.el.querySelectorAll(".pe-lora-strength-row").length).toBe(2);
    // The second strength is seeded from the first, matching rgthree's own
    // switch-to-separate behaviour.
    expect(f.read().strengthTwo).toBe(1);
  });

  it("renders one strength row when the property says single, even with a stale strengthTwo", () => {
    const node = { properties: { "Show Strengths": "Single Strength" }, widgets: [] };
    const f = buildField(row("x.safetensors", { strengthTwo: 0.5 }), "lora", node);
    expect(f.el.querySelectorAll(".pe-lora-strength-row").length).toBe(1);
    // The stale value is PRESERVED, not normalised — writing over an untouched
    // row would churn widgets_values.
    expect(f.read().strengthTwo).toBe(0.5);
    expect(f.changed()).toBe(false);
  });
});

// ============================================================
// The "None" sentinel
// ============================================================

describe('the "None" sentinel', () => {
  it("treats None / blank / non-string as no selection", () => {
    expect(isEmptyLoraFile("None")).toBe(true);
    expect(isEmptyLoraFile("none")).toBe(true);
    expect(isEmptyLoraFile("  ")).toBe(true);
    expect(isEmptyLoraFile("")).toBe(true);
    expect(isEmptyLoraFile(null)).toBe(true);
    expect(isEmptyLoraFile(undefined)).toBe(true);
    expect(isEmptyLoraFile("add_detail.safetensors")).toBe(false);
    // A real file that merely CONTAINS "none" is a selection.
    expect(isEmptyLoraFile("nonediscript.safetensors")).toBe(false);
  });

  it("labels a selection by basename and a sentinel as empty", () => {
    expect(loraFileLabel("sub/dir/my_lora.safetensors")).toBe("my_lora.safetensors");
    expect(loraFileLabel("win\\dir\\my_lora.safetensors")).toBe("my_lora.safetensors");
    expect(loraFileLabel("None")).toBe("");
    expect(loraFileLabel(null)).toBe("");
  });

  it("round-trips a stored None byte-for-byte on an untouched row", () => {
    const f = buildField(row("None"), "lora", null);
    expect(f.read().lora).toBe("None");
    expect(f.changed()).toBe(false);
  });

  it("falls back to the widget name for the card label when nothing is selected", () => {
    const f = buildField(row("None"), "lora", null);
    expect(f.el.querySelector(".pe-label").textContent).toBe("lora_None");
  });
});

// ============================================================
// Row management — plain node.widgets splices
// ============================================================

describe("row management", () => {
  it("finds the lora rows, skipping rgthree's interleaved chrome widgets", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [chrome("divider"), chrome("header"), a, b, chrome("spacer")] };
    expect(loraRowWidgets(node)).toEqual([a, b]);
    expect(loraRowWidgets(null)).toEqual([]);
    expect(loraRowWidgets({})).toEqual([]);
  });

  it("removes a row and leaves everything else in place", () => {
    const [a, b] = [row("a"), row("b")];
    const head = chrome("header");
    const node = { widgets: [head, a, b] };
    expect(removeLoraRow(node, a)).toBe(true);
    expect(node.widgets).toEqual([head, b]);
  });

  it("reports false for a widget that isn't on the node", () => {
    const node = { widgets: [row("a")] };
    expect(removeLoraRow(node, row("ghost"))).toBe(false);
    expect(removeLoraRow(null, row("a"))).toBe(false);
    expect(moveLoraRow(null, row("a"), 1)).toBe(false);
  });

  it("reorders rows — node.widgets order IS widgets_values order", () => {
    const [a, b, c] = [row("a"), row("b"), row("c")];
    const node = { widgets: [a, b, c] };
    expect(moveLoraRow(node, c, -1)).toBe(true);
    expect(loraRowWidgets(node)).toEqual([a, c, b]);
    expect(moveLoraRow(node, a, 1)).toBe(true);
    expect(loraRowWidgets(node)).toEqual([c, a, b]);
  });

  it("steps over interleaved chrome widgets when reordering", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [chrome("divider"), a, chrome("spacer"), b] };
    expect(moveLoraRow(node, b, -1)).toBe(true);
    expect(loraRowWidgets(node)).toEqual([b, a]);
  });

  it("refuses to move the first row up or the last row down", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [chrome("divider"), a, b, chrome("spacer")] };
    expect(moveLoraRow(node, a, -1)).toBe(false);
    expect(moveLoraRow(node, b, 1)).toBe(false);
    expect(loraRowWidgets(node)).toEqual([a, b]);
  });

  it("probes for rgthree's row factory rather than assuming it", () => {
    expect(canAddLoraRow({ addNewLoraWidget: () => undefined })).toBe(true);
    expect(canAddLoraRow({})).toBe(false);
    expect(canAddLoraRow({ addNewLoraWidget: "not a function" })).toBe(false);
    expect(canAddLoraRow(null)).toBe(false);
  });
});

// ============================================================
// Entry-point button reachability on a node that clears its own widgets
// ============================================================
//
// REGRESSION GUARD. rgthree's Power Lora Loader wipes every widget in
// configure() — `while (this.widgets?.length) this.removeWidget(0)` — and
// configure() runs AFTER nodeCreated on a loaded graph. With a once-per-node
// boolean stamp the sequence was: nodeCreated adds the button and stamps →
// configure() deletes the button → loadedGraphNode sees the stamp and skips →
// the editor is unreachable on every LOADED Power Lora Loader, while working
// fine on a freshly dropped one. Idempotency must therefore be by PRESENCE.

const EDIT_LABEL = "⤢ Edit fields";

// A node whose addWidget behaves like LiteGraph's: name from arg 2, appended.
const fakeNode = (widgets = []) => {
  const node = {
    widgets,
    setDirtyCanvas: () => {},
    addWidget(type, name, value, callback, options) {
      const w = { type, name, value, callback, options };
      node.widgets.push(w);
      return w;
    },
  };
  return node;
};

describe("the node-level entry-point button", () => {
  it("is appended once, and not duplicated by repeated enhance passes", () => {
    const node = fakeNode([row("a")]);
    enhanceNode(node);
    enhanceNode(node);
    enhanceNode(node);
    expect(node.widgets.filter((w) => w.name === EDIT_LABEL)).toHaveLength(1);
  });

  it("is re-added after the node clears its own widgets (rgthree configure())", () => {
    const node = fakeNode([row("a")]);
    enhanceNode(node); // nodeCreated
    expect(node.widgets.some((w) => w.name === EDIT_LABEL)).toBe(true);

    // rgthree's configure(): wipe every widget, then rebuild its own.
    node.widgets.length = 0;
    node.widgets.push(chrome("divider"), chrome("header"), row("a"));

    enhanceNode(node); // loadedGraphNode
    expect(node.widgets.some((w) => w.name === EDIT_LABEL)).toBe(true);
  });

  it("stays LAST so a serialize:false widget never shifts widgets_values", () => {
    const node = fakeNode([row("a")]);
    enhanceNode(node);
    const btn = node.widgets[node.widgets.length - 1];
    expect(btn.name).toBe(EDIT_LABEL);
    expect(btn.serialize).toBe(false);
  });

  it("is skipped entirely on a node with nothing editable", () => {
    const node = fakeNode([{ name: "preview", type: "button", value: null }]);
    enhanceNode(node);
    expect(node.widgets.some((w) => w.name === EDIT_LABEL)).toBe(false);
  });
});

// ============================================================
// The row-action strip (DOM)
// ============================================================

describe("row-action strip", () => {
  const build = (widget, node) =>
    buildField(widget, "lora", node, undefined, { rebuild: () => {} });

  it("is absent without a rebuild hook — an affordance that can't finish is worse than none", () => {
    const [a, b] = [row("a"), row("b")];
    const f = buildField(a, "lora", { widgets: [a, b] });
    expect(f.el.querySelector(".pe-lora-actions")).toBeNull();
  });

  it("disables ↑ on the first row and ↓ on the last", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [a, b] };
    const [upA, downA] = build(a, node).el.querySelectorAll(".pe-lora-act");
    expect(upA.disabled).toBe(true);
    expect(downA.disabled).toBe(false);
    const [upB, downB] = build(b, node).el.querySelectorAll(".pe-lora-act");
    expect(upB.disabled).toBe(false);
    expect(downB.disabled).toBe(true);
  });

  it("removes the row and rebuilds when ⨯ is tapped", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [a, b], setDirtyCanvas: vi.fn() };
    const rebuild = vi.fn();
    const f = buildField(a, "lora", node, undefined, { rebuild });
    f.el.querySelector(".pe-lora-del").click();
    expect(node.widgets).toEqual([b]);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(node.setDirtyCanvas).toHaveBeenCalled();
  });

  it("reorders and rebuilds when ↓ is tapped", () => {
    const [a, b] = [row("a"), row("b")];
    const node = { widgets: [a, b] };
    const rebuild = vi.fn();
    const f = buildField(a, "lora", node, undefined, { rebuild });
    f.el.querySelectorAll(".pe-lora-act")[1].click(); // ↓
    expect(node.widgets).toEqual([b, a]);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild when the operation is a no-op", () => {
    const a = row("a");
    const node = { widgets: [a] };
    const rebuild = vi.fn();
    const f = buildField(a, "lora", node, undefined, { rebuild });
    const [up, down] = f.el.querySelectorAll(".pe-lora-act");
    // Both ends: the only row is simultaneously first and last.
    up.disabled = false;
    down.disabled = false;
    up.click();
    down.click();
    expect(rebuild).not.toHaveBeenCalled();
  });
});

// ============================================================
// The cross-pack model-picker path (DOM + in-shell overlay)
// ============================================================

describe("model-picker filename control", () => {
  let shell;

  // A stand-in for comfyui-model-gallery's registered ModelPicker. Deliberately
  // exercises the OPTIONAL members (onValueChange, createSummary) since those are
  // what the host's overlay logic hangs off.
  const fakePicker = (over = {}) => ({
    id: "test:loras",
    priority: 10,
    supports: (c) => c === "loras",
    create: ({ initialValue }) => {
      let value = initialValue;
      let cb = null;
      const el = document.createElement("div");
      el.className = "fake-grid";
      const card = document.createElement("button");
      card.className = "fake-card";
      card.addEventListener("click", () => {
        value = "picked/new_lora.safetensors";
        cb?.(value);
      });
      el.appendChild(card);
      return {
        el,
        getValue: () => value,
        hasChanged: () => value !== initialValue,
        onValueChange: (fn) => {
          cb = fn;
        },
        destroy: vi.fn(),
      };
    },
    createSummary: ({ value }) => {
      const s = document.createElement("div");
      s.className = "fake-summary";
      s.textContent = value;
      return s;
    },
    ...over,
  });

  beforeEach(() => {
    getModelPickers().length = 0;
    shell = openModalShell({ title: "t", showFooter: true });
  });
  afterEach(() => {
    getModelPickers().length = 0;
    shell?.close();
    document.body.replaceChildren();
  });

  const hooks = () => ({ getShell: () => shell, rebuild: () => {} });

  it("keeps the plain text input when no picker is registered (additive fallback)", () => {
    const f = buildField(row("a.safetensors"), "lora", null, undefined, hooks());
    const input = f.el.querySelector(".pe-lora-name");
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("a.safetensors");
    expect(f.el.querySelector(".pe-lora-summary")).toBeNull();
  });

  it("keeps the plain text input when there is a picker but no host shell", () => {
    registerModelPicker(fakePicker());
    const f = buildField(row("a.safetensors"), "lora", null, undefined, { rebuild: () => {} });
    expect(f.el.querySelector(".pe-lora-name").tagName).toBe("INPUT");
  });

  it("renders a tappable button showing the basename once a picker is registered", () => {
    registerModelPicker(fakePicker());
    const f = buildField(row("sub/a.safetensors"), "lora", null, undefined, hooks());
    const btn = f.el.querySelector(".pe-lora-name");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toBe("a.safetensors");
  });

  it('shows "None" on the button for an unset row', () => {
    registerModelPicker(fakePicker());
    const f = buildField(row("None"), "lora", null, undefined, hooks());
    expect(f.el.querySelector(".pe-lora-name").textContent).toBe("None");
  });

  it("mounts the summary strip for a selected file and omits it for None", () => {
    registerModelPicker(fakePicker());
    const withFile = buildField(row("a.safetensors"), "lora", null, undefined, hooks());
    expect(withFile.el.querySelector(".fake-summary").textContent).toBe("a.safetensors");
    const withNone = buildField(row("None"), "lora", null, undefined, hooks());
    expect(withNone.el.querySelector(".fake-summary")).toBeNull();
  });

  it("survives a createSummary that throws — the strip is decoration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerModelPicker(
      fakePicker({
        createSummary: () => {
          throw new Error("summary exploded");
        },
      }),
    );
    const f = buildField(row("a.safetensors"), "lora", null, undefined, hooks());
    expect(f.el.querySelector(".pe-lora-name").tagName).toBe("BUTTON");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("the in-shell overlay", () => {
    const openOverlay = (widget = row("a.safetensors")) => {
      registerModelPicker(fakePicker());
      const f = buildField(widget, "lora", null, undefined, hooks());
      f.el.querySelector(".pe-lora-name").click();
      return { f, card: shell.dialog.querySelector(".cmp-ov-card") };
    };

    it("opens inside the shell dialog, not as a second modal", () => {
      const { card } = openOverlay();
      expect(card).not.toBeNull();
      // Single-modal discipline: exactly one shell dialog on screen.
      expect(document.querySelectorAll(".cmp-dialog, .cmp-backdrop").length).toBeGreaterThan(0);
      expect(shell.dialog.querySelectorAll(".cmp-ov-card").length).toBe(1);
    });

    it("wraps the picker element in the host's own scroll region", () => {
      // THE detail that breaks this otherwise: .cmp-ov-card has no scroll region
      // and ModelPickerControl.el is contractually not one either, so without
      // this wrapper the grid is clipped and files below the fold are
      // unreachable.
      const { card } = openOverlay();
      const scroll = card.querySelector(".pe-pick-scroll");
      expect(scroll).not.toBeNull();
      expect(scroll.querySelector(".fake-grid")).not.toBeNull();
    });

    it("keeps Choose disabled until a card is actually selected", () => {
      const { card } = openOverlay();
      const choose = [...card.querySelectorAll("button")].find((b) => b.textContent === "Choose");
      expect(choose.disabled).toBe(true);
      card.querySelector(".fake-card").click();
      expect(choose.disabled).toBe(false);
    });

    it("enables Choose up front for a picker with no change signal", () => {
      registerModelPicker(fakePicker({ create: undefined }));
      // Re-register with a create() that omits onValueChange entirely.
      registerModelPicker({
        id: "test:loras",
        supports: (c) => c === "loras",
        create: () => ({
          el: document.createElement("div"),
          getValue: () => "x.safetensors",
          hasChanged: () => false,
        }),
      });
      const f = buildField(row("a.safetensors"), "lora", null, undefined, hooks());
      f.el.querySelector(".pe-lora-name").click();
      const choose = [...shell.dialog.querySelectorAll(".cmp-ov-card button")].find(
        (b) => b.textContent === "Choose",
      );
      expect(choose.disabled).toBe(false);
    });

    it("commits the chosen file to the button, label, and read()", async () => {
      const { f, card } = openOverlay();
      card.querySelector(".fake-card").click();
      [...card.querySelectorAll("button")].find((b) => b.textContent === "Choose").click();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.read().lora).toBe("picked/new_lora.safetensors");
      expect(f.changed()).toBe(true);
      expect(f.el.querySelector(".pe-lora-name").textContent).toBe("new_lora.safetensors");
      expect(f.el.querySelector(".pe-label").textContent).toBe("new_lora.safetensors");
      expect(f.el.querySelector(".fake-summary").textContent).toBe("picked/new_lora.safetensors");
    });

    it("leaves the row untouched on Cancel", async () => {
      const { f, card } = openOverlay();
      card.querySelector(".fake-card").click();
      [...card.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.read().lora).toBe("a.safetensors");
      expect(f.changed()).toBe(false);
      expect(shell.dialog.querySelector(".cmp-ov-card")).toBeNull();
    });

    it("leaves the row untouched when dismissed with Esc", async () => {
      const { f } = openOverlay();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
      await Promise.resolve();
      expect(f.read().lora).toBe("a.safetensors");
      expect(f.changed()).toBe(false);
    });

    it("preserves the toggle and strengths across a pick", async () => {
      const { f, card } = openOverlay(row("a.safetensors", { strength: 0.65 }));
      card.querySelector(".fake-card").click();
      [...card.querySelectorAll("button")].find((b) => b.textContent === "Choose").click();
      await Promise.resolve();
      await Promise.resolve();
      const v = f.read();
      expect(v.on).toBe(true);
      expect(v.strength).toBe(0.65);
      expect(v.strengthTwo).toBeNull();
    });
  });
});
