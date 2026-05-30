import { describe, expect, it } from "vitest";
import { fuzzyRank } from "../../web/js/modal-fuzzy.js";
import {
  bumpWeight,
  isMultilineStringWidget,
  isTargetWidget,
  TARGET_WIDGET_NAMES,
} from "../../web/js/prompt-editor.js";

// The copied fuzzy primitive must remain importable (used by future v0.4
// embedding palette). fuzzyRank(query, [primary, ...rest]) -> {score, ...}|null.
describe("comfyui-prompt-editor: copied primitives", () => {
  it("fuzzyRank scores a subsequence match and rejects a non-match", () => {
    const hit = fuzzyRank("eul", ["euler"]);
    expect(hit).not.toBeNull();
    expect(hit.score).toBeGreaterThan(0);
    expect(fuzzyRank("zzz", ["euler"])).toBeNull();
  });
});

// Widget detection is the "generic across node packs" contract — a pure
// object->boolean predicate with no DOM. It MUST accept any multiline STRING
// widget regardless of name, and MUST reject combos / number widgets even when
// they happen to share a name in TARGET_WIDGET_NAMES.
describe("isMultilineStringWidget", () => {
  it("accepts a widget with options.multiline === true", () => {
    expect(
      isMultilineStringWidget({ name: "anything", options: { multiline: true }, value: "" }),
    ).toBe(true);
  });

  it("accepts a widget whose inputEl is a DOM <textarea>", () => {
    const w = { name: "custom", options: {}, value: "x", inputEl: { tagName: "TEXTAREA" } };
    expect(isMultilineStringWidget(w)).toBe(true);
  });

  it('accepts a "customtext" type widget regardless of name', () => {
    expect(isMultilineStringWidget({ name: "zzz_unknown", type: "customtext", value: "hi" })).toBe(
      true,
    );
  });

  it("rejects a combo (options.values is an array) even if multiline-ish", () => {
    const sampler = {
      name: "sampler_name",
      options: { multiline: true, values: ["euler", "dpmpp_2m"] },
      value: "euler",
    };
    expect(isMultilineStringWidget(sampler)).toBe(false);
  });

  it("rejects a non-string-valued widget", () => {
    expect(
      isMultilineStringWidget({ name: "steps", options: { multiline: true }, value: 20 }),
    ).toBe(false);
  });

  it("rejects a plain single-line widget with no multiline signal", () => {
    expect(isMultilineStringWidget({ name: "filename", options: {}, value: "out.png" })).toBe(
      false,
    );
  });

  it("rejects nullish / non-object input defensively", () => {
    expect(isMultilineStringWidget(null)).toBe(false);
    expect(isMultilineStringWidget(undefined)).toBe(false);
    expect(isMultilineStringWidget("text")).toBe(false);
  });
});

describe("isTargetWidget", () => {
  it("accepts any multiline string widget via the generic path (unknown name)", () => {
    expect(
      isTargetWidget({ name: "totally_custom", options: { multiline: true }, value: "" }),
    ).toBe(true);
  });

  it("accepts a known-named string widget even without a multiline signal", () => {
    // Frontend skew: the multiline flag isn't exposed, but the name is a known
    // prompt widget and the value is a string → still a target.
    expect(isTargetWidget({ name: "prompt", options: {}, value: "a cat" })).toBe(true);
  });

  it("rejects a known-named COMBO (fixed values list) — never matches a sampler", () => {
    // "string" is in the name set, but a fixed values list marks it a combo.
    const combo = { name: "string", options: { values: ["a", "b"] }, value: "a" };
    expect(isTargetWidget(combo)).toBe(false);
  });

  it("rejects a known-named widget whose value is not a string", () => {
    expect(isTargetWidget({ name: "positive", options: {}, value: 42 })).toBe(false);
  });

  it("rejects an unknown-named widget with no multiline signal", () => {
    expect(isTargetWidget({ name: "seed", options: {}, value: "123" })).toBe(false);
  });

  it("rejects nullish input defensively", () => {
    expect(isTargetWidget(null)).toBe(false);
    expect(isTargetWidget(undefined)).toBe(false);
  });

  it("every name in TARGET_WIDGET_NAMES is targeted when string-valued", () => {
    for (const name of TARGET_WIDGET_NAMES) {
      expect(isTargetWidget({ name, options: {}, value: "x" })).toBe(true);
    }
  });
});

// bumpWeight implements the ComfyUI (token:weight) grammar. Pure function —
// the modal calls it then writes the result back into the textarea.
describe("bumpWeight", () => {
  it("wraps a bare selection in (token:1.1) when stepping up", () => {
    const text = "a cat";
    // select "cat" (indices 2..5)
    const res = bumpWeight(text, 2, 5, 0.1);
    expect(res.text).toBe("a (cat:1.1)");
    // selection re-anchored over the rewrapped token
    expect(res.text.slice(res.selStart, res.selEnd)).toBe("(cat:1.1)");
  });

  it("wraps a bare selection as (token:0.9) when stepping down", () => {
    const res = bumpWeight("cat", 0, 3, -0.1);
    expect(res.text).toBe("(cat:0.9)");
  });

  it("rewrites an existing (token:N.N) weight in place", () => {
    const text = "(cat:1.2)";
    const res = bumpWeight(text, 0, text.length, 0.1);
    expect(res.text).toBe("(cat:1.3)");
  });

  it("decrements an existing weight", () => {
    const res = bumpWeight("(cat:1.2)", 0, 9, -0.1);
    expect(res.text).toBe("(cat:1.1)");
  });

  it("treats implicit emphasis (token) as weight 1.1", () => {
    const res = bumpWeight("(cat)", 0, 5, 0.1);
    expect(res.text).toBe("(cat:1.2)");
  });

  it("clamps the weight to the [0, 2] range", () => {
    const high = bumpWeight("(cat:2.0)", 0, 9, 0.1);
    expect(high.text).toBe("(cat:2.0)");
    const low = bumpWeight("(cat:0.0)", 0, 9, -0.1);
    expect(low.text).toBe("(cat:0.0)");
  });

  it("operates on the whole value when the selection is empty/whitespace", () => {
    // caret with no selection (start === end) → whole prompt
    const res = bumpWeight("masterpiece", 11, 11, 0.1);
    expect(res.text).toBe("(masterpiece:1.1)");
  });

  it("preserves surrounding text outside the selection", () => {
    const text = "blue sky, green grass";
    // select "green grass" (10..21)
    const res = bumpWeight(text, 10, 21, 0.1);
    expect(res.text).toBe("blue sky, (green grass:1.1)");
  });

  it("normalises a reversed selection range", () => {
    const res = bumpWeight("cat", 3, 0, 0.1);
    expect(res.text).toBe("(cat:1.1)");
  });

  it("returns a one-decimal formatted weight", () => {
    const res = bumpWeight("(cat:1.15)", 0, 10, 0.1);
    // 1.15 + 0.1 = 1.25 -> rounds to 1.3 at one decimal
    expect(res.text).toBe("(cat:1.3)");
  });

  it("handles non-string input defensively", () => {
    const res = bumpWeight(undefined, undefined, undefined, 0.1);
    expect(res.text).toBe("");
  });
});
