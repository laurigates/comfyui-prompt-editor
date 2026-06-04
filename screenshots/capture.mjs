// Playwright driver for the README screenshot.
//
// Drives ComfyUI's frontend through the pack's real public surface:
// loads a single CLIPTextEncode workflow with a sample prompt, then opens
// the prompt editor modal over its multiline `text` widget and
// screenshots the dialog.
//
// Two open paths, mirroring the pack's own Strategy A / Strategy B:
//   A — invoke the patched widget.onPointerDown directly.
//   B — click the explicit "⤢ <name>" expand button widget (the
//       fallback the pack always adds), if Strategy A doesn't open it.
// Direct invocation is intentional: clicking the canvas at computed
// coords is fragile (Vue layout, ds scale, devicePixelRatio interact),
// and these are the exact surfaces a real tap exercises.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";

async function dismissStartupDialog(page) {
  // A fresh ComfyUI profile opens the "Workflow Templates / Getting
  // Started" PrimeVue dialog (.p-dialog-mask) over the canvas. Close it
  // so it doesn't composite on top of our screenshot.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function openEditor(page) {
  const dialog = page.locator(".cmp-dialog");

  // Strategy A — invoke the patched widget.onPointerDown directly.
  console.log("Opening editor via widget.onPointerDown (Strategy A)…");
  try {
    await page.evaluate(() => {
      const node = window.app.graph._nodes[0];
      const widget = node.widgets.find(
        (w) => w._promptEditorPointerPatched === true,
      );
      if (!widget) throw new Error("patched text widget not found");
      widget.onPointerDown({}, node, window.app.canvas);
    });
    await dialog.waitFor({ state: "visible", timeout: 4_000 });
    return dialog;
  } catch {
    // Strategy B — click the explicit "⤢ <name>" expand button widget.
    console.log("Strategy A did not open the editor; using the ⤢ button (Strategy B)…");
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".litecontextmenu")) el.remove();
    });
    await page.evaluate(() => {
      const node = window.app.graph._nodes[0];
      const btn = node.widgets.find(
        (w) => w.type === "button" && /⤢/.test(w.name || w.label || ""),
      );
      if (!btn) throw new Error("⤢ expand button widget not found");
      btn.callback?.();
    });
    await dialog.waitFor({ state: "visible", timeout: 6_000 });
    return dialog;
  }
}

async function main() {
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, "utf8"));

  const browser = await chromium.launch({
    args: ["--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      console.log(`[page:${t}] ${msg.text()}`);
    }
  });

  console.log(`Navigating to ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  console.log("Loading single CLIPTextEncode workflow…");
  await page.evaluate((wf) => {
    // clean=true wipes the default workflow so we end with just our node.
    window.app.loadGraphData(wf, true);
  }, workflow);

  await page.waitForFunction(() => window.app.graph._nodes.length === 1, null, {
    timeout: 10_000,
  });

  await dismissStartupDialog(page);

  // Wait until the pack has patched the multiline text widget.
  await page.waitForFunction(
    () =>
      window.app.graph._nodes[0]?.widgets?.some(
        (w) => w._promptEditorPointerPatched === true,
      ),
    null,
    { timeout: 15_000 },
  );

  // Force a canvas redraw so widget.last_y and friends are populated.
  await page.evaluate(() => {
    window.app.canvas?.setDirty?.(true, true);
    window.app.canvas?.draw?.(true, true);
  });

  const dialog = await openEditor(page);

  // Wait for the textarea to render and carry the prompt text.
  await page.waitForFunction(
    () => {
      const ta = document.querySelector(".cmp-dialog .pe-textarea");
      return ta && ta.value && ta.value.length > 0;
    },
    null,
    { timeout: 5_000 },
  );
  await page.waitForTimeout(300);

  console.log(`Capturing ${OUT_DIR}/editor.png…`);
  await dialog.screenshot({ path: `${OUT_DIR}/editor.png` });

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
