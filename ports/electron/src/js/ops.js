// Document and layer operations: new project, layer lifecycle, group creation,
// duplication, deletion, merge down and mask creation. Each edit is bracketed by
// beginEdit/endEdit so the snapshot history records it under a name.

import { session, doc, manifest, markDirty, beginEdit, endEdit, cancelEdit, emit, layerById, setActiveLayer, pushInitialHistory, renderDocument, replaceAsset } from "./state.js";
import { SAVE_VERSION, BLEND_TO_CANVAS, ADJUSTMENT_KINDS, FILTER_KINDS, V9_ADJUSTMENTS } from "./format.js";
import { createRenderer, drawTransformed } from "./render.js";
import { uniqueAssetName, trackAsset, canvasOf } from "./io.js";
import { emptyMask, invertMask, resizeMask, featherMask, makeSelection, selectionClip, colorRangeMask, subjectMask } from "./selection.js";
import { applyMotionBlur, applyNoise, applyVignette, applyTonalContrast, applyLensDistortion, applyCameraRaw, gaussianBlurPlane, lumaPlane, clampByte, applyInvert } from "./kernels.js";
import { spotHeal } from "./heal.js";
import { hexToRgb } from "./color.js";
import { applyDither, DITHER_STYLES } from "./dither.js";
import { applyAdjustment, applyGaussianBlur } from "./adjustments.js";
import { selectionCoverageGrid } from "./tools.js";

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `l-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function showSheet({ title, fields, okText = "OK", onConfirm }) {
  const existing = document.getElementById("sheetOverlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "sheetOverlay";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const heading = document.createElement("h3");
  heading.textContent = title;
  sheet.appendChild(heading);
  const inputs = {};
  for (const field of fields) {
    const row = document.createElement("label");
    row.className = "sheet-row";
    const label = document.createElement("span");
    label.textContent = field.label;
    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const option of field.options) {
        const element = document.createElement("option");
        element.value = option;
        element.textContent = option;
        input.appendChild(element);
      }
      input.value = field.value;
    } else {
      input = document.createElement("input");
      input.type = field.type || "text";
      input.value = field.value ?? "";
      if (field.type === "checkbox") input.checked = !!field.value;
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.step !== undefined) input.step = field.step;
    }
    inputs[field.key] = input;
    row.append(label, input);
    sheet.appendChild(row);
  }
  const buttons = document.createElement("div");
  buttons.className = "sheet-buttons";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const ok = document.createElement("button");
  ok.textContent = okText;
  ok.className = "primary";
  ok.addEventListener("click", () => {
    const values = {};
    for (const [key, input] of Object.entries(inputs)) {
      if (input.type === "number") values[key] = Number(input.value);
      else if (input.type === "checkbox") values[key] = input.checked;
      else values[key] = input.value;
    }
    overlay.remove();
    onConfirm(values);
  });
  buttons.append(cancel, ok);
  sheet.appendChild(buttons);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  Object.values(inputs)[0]?.focus();
}

function nextName(prefix) {
  const layers = manifest().layers;
  let n = 1;
  while (layers.some((layer) => layer.name === `${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

function subtreeOf(layer) {
  const layers = manifest().layers;
  const index = layers.indexOf(layer);
  const end = subtreeEnd(index);
  return layers.slice(index, end + 1);
}

function subtreeEnd(index) {
  const layers = manifest().layers;
  const root = layers[index].id;
  let end = index;
  for (let next = index + 1; next < layers.length; next += 1) {
    if (isDescendantOf(layers[next], root)) end = next;
  }
  return end;
}

function isDescendantOf(layer, ancestorID) {
  let current = layer.parentID ? layerById(layer.parentID) : null;
  while (current) {
    if (current.id === ancestorID) return true;
    current = current.parentID ? layerById(current.parentID) : null;
  }
  return false;
}

function insertAfterSubtree(block) {
  const layers = manifest().layers;
  const active = layerById(session.activeLayerId);
  if (!active) {
    layers.push(...block);
    return;
  }
  const index = layers.indexOf(active);
  const end = subtreeEnd(index);
  layers.splice(end + 1, 0, ...block);
}

// ---- Shared helpers for the selection / clipboard / canvas / filter ops ----

function clampNumber(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Installs a new selection as one undo step (the snapshot shares the old reference).
function setSelection(mask, label, { feather = 0 } = {}) {
  const m = manifest();
  beginEdit(label);
  session.selection = makeSelection(mask, m.width, m.height, { feather });
  endEdit();
}

function requireSelection() {
  if (!session.selection) {
    if (session.setStatus) session.setStatus("Make a selection first.", true);
    return null;
  }
  return session.selection;
}

// A paintable leaf layer with pixels on disk (groups and adjustment layers excluded).
function pixelLayerOf(id) {
  const layer = layerById(id);
  if (!layer || layer.isGroup || layer.adjustment) return null;
  if (!layer.imageFile || !session.doc.images.get(layer.imageFile)) return null;
  return layer;
}

// One layer's subtree rendered alone at document size (mask, effects, blend included).
function rasterizeSubtree(layer) {
  const m = manifest();
  const block = subtreeOf(layer).map((entry) => {
    const clone = JSON.parse(JSON.stringify(entry));
    if (entry === layer) delete clone.parentID;
    return clone;
  });
  const mini = { ...JSON.parse(JSON.stringify(m)), layers: block };
  return createRenderer(mini, session.doc.images, {
    rasterize: (leaf) => {
      const kind = leaf.shape ? "shape" : "text";
      return session.rasterizers && session.rasterizers[kind] ? session.rasterizers[kind](leaf) : null;
    },
  }).render();
}

// Clips a document-size raster to the selection's coverage. Without a selection the
// raster passes through; an empty selection yields an empty canvas.
function clipToSelection(source) {
  const selection = session.selection;
  if (!selection || !selection.bounds) return source;
  const { rect: region, coverage } = selectionClip(selection, { x: 0, y: 0, width: source.width, height: source.height });
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  if (!coverage) return out;
  const context = out.getContext("2d");
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(coverage, region.x, region.y);
  return out;
}

// The active selection's coverage resampled into a leaf layer's pixel grid.
// Null without a selection; all-zero when the selection misses the layer.
function coverageFor(layer) {
  return selectionCoverageGrid(canvasOf(session.doc.images.get(layer.imageFile)), layer);
}

function coverageMeaningful(coverage) {
  return !coverage || coverage.some((value) => value > 0);
}

// Runs a pixel edit on a leaf layer's asset; `edit(beforeCanvas)` returns the new
// canvas (or null to skip). The swap lands in the open edit for undo/redo.
function withLayerPixels(layer, edit) {
  const file = layer.imageFile;
  const before = canvasOf(session.doc.images.get(file));
  const next = edit(before);
  if (!next) return false;
  replaceAsset(file, next);
  return true;
}

// Paints one solid color over the coverage (whole layer without a selection):
// RGB mixes toward the color, alpha rises to the coverage.
function fillLayerPixels(layer, color) {
  const coverage = coverageFor(layer);
  console.log("DBG fillLayerPixels coverage:", coverage ? coverage.length : null, coverage ? coverage.slice(0, 4) : null);
  if (!coverageMeaningful(coverage)) return false;
  return withLayerPixels(layer, (before) => {
    const out = document.createElement("canvas");
    out.width = before.width;
    out.height = before.height;
    const context = out.getContext("2d", { willReadFrequently: true });
    context.drawImage(before, 0, 0);
    const image = context.getImageData(0, 0, out.width, out.height);
    const data = image.data;
    const r = Math.round(color.red * 255), g = Math.round(color.green * 255), b = Math.round(color.blue * 255);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const amount = coverage ? coverage[p] : 1;
      if (amount <= 0) continue;
      data[i] = Math.round(data[i] + (r - data[i]) * amount);
      data[i + 1] = Math.round(data[i + 1] + (g - data[i + 1]) * amount);
      data[i + 2] = Math.round(data[i + 2] + (b - data[i + 2]) * amount);
      data[i + 3] = Math.max(data[i + 3], Math.round(amount * 255));
    }
    context.putImageData(image, 0, 0);
    return out;
  });
}

// Erases the coverage (whole layer without a selection) down to transparent.
function clearLayerPixels(layer) {
  const coverage = coverageFor(layer);
  if (!coverageMeaningful(coverage)) return false;
  return withLayerPixels(layer, (before) => {
    const out = document.createElement("canvas");
    out.width = before.width;
    out.height = before.height;
    const context = out.getContext("2d", { willReadFrequently: true });
    context.drawImage(before, 0, 0);
    const image = context.getImageData(0, 0, out.width, out.height);
    const data = image.data;
    for (let i = 3, p = 0; i < data.length; i += 4, p += 1) {
      const amount = coverage ? coverage[p] : 1;
      if (amount > 0) data[i] = Math.round(data[i] * (1 - amount));
    }
    context.putImageData(image, 0, 0);
    return out;
  });
}

// ---- Canvas-space remaps (CanvasResizer semantics): where a layer's placement
// ---- lands after the canvas itself rotates or flips. Mirrors commute per axis
// ---- (F·R(r) = R(−r)·F), quarter turns swap the flip axes.

function remapTransform(t, width, height, mode) {
  const out = JSON.parse(JSON.stringify(t));
  const ox = t.origin.x, oy = t.origin.y, w = t.size.width, h = t.size.height;
  if (mode === "cw" || mode === "ccw") {
    const clockwise = mode === "cw";
    out.origin = clockwise ? { x: height - oy - h, y: ox } : { x: oy, y: width - ox - w };
    out.size = { width: h, height: w };
    out.rotation = (t.rotation || 0) + (clockwise ? 90 : -90);
    out.flipX = !!t.flipY;
    out.flipY = !!t.flipX;
  } else if (mode === "half") {
    out.origin = { x: width - ox - w, y: height - oy - h };
    out.rotation = (t.rotation || 0) + 180;
  } else if (mode === "flipH") {
    out.origin = { x: width - ox - w, y: oy };
    out.flipX = !t.flipX;
    out.rotation = -(t.rotation || 0);
  } else {
    out.origin = { x: ox, y: height - oy - h };
    out.flipY = !t.flipY;
    out.rotation = -(t.rotation || 0);
  }
  return out;
}

function remapGuides(guides, width, height, mode) {
  return guides.map((guide) => {
    const horizontal = guide.axis === "horizontal";
    let position = guide.position;
    let axis = guide.axis;
    if (mode === "cw") {
      position = horizontal ? height - position : position;
      axis = horizontal ? "vertical" : "horizontal";
    } else if (mode === "ccw") {
      position = horizontal ? position : width - position;
      axis = horizontal ? "vertical" : "horizontal";
    } else if (mode === "half") {
      position = horizontal ? height - position : width - position;
    } else if (mode === "flipH") {
      position = horizontal ? position : width - position;
    } else if (mode === "flipV") {
      position = horizontal ? height - position : position;
    }
    return { ...guide, axis, position };
  });
}

function remapWholeCanvas(mode, label) {
  const m = manifest();
  const width = m.width, height = m.height;
  beginEdit(label);
  for (const layer of m.layers) {
    layer.transform = remapTransform(layer.transform, width, height, mode);
    if (layer.maskPlacement) layer.maskPlacement = remapTransform(layer.maskPlacement, width, height, mode);
  }
  if (Array.isArray(m.guides)) m.guides = remapGuides(m.guides, width, height, mode);
  if (mode === "cw" || mode === "ccw") { m.width = height; m.height = width; }
  session.selection = null;
  endEdit();
  markDirty();
}

// ---- Filter plumbing ----

// Bloom / Glow: screen the blurred highlights back over the image.
function applyBloomToImage(image, radius, amount) {
  const width = image.width, height = image.height;
  const luma = lumaPlane(image);
  const highlights = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i += 1) highlights[i] = Math.max(0, (luma[i] - 0.65) / 0.35);
  const glow = gaussianBlurPlane(highlights, width, height, Math.max(1, radius));
  const data = image.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    if (!data[i + 3]) continue;
    const add = glow[p] * (amount / 100) * 255;
    for (let c = 0; c < 3; c += 1) data[i + c] = clampByte(data[i + c] + add);
  }
}

function byteColorMatches(data, p, reference, tolerance) {
  for (let c = 0; c < 3; c += 1) {
    const d = data[p + c] - reference[c];
    if (d < -tolerance || d > tolerance) return false;
  }
  return true;
}

// Remove Background, approximating SubjectRemoval.swift (Vision subject separation):
// a 4-connected flood from every border pixel over colors near the border average
// becomes background, and its alpha drops to zero.
function removeBackgroundPixels(before, tolerance) {
  const width = before.width, height = before.height;
  const context = before.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const border = [];
  for (let x = 0; x < width; x += 1) border.push(x, 0, x, height - 1);
  for (let y = 1; y < height - 1; y += 1) border.push(0, y, width - 1, y);
  let sr = 0, sg = 0, sb = 0, samples = 0;
  for (let i = 0; i < border.length; i += 2) {
    const p = (border[i + 1] * width + border[i]) * 4;
    if (!data[p + 3]) continue;
    sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
    samples += 1;
  }
  if (!samples) return null;
  const reference = [Math.round(sr / samples), Math.round(sg / samples), Math.round(sb / samples)];
  const mask = new Uint8Array(width * height);
  const queue = [];
  for (let i = 0; i < border.length; i += 2) {
    const x = border[i], y = border[i + 1], at = y * width + x;
    if (!mask[at] && byteColorMatches(data, at * 4, reference, tolerance)) {
      mask[at] = 255;
      queue.push(x, y);
    }
  }
  while (queue.length) {
    const y = queue.pop(), x = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const at = ny * width + nx;
      if (!mask[at] && byteColorMatches(data, at * 4, reference, tolerance)) {
        mask[at] = 255;
        queue.push(nx, ny);
      }
    }
  }
  for (let i = 0, p = 3; i < mask.length; i += 1, p += 4) {
    if (mask[i]) data[p] = Math.round(data[p] * (1 - mask[i] / 255));
  }
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d").putImageData(image, 0, 0);
  return out;
}

const FILTER_SHEET_FIELDS = {
  "Gaussian Blur": [{ key: "radius", label: "Radius (px)", type: "number", value: 10, min: 0, max: 250 }],
  "Motion Blur": [
    { key: "angle", label: "Angle (°)", type: "number", value: 0, min: -180, max: 180 },
    { key: "distance", label: "Distance (px)", type: "number", value: 10, min: 0, max: 500 },
  ],
  "Add Noise": [
    { key: "amount", label: "Amount (%)", type: "number", value: 10, min: 0, max: 100 },
    { key: "gaussian", label: "Gaussian", type: "checkbox", value: false },
    { key: "monochromatic", label: "Monochromatic", type: "checkbox", value: false },
  ],
  Vignette: [
    { key: "amount", label: "Amount", type: "number", value: 50, min: -100, max: 100 },
    { key: "midpoint", label: "Midpoint", type: "number", value: 50, min: 0, max: 100 },
    { key: "feather", label: "Feather", type: "number", value: 50, min: 0, max: 100 },
    { key: "roundness", label: "Roundness", type: "number", value: 0, min: 0, max: 100 },
    { key: "highlights", label: "Highlight Protection", type: "number", value: 0, min: 0, max: 100 },
  ],
  "Bloom / Glow": [
    { key: "radius", label: "Radius (px)", type: "number", value: 12, min: 1, max: 100 },
    { key: "amount", label: "Amount (%)", type: "number", value: 40, min: 0, max: 100 },
  ],
  Dither: [
    { key: "style", label: "Style", type: "select", options: DITHER_STYLES, value: "Atkinson" },
    { key: "levels", label: "Levels (2–16)", type: "number", value: 2, min: 2, max: 16 },
    { key: "density", label: "Density (−1..1)", type: "number", value: 0, min: -1, max: 1, step: 0.05 },
    { key: "contrast", label: "Contrast (−1..1)", type: "number", value: 0, min: -0.95, max: 1, step: 0.05 },
    { key: "monochrome", label: "Monochrome", type: "checkbox", value: true },
    // Scanlines only: bead shape and sync drift of the CRT lines.
    { key: "dots", label: "Dots (Scanlines, %)", type: "number", value: 0, min: 0, max: 100 },
    { key: "wobble", label: "Wobble (Scanlines, px)", type: "number", value: 0, min: 0, max: 64 },
  ],
  "Tonal Contrast": [
    { key: "shadows", label: "Shadows", type: "number", value: 0, min: -100, max: 100 },
    { key: "midtones", label: "Midtones", type: "number", value: 25, min: -100, max: 100 },
    { key: "highlights", label: "Highlights", type: "number", value: 0, min: -100, max: 100 },
    { key: "radius", label: "Radius (px)", type: "number", value: 16, min: 1, max: 100 },
    { key: "amount", label: "Amount (%)", type: "number", value: 50, min: 0, max: 100 },
  ],
  "Lens Correction": [{ key: "distortion", label: "Distortion", type: "number", value: 0, min: -100, max: 100 }],
  "Camera Raw Filter": [
    { key: "exposure", label: "Exposure (stops)", type: "number", value: 0, min: -5, max: 5, step: 0.05 },
    { key: "contrast", label: "Contrast", type: "number", value: 0, min: -100, max: 100 },
    { key: "vibrance", label: "Vibrance", type: "number", value: 0, min: -100, max: 100 },
    { key: "saturation", label: "Saturation", type: "number", value: 0, min: -100, max: 100 },
    { key: "temperature", label: "Temperature", type: "number", value: 0, min: -100, max: 100 },
    { key: "tint", label: "Tint", type: "number", value: 0, min: -100, max: 100 },
  ],
  "Remove Background": [{ key: "tolerance", label: "Tolerance", type: "number", value: 32, min: 0, max: 255 }],
  "Content-Aware Fill": [],
};

// Runs one filter kernel over the layer's pixels, mixing the result with the
// original by the selection coverage so only selected pixels change.
function runFilter(kind, layer, values) {
  const file = layer.imageFile;
  const before = canvasOf(session.doc.images.get(file));
  const width = before.width, height = before.height;
  const context = before.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, width, height);
  switch (kind) {
    case "Gaussian Blur":
      applyGaussianBlur(image, values.radius, 0, 0);
      break;
    case "Motion Blur":
      applyMotionBlur(image, values.angle, values.distance);
      break;
    case "Add Noise":
      applyNoise(image, values.amount, !!values.gaussian, !!values.monochromatic,
        (Math.random() * 0x100000000) >>> 0, 0, 0);
      break;
    case "Vignette":
      applyVignette(image, {
        vignetteAmount: values.amount,
        vignetteMidpoint: values.midpoint,
        vignetteRoundness: values.roundness,
        vignetteFeather: values.feather,
        vignetteHighlights: values.highlights,
        vignetteColor: { red: 0, green: 0, blue: 0 },
      }, null, true);
      break;
    case "Bloom / Glow":
      applyBloomToImage(image, values.radius, values.amount);
      break;
    case "Dither":
      applyDither(image, {
        style: values.style,
        levels: values.levels,
        density: values.density,
        contrast: values.contrast,
        monochrome: values.monochrome,
        dots: values.dots,
        wobble: values.wobble,
      });
      break;
    case "Tonal Contrast":
      applyTonalContrast(image, {
        tonalShadows: values.shadows,
        tonalMidtones: values.midtones,
        tonalHighlights: values.highlights,
        tonalRadius: values.radius,
        tonalAmount: values.amount,
      });
      break;
    case "Lens Correction":
      applyLensDistortion(image, values.distortion);
      break;
    case "Camera Raw Filter":
      applyCameraRaw(image, {
        exposure: values.exposure, contrast: values.contrast, highlights: 0, shadows: 0,
        whites: 0, blacks: 0, vibrance: values.vibrance, saturation: values.saturation,
        temperature: values.temperature, tint: values.tint,
      });
      break;
    case "Remove Background": {
      const next = removeBackgroundPixels(before, values.tolerance);
      if (!next) return null;
      return next;
    }
    case "Content-Aware Fill": {
      const coverage = coverageFor(layer);
      if (!coverage) {
        if (session.setStatus) session.setStatus("Content-Aware Fill needs a selection.", true);
        return null;
      }
      spotHeal(image.data, coverage, width, height, 1, 0, (Math.random() * 0x100000000) >>> 0);
      break;
    }
    default:
      return null;
  }
  const next = document.createElement("canvas");
  next.width = width;
  next.height = height;
  next.getContext("2d").putImageData(image, 0, 0);
  // Without a selection the whole result lands; with one, only selected pixels change.
  const coverage = coverageFor(layer);
  if (!coverage) return next;
  const original = context.getImageData(0, 0, width, height);
  const out = next.getContext("2d", { willReadFrequently: true });
  const filtered = out.getImageData(0, 0, width, height);
  for (let i = 0, p = 0; i < filtered.data.length; i += 4, p += 1) {
    const amount = coverage[p];
    if (amount >= 1) continue;
    for (let c = 0; c < 4; c += 1) {
      filtered.data[i + c] = Math.round(original.data[i + c] + (filtered.data[i + c] - original.data[i + c]) * amount);
    }
  }
  out.putImageData(filtered, 0, 0);
  return next;
}

// Per-kind edit sheets for adjustment layers (missing keys keep the kernel defaults).
const ADJUSTMENT_SHEET_FIELDS = {
  "Hue/Saturation": (a) => [
    { key: "hue", label: "Hue (°)", type: "number", value: a.hue ?? 0, min: -180, max: 180 },
    { key: "saturation", label: "Saturation", type: "number", value: a.saturation ?? 0, min: -1, max: 1, step: 0.01 },
    { key: "lightness", label: "Lightness", type: "number", value: a.lightness ?? 0, min: -1, max: 1, step: 0.01 },
  ],
  Levels: (a) => {
    const range = a.levels?.ranges?.[0] || { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 };
    return [
      { key: "black", label: "Black point", type: "number", value: range.black, min: 0, max: 254 },
      { key: "gamma", label: "Gamma", type: "number", value: range.gamma, min: 0.1, max: 10, step: 0.05 },
      { key: "white", label: "White point", type: "number", value: range.white, min: 1, max: 255 },
      { key: "outputBlack", label: "Output black", type: "number", value: range.outputBlack, min: 0, max: 255 },
      { key: "outputWhite", label: "Output white", type: "number", value: range.outputWhite, min: 0, max: 255 },
    ];
  },
  Curves: (a) => {
    const channel = a.curves?.channels?.[0] || [{ x: 0, y: 0 }, { x: 255, y: 255 }];
    const fields = [];
    channel.forEach((point, index) => {
      fields.push({ key: `px${index}`, label: `Point ${index + 1} in`, type: "number", value: point.x, min: 0, max: 255 });
      fields.push({ key: `py${index}`, label: `Point ${index + 1} out`, type: "number", value: point.y, min: 0, max: 255 });
    });
    return fields;
  },
  Exposure: (a) => {
    const e = a.exposureSettings || { exposure: 0, offset: 0, gamma: 1 };
    return [
      { key: "exposure", label: "Exposure (stops)", type: "number", value: e.exposure, min: -5, max: 5, step: 0.05 },
      { key: "offset", label: "Offset", type: "number", value: e.offset, min: -0.5, max: 0.5, step: 0.01 },
      { key: "gamma", label: "Gamma", type: "number", value: e.gamma, min: 0.1, max: 10, step: 0.05 },
    ];
  },
  "Gradient Map": (a) => {
    const map = a.gradientMapSettings || { reversed: false };
    return [{ key: "reversed", label: "Reversed", type: "checkbox", value: !!map.reversed }];
  },
  Grain: (a) => {
    const g = a.grainSettings || { amount: 25, size: 1.5, roughness: 50 };
    return [
      { key: "grainAmount", label: "Amount", type: "number", value: g.amount, min: 0, max: 100 },
      { key: "grainSize", label: "Size", type: "number", value: g.size, min: 0.5, max: 8, step: 0.1 },
      { key: "grainRoughness", label: "Roughness", type: "number", value: g.roughness, min: 0, max: 100 },
    ];
  },
  Invert: () => [],
  "Black & White": (a) => {
    const s = a.blackWhiteSettings || { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };
    return [
      { key: "reds", label: "Reds", type: "number", value: s.reds, min: -200, max: 300 },
      { key: "yellows", label: "Yellows", type: "number", value: s.yellows, min: -200, max: 300 },
      { key: "greens", label: "Greens", type: "number", value: s.greens, min: -200, max: 300 },
      { key: "cyans", label: "Cyans", type: "number", value: s.cyans, min: -200, max: 300 },
      { key: "blues", label: "Blues", type: "number", value: s.blues, min: -200, max: 300 },
      { key: "magentas", label: "Magentas", type: "number", value: s.magentas, min: -200, max: 300 },
    ];
  },
  "Color Balance": (a) => {
    const s = a.colorBalanceSettings || {
      shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0,
      midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
      highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
    };
    return [
      { key: "shadowCyanRed", label: "Shadows Cyan–Red", type: "number", value: s.shadowCyanRed, min: -100, max: 100 },
      { key: "shadowMagentaGreen", label: "Shadows Magenta–Green", type: "number", value: s.shadowMagentaGreen, min: -100, max: 100 },
      { key: "shadowYellowBlue", label: "Shadows Yellow–Blue", type: "number", value: s.shadowYellowBlue, min: -100, max: 100 },
      { key: "midCyanRed", label: "Midtones Cyan–Red", type: "number", value: s.midCyanRed, min: -100, max: 100 },
      { key: "midMagentaGreen", label: "Midtones Magenta–Green", type: "number", value: s.midMagentaGreen, min: -100, max: 100 },
      { key: "midYellowBlue", label: "Midtones Yellow–Blue", type: "number", value: s.midYellowBlue, min: -100, max: 100 },
      { key: "highlightCyanRed", label: "Highlights Cyan–Red", type: "number", value: s.highlightCyanRed, min: -100, max: 100 },
      { key: "highlightMagentaGreen", label: "Highlights Magenta–Green", type: "number", value: s.highlightMagentaGreen, min: -100, max: 100 },
      { key: "highlightYellowBlue", label: "Highlights Yellow–Blue", type: "number", value: s.highlightYellowBlue, min: -100, max: 100 },
    ];
  },
  "Gaussian Blur": (a) => [{ key: "blurRadius", label: "Radius (px)", type: "number", value: a.blurRadius ?? 10, min: 0, max: 250 }],
  "Motion Blur": (a) => [
    { key: "motionAngle", label: "Angle (°)", type: "number", value: a.motionAngle ?? 0, min: -180, max: 180 },
    { key: "motionDistance", label: "Distance (px)", type: "number", value: a.motionDistance ?? 10, min: 0, max: 500 },
  ],
  "Add Noise": (a) => [
    { key: "noiseAmount", label: "Amount (%)", type: "number", value: a.noiseAmount ?? 10, min: 0, max: 100 },
    { key: "noiseGaussian", label: "Gaussian", type: "checkbox", value: !!a.noiseGaussian },
    { key: "noiseMonochromatic", label: "Monochromatic", type: "checkbox", value: !!a.noiseMonochromatic },
  ],
};


export const documentOps = {
  install() {
    if (session.doc && !session.doc.dirtyAssets) session.doc.dirtyAssets = new Set();
  },

  newProject() {
    showSheet({
      title: "New Project",
      fields: [
        { key: "width", label: "Width (px)", type: "number", value: 1920, min: 1, max: 30000 },
        { key: "height", label: "Height (px)", type: "number", value: 1080, min: 1, max: 30000 },
        { key: "resolution", label: "Resolution (ppi)", type: "number", value: 72, min: 1, max: 9600 },
      ],
      okText: "Create",
      onConfirm: ({ width, height, resolution }) => {
        width = Math.min(30000, Math.max(1, Math.round(width) || 1920));
        height = Math.min(30000, Math.max(1, Math.round(height) || 1080));
        session.doc = {
          path: null,
          manifest: {
            format: "com.compositor.project",
            version: SAVE_VERSION,
            width,
            height,
            resolution: Math.min(9600, Math.max(1, Math.round(resolution) || 72)),
            layers: [],
          },
          images: new Map(),
          dirtyAssets: new Set(),
        };
        session.dirty = false;
        pushInitialHistory("New Project");
        session.activeLayerId = null;
        session.selectedLayerIds = new Set();
        session.viewport = { zoom: 1, offsetX: 0, offsetY: 0 };
        emit("document");
        if (session.setStatus) session.setStatus(`New project ${width}×${height} px — save to write it to disk.`);
      },
    });
  },

  addLayer() {
    if (!doc()) return;
    const m = manifest();
    beginEdit("New Layer");
    const layer = {
      id: uid(),
      name: nextName("Layer"),
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      transform: { origin: { x: 0, y: 0 }, size: { width: m.width, height: m.height } },
    };
    insertAfterSubtree([layer]);
    endEdit();
    setActiveLayer(layer.id);
    markDirty();
  },

  addGroup() {
    if (!doc()) return;
    beginEdit("New Group");
    const group = {
      id: uid(),
      name: nextName("Group"),
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      isGroup: true,
    };
    insertAfterSubtree([group]);
    endEdit();
    setActiveLayer(group.id);
    markDirty();
  },

  duplicateLayer() {
    if (!doc()) return;
    const active = layerById(session.activeLayerId);
    if (!active) return;
    beginEdit("Duplicate Layers");
    const block = subtreeOf(active);
    const idMap = new Map(block.map((layer) => [layer.id, uid()]));
    const copy = block.map((layer) => {
      const clone = JSON.parse(JSON.stringify(layer));
      clone.id = idMap.get(layer.id);
      if (clone.parentID && idMap.has(clone.parentID)) clone.parentID = idMap.get(clone.parentID);
      else if (clone.parentID) clone.parentID = undefined; // duplicated roots stay roots
      if (clone.maskSourceID && idMap.has(clone.maskSourceID)) clone.maskSourceID = idMap.get(clone.maskSourceID);
      else if (clone.maskSourceID) clone.maskSourceID = undefined; // outside the subtree
      clone.name = `${layer.name} copy`;
      return clone;
    });
    const layers = manifest().layers;
    const index = layers.indexOf(active);
    const end = subtreeEnd(index);
    layers.splice(end + 1, 0, ...copy);
    endEdit();
    setActiveLayer(idMap.get(active.id));
    markDirty();
  },

  deleteLayer() {
    if (!doc()) return;
    const active = layerById(session.activeLayerId);
    if (!active) return;
    beginEdit("Delete Layers");
    const layers = manifest().layers;
    const index = layers.indexOf(active);
    const end = subtreeEnd(index);
    const removed = layers.splice(index, end - index + 1);
    const removedIDs = new Set(removed.map((layer) => layer.id));
    // Clipping layers outside the subtree lose their target.
    for (const layer of layers) {
      if (layer.maskSourceID && removedIDs.has(layer.maskSourceID)) layer.maskSourceID = undefined;
    }
    endEdit();
    const next = layers[Math.min(index, layers.length - 1)] || null;
    setActiveLayer(next ? next.id : null);
    markDirty();
  },

  // Bakes the active layer (its whole subtree) into the layer directly below,
  // preserving the visual result, then removes the active subtree.
  mergeDown() {
    if (!doc()) return;
    const m = manifest();
    const active = layerById(session.activeLayerId);
    if (!active) return;
    const layers = m.layers;
    const index = layers.indexOf(active);
    const end = subtreeEnd(index);
    // The layer below in render order, sharing the folder (or both at root).
    let target = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (layers[i].parentID === active.parentID) { target = layers[i]; break; }
      if (!layers[i].isGroup && !isDescendantOf(active, layers[i].id)) break;
    }
    if (!target) {
      if (session.setStatus) session.setStatus("Nothing below to merge into.", true);
      return;
    }
    beginEdit("Merge Down");
    try {
      // Render the active subtree alone, at document size.
      const block = layers.slice(index, end + 1).map((layer) => {
        const clone = JSON.parse(JSON.stringify(layer));
        if (layer === active) { delete clone.parentID; }
        return clone;
      });
      const miniA = { ...JSON.parse(JSON.stringify(m)), layers: block };
      const rasterA = createRenderer(miniA, session.doc.images).render();

      // The target's own pixels in document space (no blend, no opacity: those stay).
      const merged = document.createElement("canvas");
      merged.width = m.width;
      merged.height = m.height;
      const context = merged.getContext("2d");
      const targetImage = target.imageFile ? session.doc.images.get(target.imageFile) : null;
      if (targetImage) drawTransformed(context, target.transform, targetImage);
      context.globalCompositeOperation = BLEND_TO_CANVAS[active.blendMode] || "source-over";
      context.drawImage(rasterA, 0, 0);
      context.globalCompositeOperation = "source-over";

      // Store at document size with an identity transform.
      const file = uniqueAssetName(`merged-${Date.now()}`);
      session.doc.images.set(file, merged);
      trackAsset(file);
      target.imageFile = file;
      target.transform = { origin: { x: 0, y: 0 }, size: { width: m.width, height: m.height } };
      layers.splice(index, end - index + 1);
      for (const layer of layers) {
        if (layer.maskSourceID && layer.maskSourceID === active.id) layer.maskSourceID = undefined;
      }
      setActiveLayer(target.id);
      markDirty();
    } finally {
      endEdit();
      emit("document");
    }
  },

  addMask() {
    if (!doc()) return;
    const active = layerById(session.activeLayerId);
    if (!active) return;
    beginEdit("Add Mask");
    const m = manifest();
    const width = Math.max(1, Math.round(active.transform?.size?.width || m.width));
    const height = Math.max(1, Math.round(active.transform?.size?.height || m.height));
    const mask = document.createElement("canvas");
    mask.width = width;
    mask.height = height;
    const context = mask.getContext("2d");
    context.fillStyle = "#ffffff"; // reveal all
    context.fillRect(0, 0, width, height);
    const file = uniqueAssetName(`mask-${Date.now()}`);
    session.doc.images.set(file, mask);
    trackAsset(file);
    active.maskFile = file;
    active.maskEnabled = true;
    if (active.isGroup) {
      if (m.version < 6) m.version = 6;
      if (typeof active.opacity === "number" && active.opacity !== 1 && m.version < 8) m.version = 8;
    } else if (m.version < 4) {
      m.version = 4;
    }
    endEdit();
    markDirty();
    emit("document");
  },

  // ---- Select menu ----

  selectAll() {
    if (!doc()) return;
    const m = manifest();
    setSelection(new Uint8Array(m.width * m.height).fill(255), "Select All");
  },

  deselect() {
    if (!doc() || !session.selection) return;
    beginEdit("Deselect");
    session.selection = null;
    endEdit();
  },

  inverseSelection() {
    if (!doc()) return;
    const selection = session.selection;
    if (!selection) {
      this.selectAll();
      return;
    }
    setSelection(invertMask(selection.mask, selection.width, selection.height), "Inverse Selection");
  },

  expandSelection() {
    const selection = doc() && requireSelection();
    if (!selection) return;
    showSheet({
      title: "Expand Selection",
      fields: [{ key: "amount", label: "Expand by (px)", type: "number", value: 10, min: 1, max: 500 }],
      okText: "Expand",
      onConfirm: ({ amount }) => {
        const current = session.selection;
        if (!current) return;
        setSelection(resizeMask(current.mask, current.width, current.height, clampNumber(amount, 1, 500, 10)), "Expand Selection");
      },
    });
  },

  contractSelection() {
    const selection = doc() && requireSelection();
    if (!selection) return;
    showSheet({
      title: "Contract Selection",
      fields: [{ key: "amount", label: "Contract by (px)", type: "number", value: 10, min: 1, max: 500 }],
      okText: "Contract",
      onConfirm: ({ amount }) => {
        const current = session.selection;
        if (!current) return;
        setSelection(resizeMask(current.mask, current.width, current.height, -clampNumber(amount, 1, 500, 10)), "Contract Selection");
      },
    });
  },

  featherSelection() {
    const selection = doc() && requireSelection();
    if (!selection) return;
    showSheet({
      title: "Feather Selection",
      fields: [{ key: "amount", label: "Feather radius (px)", type: "number", value: 10, min: 0, max: 250 }],
      okText: "Feather",
      onConfirm: ({ amount }) => {
        const current = session.selection;
        if (!current) return;
        setSelection(current.mask, "Feather Selection", { feather: clampNumber(amount, 0, 250, 10) });
      },
    });
  },

  // Color Range: pixels within fuzziness of one sample color (ColorRangeSheet).
  colorRange() {
    if (!doc()) return;
    const composite = renderDocument();
    if (!composite) return;
    const context = composite.getContext("2d", { willReadFrequently: true });
    const rgba = context.getImageData(0, 0, composite.width, composite.height).data;
    showSheet({
      title: "Color Range",
      fields: [
        { key: "color", label: "Sample color", type: "color", value: "#000000" },
        { key: "fuzziness", label: "Fuzziness", type: "number", value: 40, min: 0, max: 255 },
        { key: "invert", label: "Invert", type: "checkbox", value: false },
      ],
      okText: "Select",
      onConfirm: ({ color, fuzziness, invert }) => {
        const m = manifest();
        const rgb = hexToRgb(color) || { red: 0, green: 0, blue: 0 };
        const mask = colorRangeMask(rgba, m.width, m.height,
          [[Math.round(rgb.red * 255), Math.round(rgb.green * 255), Math.round(rgb.blue * 255)]],
          [], clampNumber(fuzziness, 0, 255, 40), !!invert);
        setSelection(mask, "Color Range");
      },
    });
  },

  // Loads the active layer's alpha as the selection (⌘-click the layer thumbnail).
  loadLayerSelection() {
    const layer = doc() && layerById(session.activeLayerId);
    const image = layer && !layer.isGroup ? session.doc.images.get(layer.imageFile) : null;
    if (!image) {
      if (session.setStatus) session.setStatus("Select a pixel layer first.", true);
      return;
    }
    const m = manifest();
    const placed = document.createElement("canvas");
    placed.width = m.width;
    placed.height = m.height;
    const context = placed.getContext("2d", { willReadFrequently: true });
    drawTransformed(context, layer.transform, image);
    const data = context.getImageData(0, 0, m.width, m.height).data;
    const mask = new Uint8Array(m.width * m.height);
    for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3];
    setSelection(mask, "Load Layer Selection");
  },

  // Loads the active layer's raster mask luminance as the selection.
  loadMaskSelection() {
    const layer = doc() && layerById(session.activeLayerId);
    const maskImage = layer && layer.maskFile ? session.doc.images.get(layer.maskFile) : null;
    if (!maskImage) {
      if (session.setStatus) session.setStatus("The active layer has no mask.", true);
      return;
    }
    const m = manifest();
    const placed = document.createElement("canvas");
    placed.width = m.width;
    placed.height = m.height;
    const context = placed.getContext("2d", { willReadFrequently: true });
    drawTransformed(context, layer.maskPlacement || layer.transform, maskImage);
    const data = context.getImageData(0, 0, m.width, m.height).data;
    const mask = new Uint8Array(m.width * m.height);
    for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4]; // grayscale coverage
    setSelection(mask, "Load Mask Selection");
  },

  // Select › Subject. The macOS app runs Vision's subject separation; the port
  // approximates it by flood-growing the border's background (transparent or
  // similar-toned pixels) and selecting everything that isn't background.
  selectSubject() {
    if (!doc()) return;
    const composite = renderDocument();
    if (!composite) return;
    const context = composite.getContext("2d", { willReadFrequently: true });
    const rgba = context.getImageData(0, 0, composite.width, composite.height).data;
    const m = manifest();
    const mask = subjectMask(rgba, m.width, m.height, 48);
    const selected = mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    if (!selected) {
      if (session.setStatus) session.setStatus("No subject found.", true);
      return;
    }
    setSelection(mask, "Subject");
    if (session.setStatus) session.setStatus("Selected subject.");
  },

  // ---- Edit menu: clipboard ----

  copy(merged = false) {
    if (!doc()) return;
    let source;
    if (merged) {
      source = renderDocument();
    } else {
      const layer = layerById(session.activeLayerId);
      if (!layer) {
        if (session.setStatus) session.setStatus("Select a layer to copy.", true);
        return;
      }
      source = layer.adjustment ? renderDocument() : rasterizeSubtree(layer);
    }
    if (!source) return;
    session.clipboard = clipToSelection(source);
    if (session.setStatus) session.setStatus(`Copied ${session.clipboard.width}×${session.clipboard.height} px.`);
  },

  copyMerged() {
    this.copy(true);
  },

  cut() {
    if (!doc()) return;
    const layer = pixelLayerOf(session.activeLayerId);
    if (!layer) {
      if (session.setStatus) session.setStatus("Cut needs a pixel layer.", true);
      return;
    }
    beginEdit("Cut");
    this.copy(false);
    if (!clearLayerPixels(layer)) {
      cancelEdit();
      return;
    }
    endEdit();
    markDirty();
  },

  paste() {
    if (!doc()) return;
    if (!session.clipboard) {
      if (session.setStatus) session.setStatus("The clipboard is empty.", true);
      return;
    }
    beginEdit("Paste");
    const file = uniqueAssetName(`pasted-${Date.now()}`);
    session.doc.images.set(file, session.clipboard);
    trackAsset(file);
    const layer = {
      id: uid(),
      name: nextName("Layer"),
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      transform: { origin: { x: 0, y: 0 }, size: { width: session.clipboard.width, height: session.clipboard.height } },
      imageFile: file,
    };
    insertAfterSubtree([layer]);
    endEdit();
    setActiveLayer(layer.id);
    markDirty();
  },

  // Duplicate the active layer's visible content, clipped to the selection, on a
  // new layer right above.
  layerViaCopy() {
    if (!doc()) return;
    const layer = layerById(session.activeLayerId);
    if (!layer || layer.isGroup || layer.adjustment) {
      if (session.setStatus) session.setStatus("Layer via Copy needs a pixel layer.", true);
      return;
    }
    const content = clipToSelection(rasterizeSubtree(layer));
    beginEdit("Layer via Copy");
    const file = uniqueAssetName(`via-copy-${Date.now()}`);
    session.doc.images.set(file, content);
    trackAsset(file);
    const copy = {
      id: uid(),
      name: nextName("Layer"),
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      transform: { origin: { x: 0, y: 0 }, size: { width: content.width, height: content.height } },
      imageFile: file,
    };
    insertAfterSubtree([copy]);
    endEdit();
    setActiveLayer(copy.id);
    markDirty();
  },

  fillSelection(kind) {
    console.log("DBG fillSelection", kind, "active:", session.activeLayerId);
    if (!doc()) return;
    const layer = pixelLayerOf(session.activeLayerId);
    console.log("DBG fill layer:", layer && layer.name, "sel:", !!session.selection);
    if (!layer) {
      if (session.setStatus) session.setStatus("Fill needs a pixel layer.", true);
      return;
    }
    const color = kind === "Background" ? session.backgroundColor : session.foregroundColor;
    beginEdit(kind === "Background" ? "Fill Background" : "Fill Foreground");
    if (!fillLayerPixels(layer, color)) cancelEdit();
    else { endEdit(); markDirty(); }
  },

  clearSelectedPixels() {
    if (!doc()) return;
    const layer = pixelLayerOf(session.activeLayerId);
    if (!layer) {
      if (session.setStatus) session.setStatus("Clear needs a pixel layer.", true);
      return;
    }
    beginEdit("Clear");
    if (!clearLayerPixels(layer)) cancelEdit();
    else { endEdit(); markDirty(); }
  },

  // Content-Aware Fill over the selection, via the HealPixels.c membrane solve.
  contentAwareFill() {
    if (!doc()) return;
    const layer = pixelLayerOf(session.activeLayerId);
    if (!layer) {
      if (session.setStatus) session.setStatus("Content-Aware Fill needs a pixel layer.", true);
      return;
    }
    if (!session.selection) {
      if (session.setStatus) session.setStatus("Make a selection first.", true);
      return;
    }
    beginEdit("Content-Aware Fill");
    let done = false;
    withLayerPixels(layer, (before) => {
      const coverage = coverageFor(layer);
      if (!coverage) return null;
      const out = document.createElement("canvas");
      out.width = before.width;
      out.height = before.height;
      const context = out.getContext("2d", { willReadFrequently: true });
      context.drawImage(before, 0, 0);
      const image = context.getImageData(0, 0, before.width, before.height);
      spotHeal(image.data, coverage, before.width, before.height, 1, 0, (Math.random() * 0x100000000) >>> 0);
      context.putImageData(image, 0, 0);
      done = true;
      return out;
    });
    if (!done) cancelEdit();
    else { endEdit(); markDirty(); }
  },

  // ---- Image menu: canvas geometry ----

  rotateCanvas(degrees) {
    if (!doc()) return;
    const mode = degrees === 90 ? "cw" : degrees === -90 ? "ccw" : "half";
    remapWholeCanvas(mode, degrees === 180 ? "Rotate Canvas 180°" : `Rotate Canvas ${degrees}°`);
  },

  flipCanvas(direction) {
    if (!doc()) return;
    remapWholeCanvas(direction === "Vertical" ? "flipV" : "flipH", `Flip Canvas ${direction}`);
  },

  flipLayer(direction) {
    if (!doc()) return;
    const layer = layerById(session.activeLayerId);
    if (!layer) return;
    beginEdit(`Flip Layer ${direction}`);
    if (direction === "Vertical") layer.flipY = !layer.flipY;
    else layer.flipX = !layer.flipX;
    layer.rotation = -(layer.rotation || 0);
    endEdit();
    markDirty();
  },

  rotateLayer(degrees) {
    if (!doc()) return;
    const layer = layerById(session.activeLayerId);
    if (!layer) return;
    beginEdit("Rotate Layer");
    layer.rotation = (layer.rotation || 0) + degrees;
    endEdit();
    markDirty();
  },

  canvasSize() {
    if (!doc()) return;
    const m = manifest();
    showSheet({
      title: "Canvas Size",
      fields: [
        { key: "width", label: "Width (px)", type: "number", value: m.width, min: 1, max: 30000 },
        { key: "height", label: "Height (px)", type: "number", value: m.height, min: 1, max: 30000 },
        {
          key: "anchor", label: "Anchor", type: "select",
          options: ["Center", "Top Left", "Top", "Top Right", "Left", "Right", "Bottom Left", "Bottom", "Bottom Right"],
          value: "Center",
        },
        {
          key: "fill", label: "Fill", type: "select",
          options: ["Transparent", "Background", "Foreground", "White", "Black"],
          value: "Transparent",
        },
      ],
      okText: "Resize",
      onConfirm: ({ width, height, anchor, fill }) => {
        const m = manifest();
        width = clampNumber(width, 1, 30000, m.width);
        height = clampNumber(height, 1, 30000, m.height);
        beginEdit("Canvas Size");
        const ax = anchor.includes("Left") ? 0 : anchor.includes("Right") ? 1 : 0.5;
        const ay = anchor.includes("Top") ? 0 : anchor.includes("Bottom") ? 1 : 0.5;
        const dx = Math.round((width - m.width) * ax);
        const dy = Math.round((height - m.height) * ay);
        for (const layer of m.layers) {
          layer.transform.origin.x += dx;
          layer.transform.origin.y += dy;
          if (layer.maskPlacement) {
            layer.maskPlacement.origin.x += dx;
            layer.maskPlacement.origin.y += dy;
          }
        }
        if (Array.isArray(m.guides)) {
          for (const guide of m.guides) guide.position += guide.axis === "horizontal" ? dy : dx;
        }
        m.width = width;
        m.height = height;
        if (fill !== "Transparent") {
          const color = fill === "Background" ? session.backgroundColor
            : fill === "Foreground" ? session.foregroundColor
            : fill === "White" ? { red: 1, green: 1, blue: 1 }
            : { red: 0, green: 0, blue: 0 };
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`;
          context.fillRect(0, 0, width, height);
          const file = uniqueAssetName(`canvas-fill-${Date.now()}`);
          session.doc.images.set(file, canvas);
          trackAsset(file);
          m.layers.unshift({
            id: uid(),
            name: "Background",
            isVisible: true,
            opacity: 1,
            blendMode: "Normal",
            transform: { origin: { x: 0, y: 0 }, size: { width, height } },
            imageFile: file,
          });
        }
        session.selection = null;
        endEdit();
        markDirty();
      },
    });
  },

  // Image Size: scales every placement, guide, the resolution and the assets.
  imageSize() {
    if (!doc()) return;
    const m = manifest();
    showSheet({
      title: "Image Size",
      fields: [
        { key: "width", label: "Width (px)", type: "number", value: m.width, min: 1, max: 30000 },
        { key: "height", label: "Height (px)", type: "number", value: m.height, min: 1, max: 30000 },
      ],
      okText: "Resample",
      onConfirm: ({ width, height }) => {
        const m = manifest();
        width = clampNumber(width, 1, 30000, m.width);
        height = clampNumber(height, 1, 30000, m.height);
        if (width === m.width && height === m.height) return;
        beginEdit("Image Size");
        const sx = width / m.width, sy = height / m.height;
        for (const layer of m.layers) {
          layer.transform.origin.x *= sx;
          layer.transform.origin.y *= sy;
          layer.transform.size.width *= sx;
          layer.transform.size.height *= sy;
          if (layer.maskPlacement) {
            layer.maskPlacement.origin.x *= sx;
            layer.maskPlacement.origin.y *= sy;
            layer.maskPlacement.size.width *= sx;
            layer.maskPlacement.size.height *= sy;
          }
        }
        if (Array.isArray(m.guides)) {
          for (const guide of m.guides) guide.position *= guide.axis === "horizontal" ? sy : sx;
        }
        m.resolution = Math.max(1, Math.round((m.resolution || 72) * ((sx + sy) / 2)));
        m.width = width;
        m.height = height;
        const files = new Set();
        for (const layer of m.layers) {
          if (layer.imageFile) files.add(layer.imageFile);
          if (layer.maskFile) files.add(layer.maskFile);
        }
        for (const file of files) {
          const image = session.doc.images.get(file);
          if (!image) continue;
          const source = canvasOf(image);
          const next = document.createElement("canvas");
          next.width = Math.max(1, Math.round(source.width * sx));
          next.height = Math.max(1, Math.round(source.height * sy));
          const context = next.getContext("2d");
          context.imageSmoothingEnabled = true;
          context.drawImage(source, 0, 0, next.width, next.height);
          replaceAsset(file, next);
        }
        session.selection = null;
        endEdit();
        markDirty();
      },
    });
  },

  // Trim: crop the canvas to the composite's opaque bounds.
  trim() {
    if (!doc()) return;
    const composite = renderDocument();
    if (!composite) return;
    const context = composite.getContext("2d", { willReadFrequently: true });
    const { data } = context.getImageData(0, 0, composite.width, composite.height);
    const width = composite.width;
    let minX = width, minY = composite.height, maxX = -1, maxY = -1;
    for (let y = 0; y < composite.height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!data[(y * width + x) * 4 + 3]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      if (session.setStatus) session.setStatus("Nothing to trim — the canvas is empty.", true);
      return;
    }
    const m = manifest();
    beginEdit("Trim");
    m.width = maxX - minX + 1;
    m.height = maxY - minY + 1;
    for (const layer of m.layers) {
      layer.transform.origin.x -= minX;
      layer.transform.origin.y -= minY;
      if (layer.maskPlacement) {
        layer.maskPlacement.origin.x -= minX;
        layer.maskPlacement.origin.y -= minY;
      }
    }
    if (Array.isArray(m.guides)) {
      for (const guide of m.guides) guide.position -= guide.axis === "horizontal" ? minY : minX;
    }
    session.selection = null;
    endEdit();
    markDirty();
    if (session.setStatus) session.setStatus(`Trimmed to ${m.width}×${m.height} px.`);
  },

  // ---- Layer menu ----

  groupSelection() {
    if (!doc()) return;
    const active = layerById(session.activeLayerId);
    if (!active) return;
    beginEdit("Group Layers");
    const group = {
      id: uid(),
      name: nextName("Group"),
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      isGroup: true,
      parentID: active.parentID,
    };
    const layers = manifest().layers;
    layers.splice(layers.indexOf(active), 0, group);
    active.parentID = group.id;
    if (manifest().version < 2) manifest().version = 2;
    endEdit();
    setActiveLayer(group.id);
    markDirty();
  },

  ungroup() {
    if (!doc()) return;
    const group = layerById(session.activeLayerId);
    if (!group || !group.isGroup) {
      if (session.setStatus) session.setStatus("Select a group to ungroup.", true);
      return;
    }
    const layers = manifest().layers;
    const kids = layers.filter((layer) => layer.parentID === group.id);
    beginEdit("Ungroup");
    // Flat model: the kids stay in the array where they are (directly under the
    // group); ungrouping only removes the group and detaches them.
    layers.splice(layers.indexOf(group), 1);
    for (const kid of kids) kid.parentID = group.parentID;
    endEdit();
    setActiveLayer(kids.length ? kids[0].id : null);
    markDirty();
  },

  moveLayerOut() {
    if (!doc()) return;
    const active = layerById(session.activeLayerId);
    if (!active) return;
    const parent = active.parentID ? layerById(active.parentID) : null;
    if (!parent) {
      if (session.setStatus) session.setStatus("The active layer is not inside a group.", true);
      return;
    }
    beginEdit("Move Out");
    const layers = manifest().layers;
    const index = layers.indexOf(active);
    const end = subtreeEnd(index);
    const block = layers.splice(index, end - index + 1);
    active.parentID = parent.parentID;
    const parentIndex = layers.indexOf(parent);
    const parentEnd = subtreeEnd(parentIndex);
    layers.splice(parentEnd + 1, 0, ...block);
    endEdit();
    markDirty();
  },

  moveLayerUp() {
    const layers = doc() && manifest().layers;
    const active = layerById(session.activeLayerId);
    if (!layers || !active) return;
    session.panel?.moveLayer(layers.indexOf(active), -1);
  },

  moveLayerDown() {
    const layers = doc() && manifest().layers;
    const active = layerById(session.activeLayerId);
    if (!layers || !active) return;
    session.panel?.moveLayer(layers.indexOf(active), 1);
  },

  renameLayer() {
    const layer = doc() && layerById(session.activeLayerId);
    if (!layer) return;
    showSheet({
      title: "Rename Layer",
      fields: [{ key: "name", label: "Name", value: layer.name || "" }],
      okText: "Rename",
      onConfirm: ({ name }) => {
        const layer = layerById(session.activeLayerId);
        if (!layer) return;
        beginEdit("Rename Layer");
        layer.name = String(name || "").trim() || "Layer";
        endEdit();
        markDirty();
      },
    });
  },

  toggleVisibility() {
    const layer = doc() && layerById(session.activeLayerId);
    if (!layer) return;
    beginEdit("Toggle Visibility");
    layer.isVisible = layer.isVisible === false;
    endEdit();
    markDirty();
  },

  toggleMaskEnabled() {
    const layer = doc() && layerById(session.activeLayerId);
    if (!layer || !layer.maskFile) {
      if (session.setStatus) session.setStatus("The active layer has no mask.", true);
      return;
    }
    beginEdit("Toggle Mask");
    layer.maskEnabled = layer.maskEnabled === false;
    endEdit();
    markDirty();
  },

  // Clipping mask: clip the active layer to the first eligible layer below.
  toggleClippingMask() {
    if (!doc()) return;
    const layer = layerById(session.activeLayerId);
    if (!layer) return;
    beginEdit("Toggle Clipping Mask");
    if (layer.maskSourceID) {
      layer.maskSourceID = undefined;
    } else {
      const layers = manifest().layers;
      const index = layers.indexOf(layer);
      let base = null;
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = layers[i];
        if (candidate.isGroup || candidate.adjustment) break;
        if (candidate.parentID !== layer.parentID) break;
        if (candidate.maskSourceID) continue; // already clipping; the base is below
        base = candidate;
        break;
      }
      if (!base) {
        cancelEdit();
        if (session.setStatus) session.setStatus("No layer below to clip to.", true);
        return;
      }
      layer.maskSourceID = base.id;
      if (manifest().version < 5) manifest().version = 5;
    }
    endEdit();
    markDirty();
  },

  // ---- Adjustments ----

  newAdjustmentLayer(kind) {
    if (!doc() || !ADJUSTMENT_KINDS.includes(kind)) return;
    beginEdit("New Adjustment Layer");
    const m = manifest();
    if (V9_ADJUSTMENTS.has(kind) && m.version < 9) m.version = 9;
    else if (m.version < 7) m.version = 7;
    const layer = {
      id: uid(),
      name: kind,
      isVisible: true,
      opacity: 1,
      blendMode: "Normal",
      adjustment: { kind },
    };
    insertAfterSubtree([layer]);
    endEdit();
    setActiveLayer(layer.id);
    markDirty();
  },

  newAdjustmentLayerSheet() {
    if (!doc()) return;
    showSheet({
      title: "New Adjustment Layer",
      fields: [{ key: "kind", label: "Kind", type: "select", options: ADJUSTMENT_KINDS, value: ADJUSTMENT_KINDS[0] }],
      okText: "Create",
      onConfirm: ({ kind }) => this.newAdjustmentLayer(kind),
    });
  },

  editAdjustment() {
    const layer = doc() && layerById(session.activeLayerId);
    if (!layer || !layer.adjustment) {
      if (session.setStatus) session.setStatus("Select an adjustment layer to edit.", true);
      return;
    }
    const builder = ADJUSTMENT_SHEET_FIELDS[layer.adjustment.kind];
    if (!builder) return;
    showSheet({
      title: `${layer.adjustment.kind} Adjustment`,
      fields: builder(layer.adjustment),
      okText: "Apply",
      onConfirm: (values) => {
        const layer = layerById(session.activeLayerId);
        if (!layer || !layer.adjustment) return;
        beginEdit("Edit Adjustment");
        const kind = layer.adjustment.kind;
        if (kind === "Levels") {
          const base = layer.adjustment.levels
            ? JSON.parse(JSON.stringify(layer.adjustment.levels))
            : { channel: "RGB", ranges: [null, null, null, null].map(() => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })) };
          base.ranges[0] = {
            black: clampNumber(values.black, 0, 254, 0), gamma: Number(values.gamma) || 1,
            white: clampNumber(values.white, 1, 255, 255),
            outputBlack: clampNumber(values.outputBlack, 0, 255, 0), outputWhite: clampNumber(values.outputWhite, 0, 255, 255),
          };
          layer.adjustment.levels = base;
        } else if (kind === "Curves") {
          const base = layer.adjustment.curves
            ? JSON.parse(JSON.stringify(layer.adjustment.curves))
            : { channel: "RGB", channels: [null, null, null, null].map(() => [{ x: 0, y: 0 }, { x: 255, y: 255 }]) };
          const channel = base.channels[0];
          const points = [];
          for (let i = 0; i < channel.length; i += 1) {
            points.push({ x: clampNumber(values[`px${i}`], 0, 255, channel[i].x), y: clampNumber(values[`py${i}`], 0, 255, channel[i].y) });
          }
          points.sort((a, b) => a.x - b.x);
          base.channels[0] = points;
          layer.adjustment.curves = base;
        } else if (kind === "Exposure") {
          layer.adjustment.exposureSettings = {
            exposure: Number(values.exposure) || 0,
            offset: Number(values.offset) || 0,
            gamma: Number(values.gamma) || 1,
          };
        } else if (kind === "Gradient Map") {
          const base = layer.adjustment.gradientMapSettings
            ? JSON.parse(JSON.stringify(layer.adjustment.gradientMapSettings))
            : { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false };
          base.reversed = !!values.reversed;
          layer.adjustment.gradientMapSettings = base;
        } else if (kind === "Grain") {
          const base = layer.adjustment.grainSettings
            ? JSON.parse(JSON.stringify(layer.adjustment.grainSettings))
            : { amount: 25, size: 1.5, roughness: 50, seed: 0 };
          base.amount = clampNumber(values.grainAmount, 0, 100, 25);
          base.size = Number(values.grainSize) || 1.5;
          base.roughness = clampNumber(values.grainRoughness, 0, 100, 50);
          layer.adjustment.grainSettings = base;
        } else if (kind === "Black & White") {
          layer.adjustment.blackWhiteSettings = {
            reds: Number(values.reds) || 0, yellows: Number(values.yellows) || 0,
            greens: Number(values.greens) || 0, cyans: Number(values.cyans) || 0,
            blues: Number(values.blues) || 0, magentas: Number(values.magentas) || 0,
            tint: layer.adjustment.blackWhiteSettings?.tint ?? false,
            tintHue: layer.adjustment.blackWhiteSettings?.tintHue ?? 40,
            tintSaturation: layer.adjustment.blackWhiteSettings?.tintSaturation ?? 20,
          };
        } else if (kind === "Color Balance") {
          layer.adjustment.colorBalanceSettings = {
            shadowCyanRed: Number(values.shadowCyanRed) || 0,
            shadowMagentaGreen: Number(values.shadowMagentaGreen) || 0,
            shadowYellowBlue: Number(values.shadowYellowBlue) || 0,
            midCyanRed: Number(values.midCyanRed) || 0,
            midMagentaGreen: Number(values.midMagentaGreen) || 0,
            midYellowBlue: Number(values.midYellowBlue) || 0,
            highlightCyanRed: Number(values.highlightCyanRed) || 0,
            highlightMagentaGreen: Number(values.highlightMagentaGreen) || 0,
            highlightYellowBlue: Number(values.highlightYellowBlue) || 0,
            preserveLuminosity: layer.adjustment.colorBalanceSettings?.preserveLuminosity ?? true,
          };
        } else if (kind === "Hue/Saturation") {
          layer.adjustment.hue = Number(values.hue) || 0;
          layer.adjustment.saturation = Number(values.saturation) || 0;
          layer.adjustment.lightness = Number(values.lightness) || 0;
        } else {
          layer.adjustment.blurRadius = Number(values.blurRadius ?? layer.adjustment.blurRadius) || 0;
          layer.adjustment.motionAngle = Number(values.motionAngle ?? layer.adjustment.motionAngle) || 0;
          layer.adjustment.motionDistance = Number(values.motionDistance ?? layer.adjustment.motionDistance) || 0;
          layer.adjustment.noiseAmount = Number(values.noiseAmount ?? layer.adjustment.noiseAmount) || 0;
          if (values.noiseGaussian !== undefined) layer.adjustment.noiseGaussian = !!values.noiseGaussian;
          if (values.noiseMonochromatic !== undefined) layer.adjustment.noiseMonochromatic = !!values.noiseMonochromatic;
        }
        endEdit();
        markDirty();
      },
    });
  },

  // ---- Filters ----

  applyFilter(kind) {
    if (!doc() || !FILTER_KINDS.includes(kind)) return;
    const layer = pixelLayerOf(session.activeLayerId);
    if (!layer) {
      if (session.setStatus) session.setStatus("Filters need a pixel layer.", true);
      return;
    }
    showSheet({
      title: kind,
      fields: FILTER_SHEET_FIELDS[kind] || [],
      okText: "Apply",
      onConfirm: (values) => {
        const layer = pixelLayerOf(session.activeLayerId);
        if (!layer) return;
        beginEdit(kind);
        try {
          const next = runFilter(kind, layer, values);
          if (!next) {
            cancelEdit();
            return;
          }
          replaceAsset(layer.imageFile, next);
          endEdit();
          markDirty();
        } catch (error) {
          cancelEdit();
          if (session.setStatus) session.setStatus(String(error), true);
        }
      },
    });
  },

  applyFilterSheet() {
    if (!doc()) return;
    showSheet({
      title: "Filter",
      fields: [{ key: "kind", label: "Filter", type: "select", options: FILTER_KINDS, value: FILTER_KINDS[0] }],
      okText: "Next",
      onConfirm: ({ kind }) => this.applyFilter(kind),
    });
  },

  // ---- Image > direct pixel adjustments (the macOS Image menu applies to pixels) ----

  // Builds a fresh adjustment object from the sheet's flat values (same mapping
  // the adjustment-layer editor writes back, without preserving prior settings).
  buildAdjustment(kind, values) {
    const adjustment = { kind };
    if (kind === "Levels") {
      adjustment.levels = {
        channel: "RGB",
        ranges: [null, null, null, null].map(() => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })),
      };
      adjustment.levels.ranges[0] = {
        black: clampNumber(values.black, 0, 254, 0), gamma: Number(values.gamma) || 1,
        white: clampNumber(values.white, 1, 255, 255),
        outputBlack: clampNumber(values.outputBlack, 0, 255, 0), outputWhite: clampNumber(values.outputWhite, 0, 255, 255),
      };
    } else if (kind === "Curves") {
      const base = { channel: "RGB", channels: [null, null, null, null].map(() => [{ x: 0, y: 0 }, { x: 255, y: 255 }]) };
      const points = [];
      const channel = base.channels[0];
      for (let i = 0; i < channel.length; i += 1) {
        const x = values[`px${i}`];
        const y = values[`py${i}`];
        if (x === undefined || y === undefined) continue;
        points.push({ x: clampNumber(x, 0, 255, channel[i].x), y: clampNumber(y, 0, 255, channel[i].y) });
      }
      points.sort((a, b) => a.x - b.x);
      base.channels[0] = points;
      adjustment.curves = base;
    } else if (kind === "Exposure") {
      adjustment.exposureSettings = { exposure: Number(values.exposure) || 0, offset: Number(values.offset) || 0, gamma: Number(values.gamma) || 1 };
    } else if (kind === "Gradient Map") {
      adjustment.gradientMapSettings = {
        shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: !!values.reversed,
      };
    } else if (kind === "Grain") {
      adjustment.grainSettings = {
        amount: clampNumber(values.grainAmount, 0, 100, 25), size: Number(values.grainSize) || 1.5,
        roughness: clampNumber(values.grainRoughness, 0, 100, 50), seed: 0,
      };
    } else if (kind === "Black & White") {
      adjustment.blackWhiteSettings = {
        reds: Number(values.reds) || 0, yellows: Number(values.yellows) || 0,
        greens: Number(values.greens) || 0, cyans: Number(values.cyans) || 0,
        blues: Number(values.blues) || 0, magentas: Number(values.magentas) || 0,
        tint: false, tintHue: 40, tintSaturation: 20,
      };
    } else if (kind === "Color Balance") {
      adjustment.colorBalanceSettings = {
        shadowCyanRed: Number(values.shadowCyanRed) || 0, shadowMagentaGreen: Number(values.shadowMagentaGreen) || 0,
        shadowYellowBlue: Number(values.shadowYellowBlue) || 0,
        midCyanRed: Number(values.midCyanRed) || 0, midMagentaGreen: Number(values.midMagentaGreen) || 0,
        midYellowBlue: Number(values.midYellowBlue) || 0,
        highlightCyanRed: Number(values.highlightCyanRed) || 0, highlightMagentaGreen: Number(values.highlightMagentaGreen) || 0,
        highlightYellowBlue: Number(values.highlightYellowBlue) || 0,
        preserveLuminosity: true,
      };
    } else if (kind === "Hue/Saturation") {
      adjustment.hue = Number(values.hue) || 0;
      adjustment.saturation = Number(values.saturation) || 0;
      adjustment.lightness = Number(values.lightness) || 0;
    } else {
      // The blur/noise trio keeps flat keys; resolved() fills whatever is missing.
      if (values.blurRadius !== undefined) adjustment.blurRadius = Number(values.blurRadius) || 0;
      if (values.motionAngle !== undefined) adjustment.motionAngle = Number(values.motionAngle) || 0;
      if (values.motionDistance !== undefined) adjustment.motionDistance = Number(values.motionDistance) || 0;
      if (values.noiseAmount !== undefined) adjustment.noiseAmount = Number(values.noiseAmount) || 0;
      if (values.noiseGaussian !== undefined) adjustment.noiseGaussian = !!values.noiseGaussian;
      if (values.noiseMonochromatic !== undefined) adjustment.noiseMonochromatic = !!values.noiseMonochromatic;
    }
    return adjustment;
  },

  // The Image menu's adjustment commands (Curves…, Levels…, …): one sheet, then
  // the adjustment kernels run over the active layer's pixels, selection-aware.
  beginAdjustment(kind) {
    if (!doc() || !ADJUSTMENT_KINDS.includes(kind)) return;
    if (!pixelLayerOf(session.activeLayerId)) {
      if (session.setStatus) session.setStatus("Adjustments need a pixel layer.", true);
      return;
    }
    const builder = ADJUSTMENT_SHEET_FIELDS[kind];
    if (!builder) return;
    showSheet({
      title: kind,
      fields: builder({ kind }),
      okText: "Apply",
      onConfirm: (values) => {
        const layer = pixelLayerOf(session.activeLayerId);
        if (!layer) return;
        beginEdit(kind);
        try {
          const file = layer.imageFile;
          const before = canvasOf(session.doc.images.get(file));
          const context = before.getContext("2d", { willReadFrequently: true });
          const image = context.getImageData(0, 0, before.width, before.height);
          const original = new Uint8ClampedArray(image.data);
          applyAdjustment(image, this.buildAdjustment(kind, values));
          // Only selected pixels change, mixed per pixel like the filters.
          const coverage = coverageFor(layer);
          if (coverage) {
            for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
              const amount = coverage[p];
              if (amount >= 1) continue;
              for (let c = 0; c < 4; c += 1) {
                image.data[i + c] = Math.round(original[i + c] + (image.data[i + c] - original[i + c]) * amount);
              }
            }
          }
          context.putImageData(image, 0, 0);
          endEdit();
          markDirty();
        } catch (error) {
          cancelEdit();
          if (session.setStatus) session.setStatus(String(error), true);
        }
      },
    });
  },

  // Image > Invert: no sheet, straight pixel inversion over the selection.
  invertPixels() {
    const layer = pixelLayerOf(session.activeLayerId);
    if (!doc() || !layer) {
      if (session.setStatus) session.setStatus("Invert needs a pixel layer.", true);
      return;
    }
    beginEdit("Invert");
    try {
      const file = layer.imageFile;
      const before = canvasOf(session.doc.images.get(file));
      const context = before.getContext("2d", { willReadFrequently: true });
      const image = context.getImageData(0, 0, before.width, before.height);
      const original = new Uint8ClampedArray(image.data);
      applyInvert(image);
      const coverage = coverageFor(layer);
      if (coverage) {
        for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
          const amount = coverage[p];
          if (amount >= 1) continue;
          for (let c = 0; c < 4; c += 1) {
            image.data[i + c] = Math.round(original[i + c] + (image.data[i + c] - original[i + c]) * amount);
          }
        }
      }
      context.putImageData(image, 0, 0);
      replaceAsset(file, before);
      endEdit();
      markDirty();
    } catch (error) {
      cancelEdit();
      if (session.setStatus) session.setStatus(String(error), true);
    }
  },

  // ---- View / export helpers ----

  gridSettings() {
    showSheet({
      title: "Grid Settings",
      fields: [{ key: "size", label: "Grid size (px)", type: "number", value: session.gridSize || 50, min: 2, max: 1000 }],
      okText: "Apply",
      onConfirm: ({ size }) => {
        session.gridSize = clampNumber(size, 2, 1000, 50);
        session.showGrid = true;
        emit("document");
      },
    });
  },

  // View › Clear Guides: drops every guide in one undo step (session.clearGuides).
  clearGuides() {
    if (!doc()) return;
    const m = manifest();
    if (!Array.isArray(m.guides) || m.guides.length === 0) {
      if (session.setStatus) session.setStatus("No guides to clear.");
      return;
    }
    beginEdit("Clear Guides");
    try {
      m.guides = [];
    } finally {
      endEdit();
      markDirty();
      emit("document");
    }
    if (session.setStatus) session.setStatus("Cleared guides.");
  },

  exportJpegSheet() {
    if (!doc()) return;
    showSheet({
      title: "Export JPEG",
      fields: [{ key: "quality", label: "Quality (1–100)", type: "number", value: 90, min: 1, max: 100 }],
      okText: "Export",
      onConfirm: ({ quality }) => {
        session.app?.exportImage("jpeg", Math.min(1, Math.max(0.01, (Number(quality) || 90) / 100)));
      },
    });
  },

  closeProject() {
    if (!doc()) return;
    session.doc = null;
    session.history = [];
    session.historyIndex = -1;
    session.selection = null;
    session.activeLayerId = null;
    session.selectedLayerIds = new Set();
    emit("history");
    emit("document");
    if (session.setStatus) session.setStatus("Closed project.");
  },
};
