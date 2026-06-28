// @vitest-environment jsdom
//
// Number/combo field write-back: numeric widgets must round-trip through the
// modal in their native type and never serialize as NaN. These exercise the
// real DOM-building buildField() under jsdom, plus the pure resolveNumberFormat.
import { describe, expect, it } from "vitest";
import { buildField, classifyEditableWidget, resolveNumberFormat } from "../../src/index.ts";

// Drive a number/combo field exactly like the modal: build it, optionally type
// into its control, then read the value the commit step would write back.
function driveNumber(widget, typed) {
  const f = buildField(widget, "number");
  const input = f.el.querySelector("input");
  if (typed !== undefined) input.value = typed;
  return { value: f.read(), changed: f.changed(), input };
}

describe("resolveNumberFormat (pure)", () => {
  it("precision 0 marks an integer; precision > 0 marks a float", () => {
    expect(resolveNumberFormat({ precision: 0 }).isInt).toBe(true);
    expect(resolveNumberFormat({ precision: 2 }).isInt).toBe(false);
  });

  it("uses step2 (the real step), not the legacy 10x step", () => {
    // A FLOAT cfg: real step 0.1 stored as legacy step 1. The legacy value is an
    // integer, but step2 reveals the true fractional step -> float.
    expect(resolveNumberFormat({ step: 1, step2: 0.1 }).isInt).toBe(false);
    // An INT: real step 1 stored as legacy step 10, step2 1 -> integer.
    expect(resolveNumberFormat({ step: 10, step2: 1 }).isInt).toBe(true);
  });

  it("recovers the real step from the legacy 10x value when step2 is absent", () => {
    expect(resolveNumberFormat({ step: 1 }).isInt).toBe(false); // 1/10 = 0.1 -> float
    expect(resolveNumberFormat({ step: 10 }).isInt).toBe(true); // 10/10 = 1 -> int
  });

  it("defaults to float when no signal is present (non-destructive)", () => {
    expect(resolveNumberFormat({}).isInt).toBe(false);
    expect(resolveNumberFormat(undefined).isInt).toBe(false);
  });

  it("drops non-finite bounds", () => {
    const fmt = resolveNumberFormat({ min: Number.NaN, max: Number.POSITIVE_INFINITY });
    expect(fmt.min).toBeUndefined();
    expect(fmt.max).toBeUndefined();
  });
});

describe("number field write-back", () => {
  it("preserves a fractional edit on a whole-valued FLOAT widget", () => {
    // cfg defaults to 8.0 with a 0.1 step (legacy step 1). It must NOT round.
    const cfg = {
      name: "cfg",
      type: "number",
      value: 8,
      options: { min: 0, max: 100, step: 1, step2: 0.1, precision: 1 },
    };
    const { value } = driveNumber(cfg, "7.5");
    expect(value).toBe(7.5);
  });

  it("rounds an INT widget", () => {
    const seed = {
      name: "seed",
      type: "number",
      value: 42,
      options: { min: 0, max: 1e18, step: 10, step2: 1, precision: 0 },
    };
    const { value } = driveNumber(seed, "43.9");
    expect(value).toBe(44);
    expect(Number.isInteger(value)).toBe(true);
  });

  it("never returns NaN when a bound is non-finite", () => {
    const w = { name: "x", type: "number", value: 5, options: { min: Number.NaN } };
    const { value } = driveNumber(w, "6");
    expect(value).toBe(6);
    expect(Number.isNaN(value)).toBe(false);
  });

  it("falls back to a finite value when the field is cleared", () => {
    const w = { name: "x", type: "number", value: 8, options: { step2: 0.5 } };
    const { value } = driveNumber(w, "");
    expect(value).toBe(8);
  });

  it("normalises a pre-existing NaN widget value to a finite number on save", () => {
    const w = { name: "x", type: "number", value: Number.NaN, options: { step2: 1 } };
    const { value, changed } = driveNumber(w, undefined);
    expect(Number.isFinite(value)).toBe(true);
    expect(changed).toBe(true); // seen as changed -> commit writes the finite value
  });

  it("leaves an untouched valid number unchanged (no churn)", () => {
    const w = { name: "x", type: "number", value: 12, options: { step2: 1 } };
    const { changed } = driveNumber(w, undefined);
    expect(changed).toBe(false);
  });

  it("returns a number type, never a string", () => {
    const w = { name: "x", type: "number", value: 3, options: { step2: 0.1 } };
    const { value } = driveNumber(w, "4.2");
    expect(typeof value).toBe("number");
  });
});

describe("numeric combo field", () => {
  function driveCombo(widget) {
    const f = buildField(widget, "combo");
    return { read: f.read(), changed: f.changed(), select: f.el.querySelector("select") };
  }

  it("keeps a value stored as a string that matches a numeric option", () => {
    const w = { name: "batch", options: { values: [1, 2, 4, 8] }, value: "8" };
    const { read, changed } = driveCombo(w);
    expect(String(read)).toBe("8"); // selection preserved, not reset to the first option
    expect(changed).toBe(false); // type-only difference is not an edit
  });

  it("keeps a value stored as a number", () => {
    const w = { name: "batch", options: { values: [1, 2, 4, 8] }, value: 8 };
    const { read, changed } = driveCombo(w);
    expect(read).toBe(8);
    expect(changed).toBe(false);
  });

  it("classifies a fixed-values numeric widget as a combo", () => {
    expect(classifyEditableWidget({ name: "batch", options: { values: [1, 2] }, value: 2 })).toBe(
      "combo",
    );
  });
});
