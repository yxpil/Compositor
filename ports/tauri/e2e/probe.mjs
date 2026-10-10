// Temporary runtime probe: shim getImageData to see the bad arguments.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (error) => console.log("PAGEERROR:", error.message));
page.on("console", (m) => console.log("CONSOLE:", m.text()));

const response = await page.request.get("http://localhost:4173/__e2e/fs");
const projects = (await response.json()).projects;
await page.addInitScript((fs) => {
  window.__E2E_FS = fs;
  window.__E2E_ROOT = "/mock";
  const original = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const bad = args.some((value) => !Number.isFinite(value) || !Number.isInteger(value));
    if (bad) {
      const shown = args.map((value) => (Number.isNaN(value) ? "NaN" : String(value)));
      console.log(`BAD getImageData(${shown.join(", ")}) on canvas ${this.canvas.width}x${this.canvas.height}`);
      console.log(new Error().stack);
    }
    return original.apply(this, args);
  };
}, projects);
await page.goto("http://localhost:4173/");
await page.fill("#folderPath", "/mock");
await page.click("#refresh");
await page.click('#projectList li:has-text("p-basic")');
await page.waitForTimeout(400);
await page.locator("#layerList .layer-row").first().click();
await page.locator('.tool-button[data-tool="brush"]').click();
await page.evaluate(() => {
  const canvas = document.getElementById("canvas");
  const rect = canvas.getBoundingClientRect();
  const x = rect.left + (4.5 / 32) * rect.width;
  const y = rect.top + (4.5 / 24) * rect.height;
  canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
});
await page.waitForTimeout(300);
const result = await page.evaluate(() => {
  const data = document.getElementById("canvas").getContext("2d").getImageData(4, 4, 1, 1).data;
  return { px44: [...data], status: document.getElementById("status").textContent };
});
console.log("RESULT:", JSON.stringify(result));
await browser.close();
