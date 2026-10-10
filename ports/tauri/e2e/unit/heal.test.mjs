// Spot healing unit tests: the membrane solve flattens a hole to its ring on a
// flat image, and Content-Aware fills from a matching source patch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spotHeal } from "../../src/js/heal.js";

function flatImage(width, height, gray) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = gray;
    data[i * 4 + 1] = gray;
    data[i * 4 + 2] = gray;
    data[i * 4 + 3] = 255;
  }
  return data;
}

test("Very Smooth heals a hole to the surrounding flat color", () => {
  const width = 64;
  const height = 64;
  const data = flatImage(width, height, 100);
  const coverage = new Uint8Array(width * height);
  for (let y = 28; y < 36; y += 1) {
    for (let x = 28; x < 36; x += 1) coverage[y * width + x] = 255;
  }
  spotHeal(data, coverage, width, height, 1, 1, 42);
  for (let y = 28; y < 36; y += 1) {
    for (let x = 28; x < 36; x += 1) {
      const i = (y * width + x) * 4;
      assert.ok(Math.abs(data[i] - 100) <= 2, `pixel ${x},${y} is ${data[i]}`);
      assert.equal(data[i + 3], 255);
    }
  }
});

test("Content-Aware fills the hole from a matching source patch", () => {
  const width = 96;
  const height = 96;
  const data = flatImage(width, height, 60);
  // The blemish: a bright block whose surroundings are flat gray. Content-Aware
  // finds a gray patch and pulls the hole back to the surroundings.
  const coverage = new Uint8Array(width * height);
  for (let y = 40; y < 52; y += 1) {
    for (let x = 20; x < 32; x += 1) {
      coverage[y * width + x] = 255;
      const i = (y * width + x) * 4;
      data[i] = 200; data[i + 1] = 200; data[i + 2] = 200;
    }
  }
  spotHeal(data, coverage, width, height, 1, 0, 7);
  for (let y = 40; y < 52; y += 1) {
    for (let x = 20; x < 32; x += 1) {
      const i = (y * width + x) * 4;
      assert.ok(data[i] <= 100, `pixel ${x},${y} is ${data[i]}, want healed toward gray`);
    }
  }
  // Outside the hole nothing moved.
  assert.equal(data[0], 60);
  assert.equal(data[(30 * width + 50) * 4], 60);
});

test("Healing respects opacity: a 50% stroke blends halfway", () => {
  const width = 64;
  const height = 64;
  const data = flatImage(width, height, 100);
  const coverage = new Uint8Array(width * height);
  for (let y = 30; y < 34; y += 1) {
    for (let x = 30; x < 34; x += 1) coverage[y * width + x] = 255;
  }
  for (let y = 30; y < 34; y += 1) {
    for (let x = 30; x < 34; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 200; data[i + 1] = 200; data[i + 2] = 200;
    }
  }
  // Very Smooth on a flat image converges toward the ring's 100; the grain term
  // is bounded by the local detail (the hole's own contrast), so a half-strength
  // stroke lands near the halfway blend of 150, never at either extreme.
  spotHeal(data, coverage, width, height, 0.5, 1, 1);
  const i = (31 * width + 31) * 4;
  assert.ok(data[i] >= 120 && data[i] <= 180, `center pixel is ${data[i]}, want ~150`);
  // A second stroke over the same spot at full strength finishes the job.
  spotHeal(data, coverage, width, height, 1, 1, 2);
  assert.ok(data[i] >= 95 && data[i] <= 130, `after full heal: ${data[i]}, want ~100`);
});
