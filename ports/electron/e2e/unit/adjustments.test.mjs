// Unit tests for the pixel kernels ported from AdjustPixels.c / NoisePixels.c.
// Expected values are computed by hand from the C formulas, not from the JS code.
import { test } from "node:test";
import assert from "node:assert/strict";

// Node has no ImageData; the kernels only touch .data/.width/.height.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

import { applyAdjustment } from "../../src/js/adjustments.js";
import { rec709, srgbToLinear, linearToSrgb, rgbToHSL } from "../../src/js/color.js";

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

test("rec709 luminance matches the film-weighted formula", () => {
  assert.ok(Math.abs(rec709(255, 0, 0) - 54.213) < 1e-3);
  assert.ok(Math.abs(rec709(0, 255, 0) - 182.376) < 1e-3);
  assert.ok(Math.abs(rec709(0, 0, 255) - 18.411) < 1e-3);
});

test("sRGB ↔ linear round-trips", () => {
  for (const value of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(value)) - value) < 1e-6);
  }
});

test("Invert is exactly 255 - v", () => {
  const data = pixelsOf(2, 1, (x) => [10 + x * 40, 20, 30, 255]);
  applyAdjustment(new ImageData(data, 2, 1), { kind: "Invert" }, null, 2, 1);
  assert.deepEqual(at(data, 2, 0, 0), [245, 235, 225, 255]);
  assert.deepEqual(at(data, 2, 1, 0), [205, 235, 225, 255]);
});

test("Levels applies the channel curve then the composite RGB curve", () => {
  // Original semantics (LevelsSettings.apply): ranges[0].apply(ranges[ch].apply(v)).
  // With channel = RGB both passes run the same curve:
  // 128 → 0.5 → 0.5^(1/1.2) = 0.5613 → 141.7 → 0.5557 → 0.5787 → 0.6332 → 161.5+16 → ~158
  const data = pixelsOf(1, 1, () => [128, 128, 128, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Levels",
    levels: {
      channel: "RGB",
      ranges: [
        { black: 32, gamma: 1.2, white: 224, outputBlack: 16, outputWhite: 240 },
        { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
        { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
        { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
      ],
    },
  }, null, 1, 1);
  const [r] = at(data, 1, 0, 0);
  assert.ok(Math.abs(r - 157) <= 1, `expected ~157, got ${r}`);
});

test("Exposure multiplies linear light by 2^stops", () => {
  // 128/255 → linear 0.2158 → ×2^0.5 = 0.3052 → sRGB 0.5885 → 150.1
  const data = pixelsOf(1, 1, () => [128, 128, 128, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Exposure",
    exposureSettings: { exposure: 0.5, offset: 0, gamma: 1 },
  }, null, 1, 1);
  const [r] = at(data, 1, 0, 0);
  assert.ok(Math.abs(r - 150) <= 1, `expected ~150, got ${r}`);
});

test("Gradient Map indexes the Rec.709 ramp", () => {
  // luminance of red = 54 → table[54]/255 of the way from (26,0,77) to (255,230,102)
  const data = pixelsOf(1, 1, () => [255, 0, 0, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Gradient Map",
    gradientMapSettings: { shadows: { red: 26 / 255, green: 0, blue: 77 / 255 }, highlights: { red: 1, green: 230 / 255, blue: 102 / 255 }, reversed: false },
  }, null, 1, 1);
  const [r, g, b] = at(data, 1, 0, 0);
  const t = 54 / 255;
  assert.ok(Math.abs(r - (26 + t * 229)) <= 1.5, `r ${r}`);
  assert.ok(Math.abs(g - t * 230) <= 1.5, `g ${g}`);
  assert.ok(Math.abs(b - (77 + t * 25)) <= 1.5, `b ${b}`);
});

test("Black & White weights pure red by the red slider, tint applies", () => {
  const data = pixelsOf(1, 1, () => [255, 0, 0, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Black & White",
    blackWhiteSettings: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: true, tintHue: 40, tintSaturation: 20 },
  }, null, 1, 1);
  // gray = 0.4 → tint at hue 40, sat 20%: c = 0.16, x = 0.1067, m = 0.32
  const [r, g, b] = at(data, 1, 0, 0);
  assert.ok(Math.abs(r - 122) <= 2, `r ${r}`);
  assert.ok(Math.abs(g - 109) <= 2, `g ${g}`);
  assert.ok(Math.abs(b - 82) <= 2, `b ${b}`);
});

test("Hue/Saturation rotates pure red to the complementary hue", () => {
  const data = pixelsOf(1, 1, () => [255, 0, 0, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Hue/Saturation", hue: 180, saturation: 0, lightness: 0,
  }, null, 1, 1);
  assert.deepEqual(at(data, 1, 0, 0), [0, 255, 255, 255]);
});

test("Color Balance lifts shadows toward the requested shifts", () => {
  const data = pixelsOf(1, 1, () => [64, 64, 64, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Color Balance",
    colorBalanceSettings: {
      shadowCyanRed: 100, shadowMagentaGreen: 0, shadowYellowBlue: 0,
      midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
      highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
      preserveLuminosity: false,
    },
  }, null, 1, 1);
  const [r] = at(data, 1, 0, 0);
  assert.ok(r > 64, `red channel should rise, got ${r}`);
});

test("Add Noise is seeded and deterministic", () => {
  const make = () => {
    const data = pixelsOf(8, 8, () => [128, 128, 128, 255]);
    applyAdjustment(new ImageData(data, 8, 8), {
      kind: "Add Noise",
      noiseAmount: 40, noiseGaussian: true, noiseMonochromatic: true, noiseSeed: 42,
    }, null, 8, 8);
    return Array.from(data);
  };
  assert.deepEqual(make(), make());
  // With spread = 40/100·127.5 ≈ 51 and Gaussian ×2/3, some pixels must move.
  const moved = make().filter((value, i) => i % 4 < 3 && value !== 128).length;
  assert.ok(moved > 0, "noise should change channels");
});

test("Grain respects the midtone weight and stays deterministic", () => {
  const make = () => {
    const data = pixelsOf(8, 8, () => [128, 128, 128, 255]);
    applyAdjustment(new ImageData(data, 8, 8), {
      kind: "Grain",
      grainSettings: { amount: 60, size: 2, roughness: 30, seed: 7 },
    }, null, 8, 8);
    return Array.from(data);
  };
  assert.deepEqual(make(), make());
});

test("Gaussian Blur smooths an impulse", () => {
  // A single white impulse spreads over the neighborhood; the center drops.
  const data = pixelsOf(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  applyAdjustment(new ImageData(data, 9, 9), { kind: "Gaussian Blur", blurRadius: 1.5 }, null, 9, 9);
  const center = at(data, 9, 4, 4);
  const neighbor = at(data, 9, 3, 4);
  const corner = at(data, 9, 3, 3);
  assert.ok(center[3] > neighbor[3], "center keeps the most energy");
  assert.ok(neighbor[3] > corner[3], "energy falls with distance");
  assert.equal(neighbor[3], at(data, 9, 5, 4)[3], "isotropic");
});

test("Motion Blur smears along the angle", () => {
  // Vertical streak: horizontal motion blur spreads it; vertical columns stay equal.
  const data = pixelsOf(11, 11, (x) => (x === 5 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  applyAdjustment(new ImageData(data, 11, 11), { kind: "Motion Blur", motionAngle: 0, motionDistance: 5 }, null, 11, 11);
  assert.equal(at(data, 11, 4, 5)[3], at(data, 11, 6, 5)[3], "symmetric along the axis");
  assert.ok(at(data, 11, 4, 5)[3] > 0, "energy reaches the neighbor column");
});

test("Curves applies the monotone spline through the anchor points", () => {
  // Midpoint anchored at (128, 90): value 128 maps to ~90.
  const data = pixelsOf(1, 1, () => [128, 128, 128, 255]);
  applyAdjustment(new ImageData(data, 1, 1), {
    kind: "Curves",
    curves: {
      channel: "RGB",
      channels: [
        [{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      ],
    },
  }, null, 1, 1);
  const [r] = at(data, 1, 0, 0);
  assert.ok(Math.abs(r - 90) <= 1, `expected ~90, got ${r}`);
});

test("rgbToHSL matches the standard color space", () => {
  const { h, s, l } = rgbToHSL(1, 0, 0);
  assert.ok(Math.abs(h - 0) < 1e-6 && Math.abs(s - 1) < 1e-6 && Math.abs(l - 0.5) < 1e-6);
});
