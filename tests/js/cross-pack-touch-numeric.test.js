// @vitest-environment jsdom
//
// Cross-pack integration: comfyui-prompt-editor (host) + comfyui-touch-numeric
// (field provider), both loaded from REAL source, meeting through the real
// @laurigates/comfy-modal-kit field registry.
//
// Why this file exists. Every other suite in either repo tests one pack against
// a synthetic counterpart — `field-bus.test.js` registers a fake
// `test-scheduler-provider`, and touch-numeric's own suite drives its provider
// with a hand-built context. Both passed continuously while a real, visible
// defect shipped: mounted inline, touch-numeric rendered a segmented control
// for `control_after_generate` — a widget the host ALREADY renders its own row
// for. Two controls for one widget, with opposite commit timing (the segment
// wrote through immediately, the host's <select> defers to Save), so tapping
// the segment and then saving let the host's staler value overwrite the newer
// one. No single-pack test can see that: it is a property of the PAIR.
//
// touch-numeric is installed as a git dependency pinned to a release tag (see
// package.json), and vitest is told to inline it (see vitest.config.js) so its
// TypeScript is transformed rather than externalized. Pinning to a tag means
// this suite tests against a PUBLISHED touch-numeric, not a moving branch — a
// bump is a deliberate, reviewable change.
//
// Import order matters and mirrors the browser: the provider pack registers
// itself as a module side effect, so it must be imported before the host opens
// an editor. In the browser each pack inlines its own copy of the kit and they
// rendezvous through a window global; here they share one module instance,
// which exercises the same registry code by a shorter path.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import "comfyui-touch-numeric/src/index.ts";
import { openEditor } from "../../src/index.ts";

beforeAll(async () => {
  // touch-numeric's Randomize reads `crypto` at call time.
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    const { webcrypto } = await import("node:crypto");
    globalThis.crypto = webcrypto;
  }
});

const CONTROL_VALUES = ["fixed", "increment", "decrement", "randomize"];
const SAMPLERS = ["euler", "dpmpp_2m", "ddim"];
const SCHEDULERS = ["normal", "karras", "simple"];

/** A core KSampler, in core widget order. */
function ksampler({ seed = 12345, control = "fixed" } = {}) {
  const widgets = [
    { name: "seed", type: "number", value: seed, options: { min: 0, max: 0xffffffff } },
    {
      name: "control_after_generate",
      type: "combo",
      value: control,
      options: { values: [...CONTROL_VALUES] },
    },
    { name: "steps", type: "number", value: 20, options: { min: 1, max: 100 } },
    { name: "cfg", type: "number", value: 8, options: { min: 0, max: 30, step: 0.1 } },
    { name: "sampler_name", type: "combo", value: "euler", options: { values: [...SAMPLERS] } },
    { name: "scheduler", type: "combo", value: "normal", options: { values: [...SCHEDULERS] } },
    { name: "denoise", type: "number", value: 1, options: { min: 0, max: 1, step: 0.01 } },
  ];
  return { node: { widgets, title: "KSampler", type: "KSampler" }, widgets };
}

/** Widget lookup by name, so assertions read in domain terms. */
const w = (fixture, name) => fixture.widgets.find((x) => x.name === name);

/** Every <select> in the dialog whose option set is exactly `values`. */
function selectsFor(root, values) {
  return [...root.querySelectorAll("select")].filter((s) => {
    const opts = [...s.options].map((o) => o.value);
    return opts.length === values.length && opts.every((v, i) => v === values[i]);
  });
}

let modal;

beforeEach(() => {
  document.body.replaceChildren();
  modal = null;
});

function open(fixture, focus = null) {
  modal = openEditor(focus, fixture.node);
  return modal.dialogEl ?? document.body;
}

describe("seed field: the provider mounts, and mounts only once", () => {
  it("renders touch-numeric's keypad for the seed widget", () => {
    const f = ksampler();
    const root = open(f);
    // The provider won the seed field — this is the whole point of the registry.
    expect(root.querySelectorAll(".tn-seed").length).toBe(1);
    expect(root.querySelectorAll(".tn-key").length).toBe(12);
  });

  it("renders exactly ONE control bound to control_after_generate", () => {
    const f = ksampler();
    const root = open(f);

    // The regression this whole file exists for. The host owns this widget's
    // row; the provider must not render a second control for it.
    expect(root.querySelectorAll(".tn-seg").length).toBe(0);
    expect(selectsFor(root, CONTROL_VALUES).length).toBe(1);
  });

  it("does not surface the provider's keypad-lock latch inline", () => {
    // Per-dialog state the host cannot read through getValue()/hasChanged(),
    // so it could never gate the host's Save.
    const root = open(ksampler());
    const lock = [...root.querySelectorAll("button")].filter((b) => /lock/i.test(b.textContent));
    expect(lock).toEqual([]);
  });

  it("still renders the host's own rows for every other editable widget", () => {
    // Guard the opposite failure: a provider must not suppress unrelated rows.
    const root = open(ksampler());
    expect(selectsFor(root, SAMPLERS).length).toBe(1);
    expect(selectsFor(root, SCHEDULERS).length).toBe(1);
    expect(root.textContent).toMatch(/steps/);
    expect(root.textContent).toMatch(/denoise/);
  });
});

describe("commit is single-path: nothing writes behind the host's back", () => {
  it("leaves every widget untouched while the editor is open", () => {
    const f = ksampler({ seed: 12345, control: "fixed" });
    const root = open(f);

    // Interact with everything the provider rendered. Previously the segmented
    // control committed on tap, so this loop mutated control_after_generate.
    for (const btn of root.querySelectorAll(".tn-seed button")) btn.click();

    expect(w(f, "control_after_generate").value).toBe("fixed");
    expect(w(f, "seed").value).toBe(12345);
  });

  it("dismissing without Save discards edits from both packs' controls", () => {
    const f = ksampler({ seed: 12345, control: "fixed" });
    const root = open(f);

    selectsFor(root, CONTROL_VALUES)[0].value = "increment";
    selectsFor(root, CONTROL_VALUES)[0].dispatchEvent(new Event("change"));
    root.querySelector(".tn-key").click();

    modal.close();

    expect(w(f, "control_after_generate").value).toBe("fixed");
    expect(w(f, "seed").value).toBe(12345);
  });

  it("Save writes the host's control_after_generate choice, not a stale one", () => {
    // The lost-update regression, end to end. With a live-writing segment
    // present this could resolve to whichever surface wrote last rather than
    // what the user last chose.
    const f = ksampler({ seed: 12345, control: "fixed" });
    const root = open(f);

    const sel = selectsFor(root, CONTROL_VALUES)[0];
    sel.value = "randomize";
    sel.dispatchEvent(new Event("change"));

    root.querySelector('button[title="Save (Cmd/Ctrl+Enter)"]').click();

    expect(w(f, "control_after_generate").value).toBe("randomize");
  });

  it("Save commits a seed edited on the provider's keypad", () => {
    const f = ksampler({ seed: 12345 });
    const root = open(f);

    // "C" clears to 0, then "7" appends a digit -> 7.
    const keys = [...root.querySelectorAll(".tn-key")];
    keys.find((k) => k.textContent === "C").click();
    keys.find((k) => k.textContent === "7").click();

    root.querySelector('button[title="Save (Cmd/Ctrl+Enter)"]').click();

    expect(w(f, "seed").value).toBe(7);
  });

  it("Save leaves an untouched seed exactly as it was", () => {
    // hasChanged() must not churn a widget the user never touched.
    const f = ksampler({ seed: 987654321 });
    const root = open(f);
    root.querySelector('button[title="Save (Cmd/Ctrl+Enter)"]').click();
    expect(w(f, "seed").value).toBe(987654321);
  });
});

describe("the mounted control respects the host's layout contract", () => {
  it("mounts no inner scroll container inside the field row", () => {
    // kit field-registry.ts documents this: the host modal owns the single
    // scroll region (.cmp-body), and an inline control that scrolls internally
    // swallows the field-list gesture without being able to chain it back out.
    //
    // Read the REAL cascade. Each pack injects its stylesheet via
    // ensureStyleOnce and jsdom resolves those rules through getComputedStyle;
    // the offending declarations live in a class rule, never inline, so an
    // `el.style` check here is vacuous and passes against the bug.
    const root = open(ksampler());
    const seed = root.querySelector(".tn-seed");

    const scrollers = [seed, ...seed.querySelectorAll("*")]
      .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
      .map((el) => el.className);
    expect(scrollers).toEqual([]);
  });

  it("leaves the host's own scroll region intact", () => {
    // The complement: exactly one scroller should exist, and it is the shell's.
    const root = open(ksampler());
    const all = [root, ...root.querySelectorAll("*")].filter((el) =>
      /auto|scroll/.test(getComputedStyle(el).overflowY),
    );
    expect(all.map((el) => el.className)).toEqual(["cmp-body"]);
  });
});
