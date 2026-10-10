// Generates one .comp fixture project per feature group, exercising every format
// version's fields with small canvases so E2E pixel assertions stay fast.
// Run: node e2e/fixtures/gen.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paintPng, encodeGrayPng } from "./png.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const out = join(root, "e2e", "fixtures", "projects");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const uuidCounters = {};
function uuid(prefix) {
  uuidCounters[prefix] = (uuidCounters[prefix] || 0) + 1;
  return `${prefix}${String(uuidCounters[prefix]).padStart(4, "0")}`;
}

let idCounter = 0;
function id() { idCounter += 1; return `11111111-1111-1111-1111-${String(idCounter).padStart(12, "0")}`; }

function project(name, manifest, files) {
  const dir = join(out, `${name}.comp`);
  mkdirSync(join(dir, "images"), { recursive: true });
  manifest = { format: "com.compositor.project", version: 11, colorSpace: "sRGB", width: 32, height: 24, activeLayerID: manifest.layers.at(-1)?.id ?? null, ...manifest };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, buffer] of Object.entries(files || {})) {
    writeFileSync(join(dir, "images", file), buffer);
  }
}

function layer(overrides = {}) {
  return {
    id: id(),
    name: overrides.name || "Layer",
    isVisible: true,
    transform: {
      origin: { x: 0, y: 0 },
      size: { width: overrides.width ?? 32, height: overrides.height ?? 24 },
      rotation: 0, flipX: false, flipY: false, sampling: "Smooth",
    },
    ...overrides,
  };
}

const solid = (r, g, b, a = 255) => paintPng(32, 24, () => [r, g, b, a]);

// ---- p-basic: plain pixel layers, visibility, opacity, PNG export source ----
{
  const bottom = solid(255, 0, 0);
  const top = paintPng(32, 24, (x) => (x < 16 ? [0, 255, 0, 255] : [0, 0, 255, 128]));
  const a = layer({ name: "Bottom", imageFile: "bottom.png" });
  const b = layer({ name: "Top", imageFile: "top.png", opacity: 0.5 });
  project("p-basic", { layers: [a, b] }, { "bottom.png": bottom, "top.png": top });
}

// ---- p-groups: nested groups, inherited visibility, folder opacity (v8) ----
{
  const img = solid(0, 128, 255);
  const group = layer({ name: "Folder", isGroup: true });
  const child1 = layer({ name: "Child 1", imageFile: "c1.png", parentID: group.id });
  const child2 = layer({ name: "Child 2", imageFile: "c2.png", parentID: group.id, isVisible: false });
  const nested = layer({ name: "Nested", isGroup: true, parentID: group.id, opacity: 0.5 });
  const leaf = layer({ name: "Deep", imageFile: "c3.png", parentID: nested.id });
  const root2 = layer({ name: "Hidden Folder", isGroup: true, isVisible: false });
  const hiddenChild = layer({ name: "H", imageFile: "c1.png", parentID: root2.id });
  project("p-groups", { layers: [child1, child2, leaf, nested, group, hiddenChild, root2] },
    { "c1.png": img, "c2.png": solid(255, 255, 0), "c3.png": solid(255, 0, 255) });
}

// ---- p-blend: all nine blend modes ----
{
  const files = {};
  const layers = [];
  const bg = layer({ name: "BG", imageFile: "bg.png" });
  layers.push(bg);
  files["bg.png"] = paintPng(32, 24, (x, y) => [x * 8, y * 10, 128, 255]);
  const modes = ["Multiply", "Screen", "Overlay", "Darken", "Lighten", "Difference", "Color Dodge", "Color Burn"];
  modes.forEach((mode, index) => {
    const file = `blend${index}.png`;
    files[file] = solid(180, 90, 60);
    layers.push(layer({ name: mode, imageFile: file, blendMode: mode, transform: { origin: { x: 2 + index, y: 1 }, size: { width: 16, height: 12 }, rotation: 0, flipX: false, flipY: false, sampling: "Smooth" } }));
  });
  project("p-blend", { layers }, files);
}

// ---- p-masks: raster mask, disabled mask, unlinked placement, group mask ----
{
  const mask = encodeGrayPng(32, 24, Buffer.from(Array.from({ length: 32 * 24 }, (_, i) => {
    const x = i % 32;
    return x < 16 ? 255 : 0;
  })));
  const smallMask = encodeGrayPng(1, 1, Buffer.from([128]));
  const files = { "img.png": solid(255, 128, 0), "img2.png": solid(0, 200, 100), "group.png": solid(60, 60, 200) };
  const masked = layer({ name: "Masked", imageFile: "img.png", maskFile: "img.mask.png", maskEnabled: true });
  const disabled = layer({ name: "MaskOff", imageFile: "img2.png", maskFile: "img2.mask.png", maskEnabled: false });
  const unlinked = layer({ name: "Unlinked", imageFile: "img.png", maskFile: "img2.mask.png", maskPlacement: { origin: { x: 16, y: 0 }, size: { width: 16, height: 24 }, rotation: 0, flipX: false, flipY: false, sampling: "Nearest" } });
  const folder = layer({ name: "Masked Folder", isGroup: true, maskFile: "folder.mask.png", maskEnabled: true });
  const inside = layer({ name: "Inside", imageFile: "group.png", parentID: folder.id });
  project("p-masks", { layers: [masked, disabled, unlinked, inside, folder] },
    { ...files, "img.mask.png": mask, "img2.mask.png": smallMask, "folder.mask.png": mask });
}

// ---- p-clipping: maskSourceID base + two clipped layers + a chain ----
{
  const files = {
    "base.png": paintPng(32, 24, (x, y) => (x < 12 ? [255, 255, 255, 255] : [0, 0, 0, 0])),
    "a.png": solid(255, 0, 0),
    "b.png": solid(0, 255, 0),
    "c.png": solid(0, 0, 255),
  };
  const base = layer({ name: "Base", imageFile: "base.png" });
  const clippedA = layer({ name: "Clip A", imageFile: "a.png", maskSourceID: base.id });
  const clippedB = layer({ name: "Clip B", imageFile: "b.png", maskSourceID: base.id });
  const chained = layer({ name: "Chain", imageFile: "c.png", maskSourceID: clippedA.id });
  project("p-clipping", { layers: [base, clippedA, clippedB, chained] }, files);
}

// ---- p-adjust: one adjustment layer per kind (v7 + v9) with live values ----
{
  const files = { "photo.png": paintPng(32, 24, (x, y) => [x * 8, y * 10, (x + y) * 4, 255]) };
  const photo = layer({ name: "Photo", imageFile: "photo.png" });
  const make = (name, adjustment) => {
    const record = layer({ name, adjustment: { kind: name, ...adjustment } });
    record.imageFile = undefined;
    record.transform = { origin: { x: 0, y: 0 }, size: { width: 32, height: 24 }, rotation: 0, flipX: false, flipY: false, sampling: "Smooth" };
    return record;
  };
  const records = [
    photo,
    make("Invert", {}),
    make("Levels", { levels: { channel: "RGB", ranges: [
      { black: 32, gamma: 1.2, white: 224, outputBlack: 16, outputWhite: 240 },
      { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
      { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
      { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 },
    ] } }),
    make("Exposure", { exposureSettings: { exposure: 0.5, offset: 0.05, gamma: 1.1 } }),
    make("Gradient Map", { gradientMapSettings: { shadows: { red: 0.1, green: 0, blue: 0.3 }, highlights: { red: 1, green: 0.9, blue: 0.4 }, reversed: false } }),
    make("Black & White", { blackWhiteSettings: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: true, tintHue: 40, tintSaturation: 20 } }),
    make("Color Balance", { colorBalanceSettings: { shadowCyanRed: -30, shadowMagentaGreen: 10, shadowYellowBlue: 20, midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0, highlightCyanRed: 20, highlightMagentaGreen: 0, highlightYellowBlue: -20, preserveLuminosity: true } }),
    make("Gaussian Blur", { blurRadius: 2.5 }),
    make("Motion Blur", { motionAngle: 30, motionDistance: 5 }),
    make("Add Noise", { noiseAmount: 40, noiseGaussian: true, noiseMonochromatic: true, noiseSeed: 42 }),
    make("Grain", { grainSettings: { amount: 60, size: 2, roughness: 30, seed: 7 } }),
    make("Hue/Saturation", { hue: 90, saturation: 40, lightness: 10 }),
    make("Curves", { curves: { channel: "RGB", channels: [
      [{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }],
      [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    ] } }),
  ];
  project("p-adjust", { layers: records }, files);
}

// ---- p-adjust-invert: one Invert over the photo, for exact formula checks ----
{
  const files = { "photo.png": paintPng(32, 24, (x, y) => [x * 8, y * 10, (x + y) * 4, 255]) };
  const photo = layer({ name: "Photo", imageFile: "photo.png" });
  const invert = layer({ name: "Invert", adjustment: { kind: "Invert" } });
  invert.imageFile = undefined;
  invert.transform = { origin: { x: 0, y: 0 }, size: { width: 32, height: 24 }, rotation: 0, flipX: false, flipY: false, sampling: "Smooth" };
  project("p-adjust-invert", { layers: [photo, invert] }, files);
}

// ---- p-text: text layer with colorRuns (v10) and fontRuns (v11), boxSize ----
{
  const text = layer({
    name: "Hello",
    text: {
      content: "Hello World",
      fontName: "Helvetica", fontSize: 12,
      red: 0, green: 0, blue: 0, alignment: "Left", tracking: 0, leading: 0,
      boxSize: { width: 28, height: 20 },
      colorRuns: [{ location: 6, length: 5, red: 1, green: 0, blue: 0 }],
      fontRuns: [{ location: 0, length: 5, fontName: "Courier New" }],
    },
  });
  text.imageFile = "text.png"; // raster fallback ships with the fixture
  const liveText = layer({
    name: "Live Text",
    text: {
      content: "Hi",
      fontName: "Helvetica", fontSize: 12,
      red: 0, green: 0, blue: 0, alignment: "Left", tracking: 0, leading: 0,
      boxSize: null, colorRuns: null, fontRuns: null,
    },
  });
  liveText.transform = { origin: { x: 2, y: 2 }, size: { width: 20, height: 10 }, rotation: 0, flipX: false, flipY: false, sampling: "Smooth" };
  project("p-text", { version: 11, layers: [text, liveText] }, { "text.png": paintPng(32, 24, (x, y) => (x > 2 && x < 30 && y > 4 && y < 18) ? [10, 10, 10, 255] : [0, 0, 0, 0]) });
}

// ---- p-guides: guides array (v8) ----
{
  const a = layer({ name: "Only", imageFile: "a.png" });
  project("p-guides", {
    guides: [
      { id: id(), axis: "vertical", position: 16 },
      { id: id(), axis: "horizontal", position: 12 },
    ],
    layers: [a],
  }, { "a.png": solid(200, 200, 0) });
}

// ---- p-shape: shape metadata (rectangle + line) + a live shape without an asset ----
{
  const files = { "rect.png": solid(255, 0, 0), "line.png": solid(0, 0, 255) };
  const rect = layer({ name: "Rectangle", imageFile: "rect.png", shape: { kind: "Rectangle", red: 1, green: 0, blue: 0, cornerRadius: 4 } });
  const line = layer({ name: "Line", imageFile: "line.png", shape: { kind: "Line", red: 0, green: 0, blue: 1, cornerRadius: 0, lineWidth: 3, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } });
  const live = layer({ name: "Live Shape", shape: { kind: "Ellipse", red: 0, green: 1, blue: 0, cornerRadius: 0 } });
  live.transform = { origin: { x: 8, y: 6 }, size: { width: 12, height: 10 }, rotation: 0, flipX: false, flipY: false, sampling: "Smooth" };
  project("p-shape", { layers: [rect, line, live] }, files);
}

// ---- p-transform: rotation, flips, all sampling modes ----
{
  const files = { "img.png": paintPng(32, 24, (x, y) => (x < 4 || y < 4 ? [255, 255, 255, 255] : [x * 7 % 256, y * 9 % 256, 64, 255])) };
  const base = (overrides) => layer({ name: "T", imageFile: "img.png", ...overrides });
  const rotated = base({ name: "Rot 45", transform: { origin: { x: 0, y: 0 }, size: { width: 32, height: 24 }, rotation: 45, flipX: false, flipY: false, sampling: "Smooth" } });
  const flipped = base({ name: "Flip", transform: { origin: { x: 0, y: 0 }, size: { width: 32, height: 24 }, rotation: 0, flipX: true, flipY: true, sampling: "Smooth" } });
  const nearest = base({ name: "Nearest", transform: { origin: { x: 0, y: 0 }, size: { width: 64, height: 48 }, rotation: 0, flipX: false, flipY: false, sampling: "Nearest" } });
  const high = base({ name: "High", transform: { origin: { x: 0, y: 0 }, size: { width: 64, height: 48 }, rotation: 0, flipX: false, flipY: false, sampling: "High quality" } });
  project("p-transform", { layers: [rotated, flipped, nearest, high] }, files);
}

// ---- p-versioned: a v3 file with only v3-era fields ----
{
  const a = layer({ name: "Old", imageFile: "a.png", opacity: 0.7, blendMode: "Multiply" });
  a.transform.sampling = "Smooth";
  project("p-versioned", { version: 3, layers: [a] }, { "a.png": solid(255, 0, 128) });
}

// ---- Broken packages for error-path tests ----
{
  const dir = join(out, "p-badjson.comp");
  mkdirSync(join(dir, "images"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{ not json");
}
{
  const a = layer({ name: "X", imageFile: "missing.png" });
  project("p-missing-asset", { layers: [a] }, {});
}
{
  const a = layer({ name: "X", imageFile: "a.png" });
  project("p-badversion", { version: 12, layers: [a] }, { "a.png": solid(1, 2, 3) });
}

console.log(`Fixtures written to ${out}`);
