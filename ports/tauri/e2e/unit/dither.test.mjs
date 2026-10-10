// Unit tests for the dither engine ported from DitherPixels.c. Expected values are
// computed by hand from the C formulas (serpentine error diffusion, ordered Bayer
// thresholds, per-channel tone planes), not from the JS code.
import { test } from "node:test";
import assert from "node:assert/strict";

// Node has no ImageData; the kernel only touches .data/.width/.height.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

import { applyDither, DITHER_STYLES } from "../../src/js/dither.js";

function pixelsOf(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = color[3] ?? 255;
    }
  }
  return data;
}

function at(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

const GRAY = (x, y) => [128, 128, 128, 255];

test("style list matches the C enum order", () => {
  assert.deepEqual(DITHER_STYLES, [
    "Floyd-Steinberg", "Atkinson", "Bayer 2", "Bayer 4", "Bayer 8",
    "Scanlines", "Halftone Dots", "Halftone Lines", "Halftone Diamond", "Patterns",
  ]);
});

test("Atkinson diffuses six eighths of the error to the next pixel", () => {
  // 128/255 ≈ 0.50196 quantizes up to 1.0 (white); the −0.498/8 error lands on the
  // only in-range Atkinson tap of a 2×1 image, pushing the second pixel to black.
  const data = pixelsOf(2, 1, GRAY);
  applyDither(new ImageData(data, 2, 1), { style: "Atkinson", levels: 2, monochrome: true });
  assert.deepEqual(at(data, 2, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [0, 0, 0, 255]);
});

test("Floyd-Steinberg at four levels quantizes to 2/3 and 1/3", () => {
  // 0.50196 · 3 = 1.50588 → 2 → 0.66667; the −0.16667·7/16 error drops the next
  // pixel to 0.42988 · 3 → 1 → 0.33333.
  const data = pixelsOf(2, 1, GRAY);
  applyDither(new ImageData(data, 2, 1), { style: "Floyd-Steinberg", levels: 4, monochrome: true });
  assert.deepEqual(at(data, 2, 0, 0), [170, 170, 170, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [85, 85, 85, 255]);
});

test("Bayer 2 ordered thresholds pick dark then light", () => {
  // Thresholds 0.125 and 0.625: 0.50196+0.125 floors to 0, +0.625 floors to 1.
  const data = pixelsOf(2, 1, GRAY);
  applyDither(new ImageData(data, 2, 1), { style: "Bayer 2", levels: 2, monochrome: true });
  assert.deepEqual(at(data, 2, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [255, 255, 255, 255]);
});

test("original-colors mode dithers each channel independently", () => {
  const data = pixelsOf(2, 1, (x) => (x === 0 ? [200, 50, 50, 255] : [40, 60, 220, 255]));
  applyDither(new ImageData(data, 2, 1), { style: "Bayer 2", levels: 2, monochrome: false });
  // Per channel against thresholds 0.125 / 0.625: red 0.784→0, blue 0.863→1.
  assert.deepEqual(at(data, 2, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [0, 0, 255, 255]);
});

test("custom dark and light colors replace black and white", () => {
  const data = pixelsOf(2, 1, GRAY);
  applyDither(new ImageData(data, 2, 1), {
    style: "Bayer 2", levels: 2, monochrome: true, dark: [10, 20, 30], light: [200, 210, 220],
  });
  assert.deepEqual(at(data, 2, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [200, 210, 220, 255]);
});

test("fully transparent pixels are left untouched", () => {
  // The C skips !alpha pixels entirely: their color bytes survive as-is under
  // the zero alpha rather than being zeroed.
  const data = pixelsOf(2, 1, (x) => [128, 128, 128, 0]);
  applyDither(new ImageData(data, 2, 1), { style: "Bayer 2", levels: 2, monochrome: true });
  assert.deepEqual(at(data, 2, 0, 0), [128, 128, 128, 0]);
  assert.deepEqual(at(data, 2, 1, 0), [128, 128, 128, 0]);
});

test("levels clamp into 2..16", () => {
  // levels 1 clamps to 2, so mid gray still dithers instead of crashing.
  const data = pixelsOf(2, 1, GRAY);
  applyDither(new ImageData(data, 2, 1), { style: "Bayer 2", levels: 1, monochrome: true });
  assert.deepEqual(at(data, 2, 0, 0), [0, 0, 0, 255]);
});

test("halftones and patterns stay on the two palette colors", () => {
  for (const style of ["Halftone Dots", "Halftone Lines", "Halftone Diamond", "Patterns"]) {
    const data = pixelsOf(8, 8, GRAY);
    applyDither(new ImageData(data, 8, 8), { style, levels: 2, monochrome: true });
    for (let i = 0; i < data.length; i += 4) {
      const value = [data[i], data[i + 1], data[i + 2]];
      const isDark = value.every((v) => v === 0);
      const isLight = value.every((v) => v === 255);
      assert.ok(isDark || isLight, `${style} produced ${value}`);
      assert.equal(data[i + 3], 255);
    }
  }
});

test("Scanlines glow mid gray at the hand-computed beam value", () => {
  // Mid gray: tone 0.50196; the beam ×1.35 → 0.67765, beam half-height
  // 0.2 + 0.5·√0.50196 = 0.55425, offset 0.5 → cover 0.55425,
  // value 0.67765 · 0.55425 · 255 ≈ 96. Scanlines render continuous beam
  // coverage, so intermediate values are correct here (unlike the mark styles).
  const data = pixelsOf(8, 8, GRAY);
  applyDither(new ImageData(data, 8, 8), { style: "Scanlines", levels: 2, monochrome: true });
  for (let i = 0; i < data.length; i += 4) {
    assert.deepEqual([data[i], data[i + 1], data[i + 2], data[i + 3]], [96, 96, 96, 255]);
  }
});

test("Scanlines dots and wobble shift the sampling without touching alpha", () => {
  const data = pixelsOf(8, 8, GRAY);
  applyDither(new ImageData(data, 8, 8), { style: "Scanlines", levels: 2, monochrome: true, dots: 100, wobble: 8 });
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i + 3], 255);
    const value = data[i];
    assert.ok(value >= 0 && value <= 255, `scanline value ${value} out of range`);
  }
  // A wobbled line sampling off the left edge averages nothing: the scan tone
  // falls to 0, so those pixels stay on the dark screen (shift 2 for line 0).
  const data2 = pixelsOf(8, 8, GRAY);
  applyDither(new ImageData(data2, 8, 8), { style: "Scanlines", levels: 2, monochrome: true, wobble: 8 });
  assert.deepEqual(at(data2, 8, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(at(data2, 8, 0, 1), [0, 0, 0, 255]);
});
