// @vitest-environment jsdom
//
// The sibling-field bus: the host half of comfy-modal-kit >= 0.7.0's
// field-provider sibling contract.
//
// The correctness trap it exists for: this editor edits many widgets at once and
// only writes back on commit(), so node.widgets[] holds the COMMITTED value —
// the one from before the modal opened. A sibling-aware control (sampler-info's
// scheduler picker cross-referencing the selected SAMPLER) must see the LIVE,
// uncommitted in-modal value. These tests assert exactly that difference.

import { registerFieldProvider } from "@laurigates/comfy-modal-kit";
import { describe, expect, it, vi } from "vitest";
import { buildField, createFieldBus } from "../../src/index.ts";

/** Build the field rows for a node the way openEditor does: bus first, rows lazily. */
function openFields(node, kinds) {
  const fields = [];
  const bus = createFieldBus(fields, node);
  for (const w of node.widgets) {
    const kind = kinds[w.name];
    if (!kind) continue;
    const f = buildField(w, kind, node, bus);
    fields.push(f);
  }
  return { fields, bus };
}

function samplerNode() {
  return {
    widgets: [
      {
        name: "sampler_name",
        type: "combo",
        value: "euler",
        options: { values: ["euler", "dpmpp_2m", "ddim"] },
      },
      {
        name: "scheduler",
        type: "combo",
        value: "normal",
        options: { values: ["normal", "karras"] },
      },
    ],
  };
}

describe("field bus — live vs committed value", () => {
  it("returns a live sibling's UNCOMMITTED value, not the node's committed one", () => {
    const node = samplerNode();
    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });

    // The user picks a different sampler in the modal. Nothing is committed yet.
    const select = fields[0].el.querySelector("select");
    select.value = "dpmpp_2m";
    select.dispatchEvent(new Event("change"));

    expect(bus.getSiblingValue("sampler_name")).toBe("dpmpp_2m");
    // The key assertion: the node still holds the pre-modal value.
    expect(node.widgets[0].value).toBe("euler");
    expect(bus.getSiblingValue("sampler_name")).not.toBe(node.widgets[0].value);
  });

  it("falls back to the node's committed value when no row is live for the name", () => {
    const node = samplerNode();
    // Only the scheduler gets a row — sampler_name has no live field.
    const { bus } = openFields(node, { scheduler: "combo" });
    expect(bus.getSiblingValue("sampler_name")).toBe("euler");
  });

  it("returns undefined for a widget that exists nowhere", () => {
    const { bus } = openFields(samplerNode(), {});
    expect(bus.getSiblingValue("nonexistent")).toBeUndefined();
  });

  it("falls back to the committed value when a sibling's read() throws", () => {
    const node = samplerNode();
    const fields = [];
    const bus = createFieldBus(fields, node);
    fields.push({
      widget: node.widgets[0],
      kind: "combo",
      el: document.createElement("div"),
      read: () => {
        throw new Error("boom");
      },
      changed: () => false,
      focus: () => {},
    });
    expect(bus.getSiblingValue("sampler_name")).toBe("euler");
  });

  it("resolves a sibling whose row is built AFTER the asking control (lazy lookup)", () => {
    const node = samplerNode();
    const fields = [];
    const bus = createFieldBus(fields, node);
    // The scheduler control asks for a sampler row that does not exist yet.
    const capturedBeforeSampler = bus.getSiblingValue("sampler_name");
    fields.push(buildField(node.widgets[0], "combo", node, bus));
    const sel = fields[0].el.querySelector("select");
    sel.value = "ddim";
    sel.dispatchEvent(new Event("change"));

    expect(capturedBeforeSampler).toBe("euler"); // committed fallback at that moment
    expect(bus.getSiblingValue("sampler_name")).toBe("ddim"); // live once the row exists
  });
});

describe("field bus — subscriptions", () => {
  it("notifies a subscriber when a SIBLING changes, and never on its own change", () => {
    const node = samplerNode();
    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    const seen = [];
    bus.subscribe(node.widgets[1], (name, value) => seen.push([name, value]));

    // Sibling change → delivered.
    const samplerSel = fields[0].el.querySelector("select");
    samplerSel.value = "ddim";
    samplerSel.dispatchEvent(new Event("change"));

    // The subscriber's OWN field changes → must NOT be delivered (feedback loop).
    const schedSel = fields[1].el.querySelector("select");
    schedSel.value = "karras";
    schedSel.dispatchEvent(new Event("change"));

    expect(seen).toEqual([["sampler_name", "ddim"]]);
  });

  it("stops delivering after unsubscribe", () => {
    const node = samplerNode();
    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    const cb = vi.fn();
    const off = bus.subscribe(node.widgets[1], cb);

    const sel = fields[0].el.querySelector("select");
    sel.value = "ddim";
    sel.dispatchEvent(new Event("change"));
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    sel.value = "dpmpp_2m";
    sel.dispatchEvent(new Event("change"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("destroy() drops every subscriber (modal close)", () => {
    const node = samplerNode();
    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    const cb = vi.fn();
    bus.subscribe(node.widgets[1], cb);
    bus.destroy();

    const sel = fields[0].el.querySelector("select");
    sel.value = "ddim";
    sel.dispatchEvent(new Event("change"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("one throwing subscriber does not stop delivery to the others", () => {
    const node = samplerNode();
    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    const good = vi.fn();
    bus.subscribe(null, () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe(node.widgets[1], good);

    const sel = fields[0].el.querySelector("select");
    sel.value = "ddim";
    sel.dispatchEvent(new Event("change"));
    expect(good).toHaveBeenCalledWith("sampler_name", "ddim");
  });
});

describe("field bus — built-in controls feed it", () => {
  it("a text field's typing reaches a subscriber", () => {
    const node = { widgets: [{ name: "title", type: "text", value: "a" }] };
    const { fields, bus } = openFields(node, { title: "text" });
    const seen = [];
    bus.subscribe(null, (name, value) => seen.push([name, value]));

    const input = fields[0].el.querySelector("input");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    expect(seen).toEqual([["title", "abc"]]);
  });

  it("a number field reports its coerced value", () => {
    const node = {
      widgets: [{ name: "steps", type: "number", value: 20, options: { precision: 0, step2: 1 } }],
    };
    const { fields, bus } = openFields(node, { steps: "number" });
    const cb = vi.fn();
    bus.subscribe(null, cb);

    const input = fields[0].el.querySelector("input");
    input.value = "30.4";
    input.dispatchEvent(new Event("input"));
    expect(cb).toHaveBeenCalledWith("steps", 30); // int-rounded, as commit would write it
  });

  it("a toggle reports its boolean", () => {
    const node = { widgets: [{ name: "enabled", type: "toggle", value: false }] };
    const { fields, bus } = openFields(node, { enabled: "boolean" });
    const cb = vi.fn();
    bus.subscribe(null, cb);

    const input = fields[0].el.querySelector("input");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(cb).toHaveBeenCalledWith("enabled", true);
  });
});

describe("field bus — provider integration (kit 0.7.0 contract)", () => {
  // The kit's registry is idempotent by id: re-registering PROVIDER_ID replaces
  // the prior entry, so each test's provider is the only one matching.
  const PROVIDER_ID = "test-scheduler-provider";

  it("hands a provider getSiblingValue/onSiblingChange and fans its onValueChange out", () => {
    const node = samplerNode();
    const heard = [];
    let siblingAtCreate;
    let emit;

    registerFieldProvider({
      id: PROVIDER_ID,
      priority: 100,
      match: (w) => w.name === "scheduler",
      create: (ctx) => {
        siblingAtCreate = ctx.getSiblingValue?.("sampler_name");
        ctx.onSiblingChange?.((name, value) => heard.push([name, value]));
        const el = document.createElement("div");
        let value = ctx.initialValue;
        return {
          el,
          getValue: () => value,
          hasChanged: () => value !== ctx.initialValue,
          onValueChange: (cb) => {
            emit = (v) => {
              value = v;
              cb(v);
            };
          },
        };
      },
    });

    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    // The provider's row is built second, so at create() time it sees the
    // sampler's live row (already built) — the committed value, untouched so far.
    expect(siblingAtCreate).toBe("euler");

    // A built-in <select> sibling change reaches the provider's control. This is
    // the half-dead case the built-in wiring exists for: only ONE of the two
    // widgets has a provider.
    const sel = fields[0].el.querySelector("select");
    sel.value = "dpmpp_2m";
    sel.dispatchEvent(new Event("change"));
    expect(heard).toEqual([["sampler_name", "dpmpp_2m"]]);

    // And the provider's own change fans out through the bus to other listeners
    // without echoing back to itself.
    const others = [];
    bus.subscribe(null, (name, value) => others.push([name, value]));
    emit("karras");
    expect(others).toEqual([["scheduler", "karras"]]);
    expect(heard).toEqual([["sampler_name", "dpmpp_2m"]]); // no self-notification
  });

  it("a provider that ignores the bus entirely still works (additive)", () => {
    const node = samplerNode();
    registerFieldProvider({
      id: PROVIDER_ID,
      priority: 100,
      match: (w) => w.name === "scheduler",
      create: (ctx) => ({
        el: document.createElement("div"),
        getValue: () => ctx.initialValue,
        hasChanged: () => false,
      }),
    });

    const { fields, bus } = openFields(node, { sampler_name: "combo", scheduler: "combo" });
    expect(fields).toHaveLength(2);
    expect(bus.getSiblingValue("scheduler")).toBe("normal");
  });

  it("buildField still works with no bus at all (existing call sites)", () => {
    const w = { name: "title", type: "text", value: "x" };
    const f = buildField(w, "text");
    const input = f.el.querySelector("input");
    input.value = "y";
    input.dispatchEvent(new Event("input"));
    expect(f.read()).toBe("y");
  });
});
