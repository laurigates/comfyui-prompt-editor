// @vitest-environment jsdom
//
// Power Lora Loader row (kind "lora") write-back: the editor renders one card
// per rgthree lora widget with an on/off toggle, the filename, and touch
// strength steppers, and commits back the widget's own {on, lora, strength,
// strengthTwo} value object. These drive the real DOM-building buildField()
// under jsdom.
import { describe, expect, it } from "vitest";
import { buildField } from "../../src/index.ts";

// Build a lora field exactly like the modal, exposing its controls.
function driveLora(value) {
  const widget = { name: "lora_1", type: "custom", value };
  const f = buildField(widget, "lora");
  const onInput = f.el.querySelector(".pe-lora-on");
  const nameInput = f.el.querySelector(".pe-lora-name");
  const strengths = f.el.querySelectorAll(".pe-lora-strength");
  const rows = f.el.querySelectorAll(".pe-lora-strength-row");
  // The +/- steppers of the first strength row.
  const firstBar = rows[0].querySelector(".pe-bar");
  const [minus, , plus] = firstBar.querySelectorAll("button, input");
  return { f, onInput, nameInput, strengths, rows, minus, plus };
}

describe("lora field write-back", () => {
  it("reads back the unchanged value object and reports no change", () => {
    const value = { on: true, lora: "add_detail.safetensors", strength: 1, strengthTwo: null };
    const { f } = driveLora(value);
    expect(f.read()).toEqual({
      on: true,
      lora: "add_detail.safetensors",
      strength: 1,
      strengthTwo: null,
    });
    expect(f.changed()).toBe(false);
  });

  it("edits the strength via the number input", () => {
    const { f, strengths } = driveLora({ on: true, lora: "x", strength: 1, strengthTwo: null });
    strengths[0].value = "0.75";
    strengths[0].dispatchEvent(new Event("input"));
    expect(f.read().strength).toBe(0.75);
    expect(f.changed()).toBe(true);
  });

  it("steps the strength with the +/- buttons (0.05 step)", () => {
    const { f, plus, minus } = driveLora({ on: true, lora: "x", strength: 1, strengthTwo: null });
    plus.click();
    plus.click();
    expect(f.read().strength).toBe(1.1);
    minus.click();
    expect(f.read().strength).toBe(1.05);
  });

  it("toggles the lora on/off", () => {
    const { f, onInput } = driveLora({ on: true, lora: "x", strength: 1, strengthTwo: null });
    onInput.checked = false;
    onInput.dispatchEvent(new Event("change"));
    expect(f.read().on).toBe(false);
    expect(f.changed()).toBe(true);
  });

  it("keeps strengthTwo null in single-strength mode (only one strength row)", () => {
    const { f, rows } = driveLora({ on: true, lora: "x", strength: 1, strengthTwo: null });
    expect(rows.length).toBe(1);
    expect(f.read().strengthTwo).toBeNull();
  });

  it("renders and edits a second strength when in model+clip mode", () => {
    const { f, rows, strengths } = driveLora({
      on: true,
      lora: "x",
      strength: 1,
      strengthTwo: 0.5,
    });
    expect(rows.length).toBe(2);
    strengths[1].value = "0.8";
    strengths[1].dispatchEvent(new Event("input"));
    const v = f.read();
    expect(v.strength).toBe(1);
    expect(v.strengthTwo).toBe(0.8);
    expect(f.changed()).toBe(true);
  });

  it("labels the card with the lora filename basename", () => {
    const { f } = driveLora({
      on: true,
      lora: "subdir/nested/my_lora.safetensors",
      strength: 1,
      strengthTwo: null,
    });
    expect(f.el.querySelector(".pe-label").textContent).toBe("my_lora.safetensors");
  });

  it("falls back to a finite strength when the input is cleared", () => {
    const { f, strengths } = driveLora({ on: true, lora: "x", strength: 1.2, strengthTwo: null });
    strengths[0].value = "";
    strengths[0].dispatchEvent(new Event("input"));
    expect(f.read().strength).toBe(1.2);
  });
});
