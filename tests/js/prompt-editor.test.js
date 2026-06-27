import { fuzzyRank } from "@laurigates/comfy-modal-kit";
import { describe, expect, it } from "vitest";
import {
  bumpWeight,
  classifyEditableWidget,
  isMultilineStringWidget,
  isTargetWidget,
  TARGET_WIDGET_NAMES,
} from "../../src/index.ts";

// classifyEditableWidget buckets every node widget into a control kind for the
// all-fields editor. Pure object->kind, so it is unit-tested.
describe("classifyEditableWidget", () => {
  it("buckets a multiline STRING as 'multiline'", () => {
    expect(classifyEditableWidget({ name: "text", options: { multiline: true }, value: "" })).toBe(
      "multiline",
    );
  });

  it("buckets a single-line STRING as 'text'", () => {
    expect(classifyEditableWidget({ name: "filename", options: {}, value: "out.png" })).toBe(
      "text",
    );
  });

  it("buckets a numeric widget as 'number'", () => {
    expect(classifyEditableWidget({ name: "steps", options: {}, value: 20 })).toBe("number");
  });

  it("buckets a fixed-values widget as 'combo'", () => {
    expect(
      classifyEditableWidget({
        name: "sampler_name",
        options: { values: ["euler"] },
        value: "euler",
      }),
    ).toBe("combo");
  });

  it("buckets a boolean widget as 'boolean'", () => {
    expect(classifyEditableWidget({ name: "enabled", options: {}, value: true })).toBe("boolean");
    expect(classifyEditableWidget({ name: "toggle_w", type: "toggle", value: false })).toBe(
      "boolean",
    );
  });

  it("skips button, converted, hidden, and unnamed widgets", () => {
    expect(classifyEditableWidget({ name: "go", type: "button" })).toBeNull();
    expect(classifyEditableWidget({ name: "x", type: "converted-widget", value: "y" })).toBeNull();
    expect(classifyEditableWidget({ name: "h", options: {}, value: "v", hidden: true })).toBeNull();
    expect(classifyEditableWidget({ name: "", options: {}, value: "v" })).toBeNull();
  });

  it("rejects nullish input defensively", () => {
    expect(classifyEditableWidget(null)).toBeNull();
    expect(classifyEditableWidget(undefined)).toBeNull();
  });
});

// The fuzzy primitive (now consumed from @laurigates/comfy-modal-kit) must
// remain importable (used by future v0.4 embedding palette).
// fuzzyRank(query, [primary, ...rest]) -> {score, ...}|null.
describe("comfyui-prompt-editor: kit primitives", () => {
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

  it("expands a bare caret to the inner word (single-word value)", () => {
    // caret with no selection (start === end) → the word it sits in. For a
    // single-word value that is the whole value.
    const res = bumpWeight("masterpiece", 11, 11, 0.1);
    expect(res.text).toBe("(masterpiece:1.1)");
  });

  it("weights only the word the caret sits in, not the whole prompt", () => {
    // "blue sky, green grass" — caret inside "green" (index 12).
    const text = "blue sky, green grass";
    const res = bumpWeight(text, 12, 12, 0.1);
    expect(res.text).toBe("blue sky, (green:1.1) grass");
    // selection re-anchored over the rewrapped inner word
    expect(res.text.slice(res.selStart, res.selEnd)).toBe("(green:1.1)");
  });

  it("expands a bare caret over an existing weighted token and rewrites it", () => {
    // Parentheses are not delimiters, so a caret inside (cat:1.1) expands over
    // the whole token and bumps its weight in place.
    const text = "a (cat:1.1) sat";
    const res = bumpWeight(text, 6, 6, 0.1); // caret inside "cat"
    expect(res.text).toBe("a (cat:1.2) sat");
  });

  it("expands to the word immediately left of the caret", () => {
    // caret sits right after "blue" (index 4, before the single space): the char
    // before the caret is a word char, so the inner word is "blue".
    const res = bumpWeight("blue sky", 4, 4, 0.1);
    expect(res.text).toBe("(blue:1.1) sky");
  });

  it("falls back to the whole value when the caret is surrounded by delimiters", () => {
    // double space — caret at index 5 sits between two spaces, so there is no
    // inner word and the whole prompt is nudged.
    const res = bumpWeight("blue  sky", 5, 5, 0.1);
    expect(res.text).toBe("(blue  sky:1.1)");
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
