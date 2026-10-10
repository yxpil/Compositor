// End-to-end suite for the Tauri port. Rendering semantics are checked against
// hand-computed compositing values and, for blend modes, against Chromium's own
// compositor as the oracle. Error paths check the mock backend's exact messages.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function fixtureFS(request) {
  const response = await request.get("/__e2e/fs");
  const payload = await response.json();
  return payload.projects;
}

// Boots the app with the mock Tauri IPC and the fixture filesystem injected.
async function boot(page, projects, project = null) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript((fs) => {
    window.__E2E_FS = fs;
    window.__E2E_ROOT = "/mock";
  }, projects);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(/Open a folder/i);
  if (project) {
    await page.fill("#folderPath", "/mock");
    await page.click("#refresh");
    await page.click(`#projectList li:has-text("${project.replace(".comp", "")}")`);
    await expect(page.locator("#status")).toContainText(project.replace(".comp", ""));
  }
  return errors;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: Array.from(image.data) };
  });
}

function px(image, x, y) {
  const i = (y * image.width + x) * 4;
  return image.data.slice(i, i + 4);
}

function expectRGBA(actual, expected, tolerance = 2, label = "") {
  for (let c = 0; c < 4; c += 1) {
    const difference = Math.abs(actual[c] - expected[c]);
    expect(difference, `${label} channel ${c}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
  }
}

const SOLID = (r, g, b, a = 255) => [r, g, b, a];

// ---- Rendering semantics ----

test.describe("compositing", () => {
  test("p-basic: opacity compositing matches hand-computed values", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-basic");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    expect([image.width, image.height]).toEqual([32, 24]);
    // Top layer half-green at opacity 0.5 over red: (0.5·0+0.5·255, 0.5·255+0.5·0, 0) = (128,128,0).
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 2, "half-green over red");
    // Half-alpha blue at 0.5 layer opacity over red: effective coverage 128/255·0.5 ≈ 0.251
    // → red 255·0.749 ≈ 191, blue 255·0.251 ≈ 64.
    expectRGBA(px(image, 24, 12), SOLID(191, 0, 64), 2, "blue @128 alpha @0.5 over red");
  });

  test("p-groups: pass-through folders, nested opacity, inherited visibility", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-groups");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    // Deep leaf (magenta) at nested 0.5 over child1 (0,128,255): (128, 64, 255).
    expectRGBA(px(image, 16, 12), SOLID(128, 64, 255), 2, "nested leaf over child1");
    // Hidden folder contributes nothing: the whole canvas is the leaf-over-child1 result.
    expectRGBA(px(image, 2, 2), SOLID(128, 64, 255), 2, "hidden folder absent");
  });

  test("p-blend: all eight blend modes match Chromium's compositor", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-blend");
    expect(errors).toEqual([]);
    const rendered = await snapshot(page);
    // Oracle: composite the same layers with Chromium's own blend implementation.
    const reference = await page.evaluate(async () => {
      const doc = window.__session && window.__session.doc;
      if (!doc) return null;
      const canvas = document.createElement("canvas");
      canvas.width = doc.manifest.width;
      canvas.height = doc.manifest.height;
      const context = canvas.getContext("2d");
      const ops = { Normal: "source-over", Multiply: "multiply", Screen: "screen", Overlay: "overlay",
        Darken: "darken", Lighten: "lighten", Difference: "difference",
        "Color Dodge": "color-dodge", "Color Burn": "color-burn" };
      for (const layer of doc.manifest.layers) {
        const image = doc.images.get(layer.imageFile);
        if (!image) continue;
        context.globalCompositeOperation = ops[layer.blendMode] || "source-over";
        context.globalAlpha = typeof layer.opacity === "number" ? layer.opacity : 1;
        const { origin, size } = layer.transform;
        context.drawImage(image, origin.x, origin.y, size.width, size.height);
      }
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    });
    expect(reference).not.toBeNull();
    let maxDifference = 0;
    for (let i = 0; i < reference.length; i += 4) {
      for (let c = 0; c < 4; c += 1) {
        maxDifference = Math.max(maxDifference, Math.abs(reference[i + c] - rendered.data[i + c]));
      }
    }
    expect(maxDifference, "renderer vs Chromium compositor").toBeLessThanOrEqual(4);
  });

  test("p-masks: raster masks, disabled masks, unlinked placement, group mask", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-masks");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    // Left half: MaskOff (0,200,100) covers the masked layer; the folder's inside
    // (60,60,200) with its left-half mask ends on top → (60,60,200).
    expectRGBA(px(image, 4, 4), SOLID(60, 60, 200), 2, "inside folder, left of group mask");
    // Right half: group mask coverage 0; the unlinked layer's 1×1 mask at origin 16
    // gives 128/255 coverage of (255,128,0) over (0,200,100).
    expectRGBA(px(image, 20, 4), SOLID(128, 164, 50), 3, "unlinked mask coverage on right half");
  });

  test("p-clipping: maskSourceID chains clip to live base alpha", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-clipping");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    expectRGBA(px(image, 4, 4), SOLID(0, 0, 255), 2, "chain over clipped stack");
    expectRGBA(px(image, 20, 4), SOLID(0, 0, 0, 0), 2, "transparent base clips everything");
  });

  test("p-adjust-invert: Invert is exactly 255-v", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-adjust-invert");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    // Fixture photo is (x·8, y·10, (x+y)·4): at (10,6) → (80,60,64); Invert is 255-v.
    expectRGBA(px(image, 10, 6), SOLID(255 - 80, 255 - 60, 255 - 64), 1, "invert");
  });

  test("p-adjust: all twelve adjustments render without error", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-adjust");
    expect(errors).toEqual([]);
    await expect(page.locator("#status")).toContainText("13 layers");
    const image = await snapshot(page);
    const original = [80, 60, 128, 255];
    const sample = px(image, 10, 6);
    const moved = sample.some((value, c) => c < 3 && Math.abs(value - original[c]) > 6);
    expect(moved, "adjustments visibly changed the photo").toBe(true);
  });

  test("p-transform: sampling modes and flips render", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-transform");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    // The topmost "High quality" layer is scaled 2×: bilinear at (31,23) samples
    // source (15.75,11.75).
    expectRGBA(px(image, 31, 23), SOLID(110, 106, 64), 5, "2x high-quality scale");
  });

  test("p-shape: live shape layers rasterize from metadata", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-shape");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    // Live green ellipse centered (14,11) draws over the blue line asset.
    expectRGBA(px(image, 14, 11), SOLID(0, 255, 0), 2, "live ellipse center");
  });

  test("p-text: live text rasterizes; fixture raster fallback shows", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    const errors = await boot(page, projects, "p-text");
    expect(errors).toEqual([]);
    const image = await snapshot(page);
    expectRGBA(px(image, 16, 10), SOLID(10, 10, 10), 2, "text raster fallback");
    const liveInk = await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      const data = canvas.getContext("2d").getImageData(2, 2, 20, 10).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
      return count;
    });
    expect(liveInk).toBeGreaterThan(20);
  });

  test("p-guides and p-versioned load; pixels pass through", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    let errors = await boot(page, projects, "p-guides");
    expect(errors).toEqual([]);
    let image = await snapshot(page);
    expectRGBA(px(image, 5, 5), SOLID(200, 200, 0), 2, "guides project pixels");
    errors = await boot(page, projects, "p-versioned");
    expect(errors).toEqual([]);
    await expect(page.locator("#status")).toContainText("format v3");
    image = await snapshot(page);
    // The v3 layer carries opacity 0.7 over a transparent canvas: RGB passes
    // through, alpha lands at 255·0.7 ≈ 179.
    expectRGBA(px(image, 10, 10), SOLID(255, 0, 128, 179), 2, "v3 pixels");
  });
});

// ---- Error paths (exact messages from the Rust backend) ----

test.describe("error paths", () => {
  test("invalid JSON reports the parse failure", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects);
    await page.fill("#folderPath", "/mock");
    await page.click("#refresh");
    await page.click('#projectList li:has-text("p-badjson")');
    await expect(page.locator("#status")).toContainText(/Manifest is not valid JSON/i);
  });

  test("missing asset reports the file name", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects);
    await page.fill("#folderPath", "/mock");
    await page.click("#refresh");
    await page.click('#projectList li:has-text("p-missing-asset")');
    await expect(page.locator("#status")).toContainText(/Missing asset: missing\.png/i);
  });

  test("unsupported version reports the range", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects);
    await page.fill("#folderPath", "/mock");
    await page.click("#refresh");
    await page.click('#projectList li:has-text("p-badversion")');
    await expect(page.locator("#status")).toContainText(/Unsupported project version 12/i);
  });
});

// ---- Editor operations ----

test.describe("editor", () => {
  test("layer ops: duplicate, undo, redo, delete", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    const rows = () => page.locator("#layerList .layer-row").count();
    expect(await rows()).toBe(2);
    await page.click("#duplicateLayer");
    expect(await rows()).toBe(3);
    await page.click("#undo");
    expect(await rows()).toBe(2);
    await page.click("#redo");
    expect(await rows()).toBe(3);
    await page.click("#deleteLayer");
    expect(await rows()).toBe(2);
  });

  test("merge down bakes the active layer into the one below", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#mergeDown");
    await expect(page.locator("#layerList .layer-row")).toHaveCount(1);
    const image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 3, "merged pixels preserved");
    expectRGBA(px(image, 24, 12), SOLID(191, 0, 64), 3, "merged composite preserved");
  });

  test("add mask creates a reveal-all mask and bumps the format version", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#addMask");
    await expect(page.locator("#layerList .layer-row").first()).toContainText("mask");
    await page.click("#save");
    // Saving encodes the new mask asset asynchronously; wait for the backend round-trip.
    await expect(page.locator("#status")).toContainText("Saved");
    const saved = await page.evaluate(() => JSON.parse(window.__E2E_FS.mock["p-basic.comp"]["manifest.json"]));
    expect(saved.version).toBeGreaterThanOrEqual(4);
    const top = saved.layers.find((layer) => layer.name === "Top");
    expect(top.maskFile).toBeTruthy();
    expect(top.maskEnabled).toBe(true);
  });

  test("save writes the manifest into the virtual filesystem", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    // Toggle the top layer's visibility, then save.
    await page.locator("#layerList .layer-row").first().locator(".layer-visible").click();
    await page.click("#save");
    // Toggling visibility touches no assets, but the save is still an async IPC.
    await expect(page.locator("#status")).toContainText("Saved");
    const saved = await page.evaluate(() => JSON.parse(window.__E2E_FS.mock["p-basic.comp"]["manifest.json"]));
    const top = saved.layers.find((layer) => layer.name === "Top");
    expect(top.isVisible).toBe(false);
  });

  test("new project creates an empty canvas via the sheet", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects);
    await page.click("#newProject");
    await expect(page.locator("#sheetOverlay")).toBeVisible();
    await page.fill('#sheetOverlay input[type="number"] >> nth=0', "64");
    await page.fill('#sheetOverlay input[type="number"] >> nth=1', "48");
    await page.click('#sheetOverlay button:has-text("Create")');
    const image = await snapshot(page);
    expect([image.width, image.height]).toEqual([64, 48]);
  });

  test("export PNG reaches the backend with PNG bytes", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#exportPng");
    // PNG encoding + IPC are asynchronous; the status line confirms the round-trip.
    await expect(page.locator("#status")).toContainText("Exported");
    const call = await page.evaluate(() => window.__E2E_CALLS.find((c) => c.kind === "export_file"));
    expect(call).toBeTruthy();
    expect(call.kind).toBe("export_file");
    expect(call.fileName).toBe("p-basic.png");
    expect(call.base64.startsWith("iVBOR")).toBe(true); // PNG magic
  });

  test("import places a new layer with the image centered", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    // Build a 8×8 solid teal PNG on the Node side for the mock dialog to return.
    const { encodePng } = await import(join(here, "../fixtures/png.mjs"));
    const teal = Buffer.alloc(8 * 8 * 4);
    for (let i = 0; i < teal.length; i += 4) {
      teal[i] = 0; teal[i + 1] = 128; teal[i + 2] = 128; teal[i + 3] = 255;
    }
    const png = encodePng(8, 8, teal);
    await page.addInitScript((fs) => {
      window.__E2E_FS = fs;
      window.__E2E_ROOT = "/mock";
    }, projects);
    await page.goto("/");
    await page.evaluate((base64) => { window.__E2E_IMPORT = [{ name: "teal.png", base64 }]; }, png.toString("base64"));
    await page.fill("#folderPath", "/mock");
    await page.click("#refresh");
    await page.click('#projectList li:has-text("p-basic")');
    await expect(page.locator("#status")).toContainText("p-basic");
    await page.click("#importImages");
    await expect(page.locator("#layerList .layer-row")).toHaveCount(3);
    const image = await snapshot(page);
    // Teal 8×8 centered: spans x 12..20, y 8..16 → opaque teal at (15,12).
    expectRGBA(px(image, 15, 12), SOLID(0, 128, 128), 2, "placed teal");
    expectRGBA(px(image, 4, 4), SOLID(128, 128, 0), 2, "original composite outside");
  });

  test("command palette adds a layer via New Layer command", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#commandPalette");
    await expect(page.locator("#paletteOverlay")).toBeVisible();
    await page.fill(".palette-input", "New Layer");
    await page.keyboard.press("Enter");
    await expect(page.locator("#layerList .layer-row")).toHaveCount(3);
  });

  test("brush paints on the active layer; eyedropper reads it back", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    // Select the top layer, pick the brush, paint a hard black dot at (4,4).
    await page.locator("#layerList .layer-row").first().click();
    await page.locator('.tool-button[data-tool="brush"]').click();
    const before = await snapshot(page);
    await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + (4.5 / 32) * rect.width;
      const y = rect.top + (4.5 / 24) * rect.height;
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
    });
    const after = await snapshot(page);
    const beforePx = px(before, 4, 4);
    const afterPx = px(after, 4, 4);
    const changed = beforePx.some((value, i) => value !== afterPx[i]);
    expect(changed, "brush stroke changed the pixel").toBe(true);
    // Eyedropper over the dot reports the foreground color.
    await page.locator('.tool-button[data-tool="eyedropper"]').click();
    await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + (4.5 / 32) * rect.width;
      const y = rect.top + (4.5 / 24) * rect.height;
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 2, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, pointerId: 2, bubbles: true }));
    });
    await expect(page.locator("#status")).toContainText(/Foreground \d+, \d+, \d+/);
  });

  test("zoom changes the canvas display size", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    const widthBefore = await page.evaluate(() => document.getElementById("canvas").style.width);
    await page.locator('.tool-button[data-tool="zoom"]').click();
    await page.locator("#canvas").click({ position: { x: 10, y: 10 } });
    const widthAfter = await page.evaluate(() => document.getElementById("canvas").style.width);
    expect(parseFloat(widthAfter)).toBeGreaterThan(parseFloat(widthBefore));
  });
});

// ---- Menu bar and command parity with the macOS app ----

test.describe("menu parity", () => {
  test("File menu opens as a dropdown and Close Project empties the editor", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-file");
    await expect(page.locator("#menu-file .dropdown")).toBeVisible();
    await expect(page.locator("#menu-file .menu-item")).toHaveCount(8);
    await page.click('#menu-file .menu-item:has-text("Close Project")');
    await expect(page.locator("#status")).toContainText("Closed project");
    await expect(page.locator("#layerList .layer-row")).toHaveCount(0);
  });

  test("selection: All, Deselect and Inverse via the macOS shortcuts", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.keyboard.press("Control+a");
    let selection = await page.evaluate(() => window.__session.selection);
    expect([selection.x, selection.y, selection.width, selection.height]).toEqual([0, 0, 32, 24]);
    await page.keyboard.press("Control+d");
    expect(await page.evaluate(() => window.__session.selection)).toBeNull();
    // Inverse without a selection becomes Select All (the macOS behaviour).
    await page.keyboard.press("Control+Shift+i");
    selection = await page.evaluate(() => window.__session.selection);
    expect([selection.width, selection.height]).toEqual([32, 24]);
    await page.keyboard.press("Control+d");
  });

  test("copy merged then paste restores the composite on a new layer", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+Shift+c");
    await page.keyboard.press("Control+v");
    await expect(page.locator("#layerList .layer-row")).toHaveCount(3);
    const image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 2, "pasted merged pixels");
  });

  test("fill with foreground covers the selection, clear removes it, undo restores", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.locator("#layerList .layer-row").first().click();
    await page.keyboard.press("Control+a");
    await page.evaluate(() => { window.__session.foregroundColor = { red: 0, green: 0, blue: 1 }; });
    await page.keyboard.press("Alt+Backspace");
    // The whole layer turns solid blue inside the selection; at 0.5 opacity over
    // red that lands on (128, 0, 128) both where it was opaque and transparent.
    let image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 0, 128), 3, "filled left half");
    expectRGBA(px(image, 24, 12), SOLID(128, 0, 128), 3, "filled transparent half");
    await page.keyboard.press("Control+z");
    image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 3, "undo restores");
    // Plain delete with a selection clears the layer's selected pixels.
    await page.keyboard.press("Delete");
    image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(255, 0, 0), 3, "cleared down to red bottom");
    await page.keyboard.press("Control+z");
  });

  test("rotate canvas 90° clockwise swaps dimensions and remaps pixels", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-image");
    await page.click('#menu-image .menu-item:has-text("Rotate Canvas 90° Clockwise")');
    const image = await snapshot(page);
    expect([image.width, image.height]).toEqual([24, 32]);
    // (x, y) → (H − y, x): the (8,12) sample lands at (12,8).
    expectRGBA(px(image, 12, 8), SOLID(128, 128, 0), 3, "rotated composite");
    await page.keyboard.press("Control+z");
    const restored = await snapshot(page);
    expect([restored.width, restored.height]).toEqual([32, 24]);
  });

  test("flip canvas horizontal mirrors the composite", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-image");
    await page.click('#menu-image .menu-item:has-text("Flip Canvas Horizontal")');
    const image = await snapshot(page);
    // Pixel x mirrors to 31 − x.
    expectRGBA(px(image, 23, 12), SOLID(128, 128, 0), 3, "mirrored half-green");
    expectRGBA(px(image, 7, 12), SOLID(255, 0, 0), 3, "mirrored left edge is red");
  });

  test("image size rescales the canvas through its sheet", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-image");
    await page.click('#menu-image .menu-item:has-text("Image Size…")');
    await expect(page.locator("#sheetOverlay")).toBeVisible();
    const inputs = page.locator('#sheetOverlay input[type="number"]');
    await inputs.nth(0).fill("64");
    await inputs.nth(1).fill("48");
    await page.click('#sheetOverlay button:has-text("Resample")');
    const image = await snapshot(page);
    expect([image.width, image.height]).toEqual([64, 48]);
    expectRGBA(px(image, 16, 24), SOLID(128, 128, 0), 6, "2x scaled composite");
  });

  test("⌘I inverts the active layer's pixels and undo restores", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.locator("#layerList .layer-row").first().click();
    await page.keyboard.press("Control+i");
    // Top pixel (0,255,0) inverts to (255,0,0); over red at 0.5 → (255,0,0).
    let image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(255, 0, 0), 3, "inverted green");
    await page.keyboard.press("Control+z");
    image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 3, "undo restores");
  });

  test("Gaussian Blur runs from the Filter menu and softens the edge", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-filter");
    await page.click('#menu-filter .menu-item:has-text("Gaussian Blur…")');
    await expect(page.locator("#sheetOverlay")).toBeVisible();
    await page.click('#sheetOverlay button:has-text("Apply")');
    const image = await snapshot(page);
    expectRGBA(px(image, 4, 12), SOLID(128, 128, 0), 8, "blur interior holds");
    const edge = px(image, 16, 12);
    const moved = Math.abs(edge[1] - 0) > 10 || Math.abs(edge[2] - 64) > 10 || Math.abs(edge[0] - 191) > 10;
    expect(moved, "blur changed the alpha edge").toBe(true);
  });

  test("New Adjustment Layer adds an Invert layer from the Layer menu", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.click("#menu-layer");
    await page.click('#menu-layer .menu-item:has-text("New Adjustment Layer…")');
    await expect(page.locator("#sheetOverlay")).toBeVisible();
    await page.selectOption('#sheetOverlay select', "Invert");
    await page.click('#sheetOverlay button:has-text("Create")');
    await expect(page.locator("#layerList .layer-row")).toHaveCount(3);
    const image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(127, 127, 255), 3, "adjustment inverts the composite");
  });

  test("⌘G groups and ⇧⌘G ungroups with undo restoring the manifest", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.keyboard.press("Control+g");
    expect(await page.evaluate(() => window.__session.doc.manifest.layers.length)).toBe(3);
    const image = await snapshot(page);
    expectRGBA(px(image, 8, 12), SOLID(128, 128, 0), 2, "grouping preserves rendering");
    await page.keyboard.press("Control+Shift+g");
    expect(await page.evaluate(() => window.__session.doc.manifest.layers.length)).toBe(2);
  });

  test("Canvas Only (F) hides the panels and pressing F again restores them", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.keyboard.press("f");
    await expect(page.locator("#layersPanel")).toBeHidden();
    await expect(page.locator("#projects")).toBeHidden();
    await page.keyboard.press("f");
    await expect(page.locator("#layersPanel")).toBeVisible();
  });

  test("⌘W close, ⌘N re-creates a canvas without reopening a folder", async ({ page, request }) => {
    const projects = await fixtureFS(request);
    await boot(page, projects, "p-basic");
    await page.keyboard.press("Control+w");
    await expect(page.locator("#status")).toContainText("Closed project");
    await page.keyboard.press("Control+n");
    await expect(page.locator("#sheetOverlay")).toBeVisible();
    await page.click('#sheetOverlay button:has-text("Cancel")');
  });
});
