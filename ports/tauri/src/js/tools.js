// The tool system: the tool strip, per-tool option panels and the canvas pointer
// engine. Tool semantics follow the macOS app: move drags the active layer's
// transform, the brush paints soft dabs through stroke-capped opacity clipped to
// the selection, the marquee/lasso/wand build document-space selections, the clone
// stamp samples This Layer or the composite, spot healing runs HealPixels.c's
// membrane solve, and the blur tool's Liquify/Smudge modes run a WarpStroke port.
// Crop stages a frame with handles and commits on Enter (CanvasResizer semantics).

import {
  session, doc, manifest, activeLayer, setActiveLayer, markDirty,
  beginEdit, endEdit, cancelEdit, replaceAsset, on, emit, renderDocument,
} from "./state.js";
import { TOOLS, RANGES } from "./format.js";
import { canvasOf, trackAsset } from "./io.js";
import {
  rasterizeShapes, combineMasks, makeSelection, selectionIsEmpty, selectionClip,
  wandMask, translateMask, installSelectionState,
} from "./selection.js";
import { spotHeal } from "./heal.js";

const TOOL_LABELS = {
  move: "Move (V)", marquee: "Marquee (M)", lasso: "Lasso (L)", wand: "Magic Wand (W)",
  crop: "Crop (C)", brush: "Brush (B)", spotHealing: "Spot Healing (J)", cloneStamp: "Clone Stamp (S)",
  blur: "Blur (R)", gradient: "Gradient (G)", shape: "Shape (U)", type: "Type (T)",
  eyedropper: "Eyedropper (I)", hand: "Hand (H)", zoom: "Zoom (Z)",
};

const HEAL_MODES = ["Content-Aware", "Very Smooth", "Proximity Match"];
const CROP_RATIOS = ["Free", "Original", "1:1", "4:3", "3:4", "16:9", "9:16"];
const CROP_HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

let els = null;
let stroke = null; // active pointer stroke state
let lassoDraft = null; // polygonal lasso in progress

export function installTools(sessionRef, elements) {
  els = elements;
  installSelectionState(() => session.selection);
  installTextRasterizer();
  installShapeRasterizer();
  buildToolStrip();
  renderToolOptions();
  installCanvasPointer();
  installOverlayKeys();
  on("tool", () => { lassoDraft = null; renderToolOptions(); renderOverlay(); });
  on("document", () => { applyZoom(); renderOverlay(); });
  on("history", () => renderOverlay());
}

// ---- Live rasters ----

// Text layers without a cached PNG rasterize from their metadata. Runs (v10/v11)
// override color/font for their ranges; box text (v4+) wraps inside its box.
function installTextRasterizer() {
  session.rasterizers.text = (layer) => {
    const style = layer.text;
    if (!style || !layer.transform) return null;
    const width = Math.max(1, Math.round(layer.transform.size.width));
    const height = Math.max(1, Math.round(layer.transform.size.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const fontSize = style.fontSize;
    const lineHeight = style.leading > 0 ? style.leading : Math.round(fontSize * 1.2);
    const trackingPx = (style.tracking / 1000) * fontSize;
    if ("letterSpacing" in context) context.letterSpacing = `${trackingPx}px`;
    context.textBaseline = "alphabetic";
    const lines = String(style.content).split("\n");
    const align = style.alignment || "Left";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const runs = runsForLine(style, line);
      const widths = runs.map((run) => context.measureText(run.text).width);
      const total = widths.reduce((sum, value) => sum + value, 0);
      let x = align === "Center" ? (width - total) / 2 : align === "Right" ? width - total : 0;
      const y = lineHeight * (i + 0.8);
      context.textAlign = "left";
      for (let r = 0; r < runs.length; r += 1) {
        const run = runs[r];
        context.font = `${fontSize}px ${JSON.stringify(run.fontName || style.fontName || "Helvetica")}`;
        const color = run.color || { red: style.red, green: style.green, blue: style.blue };
        context.fillStyle = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`;
        context.fillText(run.text, x, y);
        x += widths[r];
      }
    }
    return canvas;
  };
}

function runsForLine(style, line) {
  const colorRuns = style.colorRuns || [];
  const fontRuns = style.fontRuns || [];
  const chars = [...line];
  const runs = [];
  let offset = 0; // UTF-16 offset into the full content approximated per line
  for (let i = 0; i < chars.length; ) {
    let color = null;
    let fontName = null;
    for (const run of colorRuns) {
      if (offset >= run.location && offset < run.location + run.length) color = run;
    }
    for (const run of fontRuns) {
      if (offset >= run.location && offset < run.location + run.length) fontName = run.fontName;
    }
    let length = 1;
    while (i + length < chars.length) {
      const nextOffset = offset + [...chars.slice(i, i + length + 1)].join("").length;
      const stillColor = colorRuns.some((run) => nextOffset > run.location && nextOffset < run.location + run.length);
      const stillFont = fontRuns.some((run) => nextOffset > run.location && nextOffset < run.location + run.length);
      if (Boolean(color) !== stillColor || Boolean(fontName) !== stillFont) break;
      length += 1;
    }
    runs.push({ text: chars.slice(i, i + length).join(""), color, fontName });
    offset += chars.slice(i, i + length).join("").length;
    i += length;
  }
  return runs.length ? runs : [{ text: line, color: null, fontName: null }];
}

// Shape layers draw as vector metadata: Rectangle (with corner radius), Ellipse, Line.
function installShapeRasterizer() {
  session.rasterizers.shape = (layer) => {
    const shape = layer.shape;
    if (!shape || !layer.transform) return null;
    const width = Math.max(1, Math.round(layer.transform.size.width));
    const height = Math.max(1, Math.round(layer.transform.size.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const fill = `rgb(${Math.round(shape.red * 255)},${Math.round(shape.green * 255)},${Math.round(shape.blue * 255)})`;
    context.fillStyle = fill;
    context.strokeStyle = fill;
    if (shape.kind === "Rectangle") {
      const radius = Math.min(shape.cornerRadius || 0, width / 2, height / 2);
      context.beginPath();
      if (radius > 0 && "roundRect" in context) {
        context.roundRect(0, 0, width, height, radius);
      } else {
        context.rect(0, 0, width, height);
      }
      context.fill();
    } else if (shape.kind === "Ellipse") {
      context.beginPath();
      context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.fill();
    } else if (shape.kind === "Line") {
      const sx = (shape.start?.x ?? 0) / Math.max(1, layer.transform.size.width) * width;
      const sy = (shape.start?.y ?? 0) / Math.max(1, layer.transform.size.height) * height;
      const ex = (shape.end?.x ?? width) / Math.max(1, layer.transform.size.width) * width;
      const ey = (shape.end?.y ?? height) / Math.max(1, layer.transform.size.height) * height;
      context.lineWidth = shape.lineWidth || 1;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(sx, sy);
      context.lineTo(ex, ey);
      context.stroke();
    }
    return canvas;
  };
}

// ---- Tool strip and options ----

function buildToolStrip() {
  const strip = document.createElement("div");
  strip.id = "toolStrip";
  for (const tool of TOOLS) {
    if (tool === "idle") continue;
    const button = document.createElement("button");
    button.className = "tool-button";
    button.dataset.tool = tool;
    button.textContent = TOOL_LABELS[tool].split(" (")[0];
    button.title = TOOL_LABELS[tool];
    button.addEventListener("click", () => selectTool(tool));
    strip.appendChild(button);
  }
  els.toolOptions.appendChild(strip);
  const panel = document.createElement("div");
  panel.id = "toolPanel";
  els.toolOptions.appendChild(panel);
  selectTool(session.tool);
}

export function selectTool(tool) {
  session.tool = tool;
  emit("tool");
  for (const button of document.querySelectorAll(".tool-button")) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
}

function numberField(label, value, min, max, step, onChange) {
  const row = document.createElement("label");
  row.className = "option-row";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  input.min = min;
  input.max = max;
  input.step = step;
  input.addEventListener("change", () => onChange(Number(input.value)));
  row.append(span, input);
  return row;
}

function colorField(label, color, onChange) {
  const row = document.createElement("label");
  row.className = "option-row";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "color";
  input.value = `#${[color.red, color.green, color.blue]
    .map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
  input.addEventListener("input", () => {
    onChange({
      red: parseInt(input.value.slice(1, 3), 16) / 255,
      green: parseInt(input.value.slice(3, 5), 16) / 255,
      blue: parseInt(input.value.slice(5, 7), 16) / 255,
    });
  });
  row.append(span, input);
  return row;
}

function selectField(label, value, options, onChange) {
  const row = document.createElement("label");
  row.className = "option-row";
  const span = document.createElement("span");
  span.textContent = label;
  const select = document.createElement("select");
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = option;
    select.appendChild(element);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  row.append(span, select);
  return row;
}

function checkboxField(label, checked, onChange) {
  const row = document.createElement("label");
  row.className = "option-row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  row.append(document.createTextNode(label), box);
  return row;
}

function renderToolOptions() {
  const panel = document.getElementById("toolPanel");
  if (!panel) return;
  panel.replaceChildren();
  const add = (...rows) => panel.append(...rows);
  const tool = session.tool;
  if (tool === "brush") {
    addBrushRows(add);
    add(selectField("Paint on", session.maskTarget, ["image", "mask"], (value) => { session.maskTarget = value; }));
    add(checkboxField("Erase", session.brush.erasing, (checked) => { session.brush.erasing = checked; }));
  } else if (tool === "spotHealing") {
    addBrushRows(add);
    add(selectField("Mode", session.healMode, HEAL_MODES, (value) => { session.healMode = value; }));
  } else if (tool === "cloneStamp") {
    add(selectField("Sample", session.clone.sample, ["This Layer", "All Layers"], (value) => { session.clone.sample = value; }));
    add(checkboxField("Aligned", session.clone.aligned, (checked) => { session.clone.aligned = checked; }));
  } else if (tool === "blur") {
    add(selectField("Mode", session.blurMode, ["Liquify", "Blur", "Smudge"], (value) => { session.blurMode = value; renderToolOptions(); }));
    addBrushRows(add);
    if (session.blurMode === "Blur") {
      add(numberField("Radius", session.brush.blurRadius, 1, 250, 1, (value) => { session.brush.blurRadius = value; }));
    }
  } else if (tool === "wand") {
    add(selectField("Mode", session.wand.mode, ["Wand", "Object"], (value) => { session.wand.mode = value; }));
    add(numberField("Tolerance", session.wand.tolerance, RANGES.wand.tolerance[0], RANGES.wand.tolerance[1], 1,
      (value) => { session.wand.tolerance = value; }));
    add(selectField("Sample size", String(session.wand.sampleSize), ["1", "3", "5", "7", "9"],
      (value) => { session.wand.sampleSize = Number(value); }));
    add(checkboxField("Contiguous", session.wand.contiguous, (checked) => { session.wand.contiguous = checked; }));
    add(checkboxField("All layers", session.wand.sampleAllLayers, (checked) => { session.wand.sampleAllLayers = checked; }));
  } else if (tool === "marquee") {
    add(selectField("Shape", session.marqueeKind, ["Rectangle", "Ellipse"], (value) => { session.marqueeKind = value; }));
  } else if (tool === "lasso") {
    add(selectField("Kind", session.lassoKind, ["Freehand", "Polygonal"], (value) => { session.lassoKind = value; }));
  } else if (tool === "crop") {
    add(selectField("Ratio", session.cropRatioChoice, CROP_RATIOS, (value) => {
      session.cropRatioChoice = value;
      changeCropRatio();
      renderOverlay();
    }));
  } else if (tool === "gradient") {
    add(selectField("Shape", session.gradient.shape, ["Linear", "Radial"], (value) => { session.gradient.shape = value; }));
    add(selectField("Style", session.gradient.style, ["Foreground to Background", "Foreground to Transparent"],
      (value) => { session.gradient.style = value; }));
    add(checkboxField("Reversed", session.gradient.reversed, (checked) => { session.gradient.reversed = checked; }));
    add(numberField("Opacity %", session.gradient.opacity * 100, 0, 100, 1,
      (value) => { session.gradient.opacity = Math.max(0, Math.min(1, value / 100)); }));
  } else if (tool === "shape") {
    add(selectField("Kind", session.shape.kind, ["Rectangle", "Ellipse", "Line"], (value) => { session.shape.kind = value; }));
    add(numberField("Corner radius", session.shape.cornerRadius, 0, 2000, 1,
      (value) => { session.shape.cornerRadius = value; }));
    add(numberField("Line width", session.shape.lineWidth, 1, 500, 1,
      (value) => { session.shape.lineWidth = value; }));
  } else if (tool === "type") {
    add(numberField("Font size", session.typeTool?.fontSize ?? 72, 1, 2000, 1,
      (value) => { session.typeTool = { ...session.typeTool, fontSize: value }; }));
    add(colorField("Color", session.foregroundColor, (color) => { session.foregroundColor = color; }));
  } else if (tool === "zoom") {
    const inButton = document.createElement("button");
    inButton.textContent = "Zoom in";
    inButton.addEventListener("click", () => setZoom(session.viewport.zoom * 1.25));
    const outButton = document.createElement("button");
    outButton.textContent = "Zoom out";
    outButton.addEventListener("click", () => setZoom(session.viewport.zoom / 1.25));
    const fitButton = document.createElement("button");
    fitButton.textContent = "Fit";
    fitButton.addEventListener("click", () => fitZoom());
    const row = document.createElement("div");
    row.className = "option-row";
    row.append(inButton, outButton, fitButton);
    add(row);
  }
}

function addBrushRows(add) {
  add(numberField("Size", session.brush.diameter, RANGES.brush.diameter[0], RANGES.brush.diameter[1], 1,
    (value) => { session.brush.diameter = value; }));
  add(numberField("Hardness", session.brush.hardness * 100, 0, 100, 1,
    (value) => { session.brush.hardness = Math.max(0, Math.min(1, value / 100)); }));
  add(numberField("Opacity %", session.brush.opacity * 100, 0, 100, 1,
    (value) => { session.brush.opacity = Math.max(0, Math.min(1, value / 100)); }));
  add(numberField("Smoothing", session.brush.smoothing, RANGES.brush.smoothing[0], RANGES.brush.smoothing[1], 1,
    (value) => { session.brush.smoothing = value; }));
}

// ---- Viewport ----

export function setZoom(zoom) {
  session.viewport.zoom = Math.max(0.01, Math.min(32, zoom));
  applyZoom();
}

export function fitZoom() {
  if (!doc()) return;
  const host = els.canvasHost;
  const m = manifest();
  const zoom = Math.min((host.clientWidth - 32) / m.width, (host.clientHeight - 32) / m.height);
  setZoom(Math.max(0.01, zoom));
}

function applyZoom() {
  if (!doc() || !els.canvas) return;
  const m = manifest();
  els.canvas.style.width = `${Math.round(m.width * session.viewport.zoom)}px`;
  els.canvas.style.height = `${Math.round(m.height * session.viewport.zoom)}px`;
  renderOverlay();
}

// ---- Pointer engine ----

function docPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  const m = manifest();
  return {
    x: ((event.clientX - rect.left) / rect.width) * m.width,
    y: ((event.clientY - rect.top) / rect.height) * m.height,
  };
}

function installCanvasPointer() {
  const canvas = els.canvas;
  canvas.addEventListener("wheel", (event) => {
    if (!doc()) return;
    if (event.ctrlKey || session.tool === "zoom") {
      event.preventDefault();
      setZoom(session.viewport.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (!doc()) return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
    const point = docPoint(event);
    const mod = { shift: event.shiftKey, alt: event.altKey };
    switch (session.tool) {
      case "move": startMove(point); break;
      case "hand":
        stroke = { kind: "hand", clientX: event.clientX, clientY: event.clientY };
        break;
      case "zoom":
        setZoom(session.viewport.zoom * (event.altKey ? 1 / 1.6 : 1.6));
        break;
      case "eyedropper": pickColor(point); break;
      case "brush": startBrush(point); break;
      case "spotHealing": startHealing(point); break;
      case "cloneStamp": startClone(point, mod); break;
      case "blur":
        if (session.blurMode === "Blur") startBrush(point, { blur: true });
        else startWarp(point);
        break;
      case "marquee":
        if (beginSelectionMove(point)) break;
        stroke = { kind: "marquee", anchor: roundPoint(point), mod };
        renderOverlay();
        break;
      case "lasso":
        if (beginSelectionMove(point)) break;
        if (session.lassoKind === "Polygonal") {
          polygonalClick(point, mod);
        } else {
          stroke = { kind: "lasso", points: [point], mod };
          renderOverlay();
        }
        break;
      case "gradient": stroke = { kind: "gradient", start: point }; break;
      case "shape": stroke = { kind: "shape", start: point }; break;
      case "crop": startCropDrag(point, mod); break;
      case "type": placeType(point); break;
      case "wand": runWand(point, mod); break;
      default: break;
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = docPoint(event);
    // Polygonal lasso tracks the cursor without a button held.
    if (lassoDraft) { lassoDraft.cursor = point; renderOverlay(); }
    if (!stroke) return;
    const mod = { shift: event.shiftKey, alt: event.altKey };
    if (stroke.kind === "hand") {
      els.canvasHost.scrollLeft -= event.clientX - stroke.clientX;
      els.canvasHost.scrollTop -= event.clientY - stroke.clientY;
      stroke.clientX = event.clientX;
      stroke.clientY = event.clientY;
    } else if (stroke.kind === "move") {
      moveLayerTo(point);
      emit("document");
    } else if (stroke.kind === "brush") {
      brushTo(point);
    } else if (stroke.kind === "warp") {
      warpTo(point);
    } else if (stroke.kind === "marquee") {
      stroke.current = point;
      stroke.square = mod.shift;
      renderOverlay();
    } else if (stroke.kind === "lasso") {
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 0.25) {
        stroke.points.push(point);
        renderOverlay();
      }
    } else if (stroke.kind === "gradient" || stroke.kind === "shape") {
      stroke.current = point;
      renderOverlay();
    } else if (stroke.kind === "cropDrag") {
      cropDragTo(point, mod);
    } else if (stroke.kind === "moveSelection") {
      moveSelectionTo(point);
    }
  });

  const finish = (event) => {
    if (!stroke) return;
    const current = stroke;
    stroke = null;
    const point = event ? docPoint(event) : null;
    if (current.kind === "marquee") {
      commitMarquee(current, point || current.anchor);
    } else if (current.kind === "lasso") {
      commitFreehand(current.points, current.mod);
    } else if (current.kind === "cropDrag") {
      // The staged frame persists; Enter commits, Escape cancels.
      renderOverlay();
    } else if (current.kind === "gradient") {
      applyGradient(current.start, point || current.start);
    } else if (current.kind === "shape") {
      applyShape(dragBox(current.start, point || current.start, false));
    } else if (current.kind === "brush") {
      endBrush(current);
    } else if (current.kind === "warp") {
      finishWarp(current);
    } else if (current.kind === "move") {
      endEdit();
    } else if (current.kind === "moveSelection") {
      endEdit();
      renderOverlay();
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => finish(null));
  canvas.addEventListener("dblclick", (event) => {
    if (session.tool === "lasso" && lassoDraft) commitPolygonal();
  });
}

function roundPoint(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

// Photoshop-style drag box: whole pixels, Shift evens the sides.
function dragBox(anchor, point, square) {
  let dx = Math.round(point.x) - anchor.x;
  let dy = Math.round(point.y) - anchor.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  return {
    x: Math.min(anchor.x, anchor.x + dx),
    y: Math.min(anchor.y, anchor.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

// ---- Keyboard: polygonal lasso and crop staging ----

function installOverlayKeys() {
  window.addEventListener("keydown", (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (lassoDraft) {
      if (event.key === "Enter") { commitPolygonal(); event.preventDefault(); }
      else if (event.key === "Escape") { lassoDraft = null; renderOverlay(); }
      else if (event.key === "Backspace") {
        event.preventDefault();
        lassoDraft.points.pop();
        if (!lassoDraft.points.length) lassoDraft = null;
        renderOverlay();
      }
    } else if (session.tool === "crop" && session.cropRect) {
      if (event.key === "Enter") { commitCrop(); event.preventDefault(); }
      else if (event.key === "Escape") { session.cropRect = null; renderOverlay(); }
    }
  });
}

// ---- Overlay: marching ants, draft outlines and the crop frame ----

let overlay = null;
function ensureOverlay() {
  if (!overlay) {
    overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.id = "selectionOverlay";
    els.canvasHost.appendChild(overlay);
  }
  return overlay;
}

function antsPath(points, closed) {
  if (!points || points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) d += ` L ${points[i].x} ${points[i].y}`;
  if (closed) d += " Z";
  return d;
}

function selectionOutlinePoints(selection) {
  if (!selection) return [];
  if (selection.paths && selection.paths.length) return selection.paths;
  const b = selection.bounds;
  if (!b) return [];
  return [[
    { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height },
  ]];
}

function renderOverlay() {
  const svg = ensureOverlay();
  const m = doc() ? manifest() : null;
  if (!m || !els.canvas) { svg.style.display = "none"; return; }
  // The host centers the canvas; the overlay tracks its actual offset.
  svg.style.left = `${els.canvas.offsetLeft}px`;
  svg.style.top = `${els.canvas.offsetTop}px`;
  const zoom = session.viewport.zoom;
  svg.style.display = "block";
  svg.setAttribute("width", Math.max(1, m.width * zoom));
  svg.setAttribute("height", Math.max(1, m.height * zoom));
  svg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  const parts = [];
  // Draft outline while a selection tool drags.
  let draft = null;
  if (stroke && stroke.kind === "marquee") {
    const rect = dragBox(stroke.anchor, stroke.current || stroke.anchor, stroke.square);
    draft = { paths: [rectPoints(rect)], closed: true };
  } else if (stroke && stroke.kind === "lasso") {
    draft = { paths: [stroke.points], closed: true };
  } else if (lassoDraft) {
    const points = [...lassoDraft.points];
    if (lassoDraft.cursor) points.push(lassoDraft.cursor);
    draft = { paths: [points], closed: false };
  }
  if (draft) {
    for (const path of draft.paths) {
      const d = antsPath(path, draft.closed);
      if (!d) continue;
      parts.push(`<path class="ants dark" d="${d}"/>`);
      parts.push(`<path class="ants bright" d="${d}"/>`);
    }
  }
  // The committed selection.
  for (const path of selectionOutlinePoints(session.selection)) {
    const d = antsPath(path, true);
    if (!d) continue;
    parts.push(`<path class="ants dark" d="${d}"/>`);
    parts.push(`<path class="ants bright" d="${d}"/>`);
  }
  // The crop frame: staged rect (or the full canvas as the starting frame).
  if (session.tool === "crop") {
    const rect = session.cropRect || { x: 0, y: 0, width: m.width, height: m.height };
    const r = snappedRect(rect);
    const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
    parts.push(`<path class="crop-dim" fill-rule="evenodd" d="M 0 0 H ${m.width} V ${m.height} H 0 Z `
      + `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z"/>`);
    parts.push(`<rect class="crop-frame" x="${x0}" y="${y0}" width="${r.width}" height="${r.height}"/>`);
    for (const [hx, hy] of CROP_HANDLES) {
      const cx = x0 + hx * r.width;
      const cy = y0 + hy * r.height;
      const size = 6 / zoom;
      parts.push(`<rect class="handle" x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}"/>`);
    }
  }
  // Grid, guides and the pixel grid draw under the selection chrome.
  const gridStyle = 'stroke="#888888" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"';
  if (session.showGrid && session.gridSize > 0) {
    const size = session.gridSize;
    for (let x = size; x < m.width; x += size) parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${m.height}" ${gridStyle}/>`);
    for (let y = size; y < m.height; y += size) parts.push(`<line x1="0" y1="${y}" x2="${m.width}" y2="${y}" ${gridStyle}/>`);
  }
  if (session.showPixelGrid && zoom >= 8) {
    for (let x = 1; x < m.width; x += 1) parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${m.height}" ${gridStyle}/>`);
    for (let y = 1; y < m.height; y += 1) parts.push(`<line x1="0" y1="${y}" x2="${m.width}" y2="${y}" ${gridStyle}/>`);
  }
  if (session.showGuides && Array.isArray(m.guides)) {
    for (const guide of m.guides) {
      const line = guide.axis === "vertical"
        ? `<line x1="${guide.position}" y1="0" x2="${guide.position}" y2="${m.height}"`
        : `<line x1="0" y1="${guide.position}" x2="${m.width}" y2="${guide.position}"`;
      parts.push(`${line} stroke="#00c8ff" stroke-opacity="0.9" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    }
  }
  svg.innerHTML = parts.join("");
}

function rectPoints(rect) {
  return [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
  ];
}

// ---- Selections ----

function selectionModeOf(mod) {
  return mod.alt ? "Subtract" : mod.shift ? "Add" : session.selectionMode;
}

function setSelectionMask(mask, name, width, height) {
  const wasEmpty = !session.selection || selectionIsEmpty(session.selection);
  const selection = makeSelection(mask, width, height, { feather: 0 });
  // No undo step when nothing was selected and nothing now is.
  if (selectionIsEmpty(selection) && wasEmpty) {
    renderOverlay();
    return;
  }
  beginEdit(name);
  session.selection = selection;
  endEdit();
  renderOverlay();
}

function applySelectionShapes(shapes, name, mod) {
  const m = manifest();
  applySelectionMask(rasterizeShapes(shapes, m.width, m.height), name, mod);
}

function applySelectionMask(mask, name, mod) {
  const m = manifest();
  const mode = selectionModeOf(mod);
  if (mode !== "New" && session.selection) {
    setSelectionMask(combineMasks(session.selection.mask, mask, mode), name, m.width, m.height);
  } else {
    setSelectionMask(mask, name, m.width, m.height);
  }
}

function commitMarquee(current, point) {
  const rect = dragBox(current.anchor, point, current.square);
  if (rect.width < 1 || rect.height < 1) { renderOverlay(); return; }
  const shape = current.kind === "marquee"
    ? (session.marqueeKind === "Ellipse"
      ? { kind: "ellipse", x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : { points: rectPoints(rect) })
    : { points: rectPoints(rect) };
  applySelectionShapes([shape], session.marqueeKind === "Ellipse" ? "Elliptical Marquee" : "Rectangular Marquee",
    current.mod || {});
}

function commitFreehand(points, mod) {
  if (points.length > 2) {
    applySelectionShapes([{ points }], "Lasso", mod || {});
  }
  renderOverlay();
}

function polygonalClick(point, mod) {
  if (!lassoDraft) {
    lassoDraft = { points: [roundPoint(point)], cursor: point, mod: mod || {} };
    renderOverlay();
    return;
  }
  // Clicking near the start closes the polygon.
  const first = lassoDraft.points[0];
  if (lassoDraft.points.length > 2 && Math.hypot(point.x - first.x, point.y - first.y) < 8) {
    commitPolygonal();
    return;
  }
  lassoDraft.points.push(roundPoint(point));
  renderOverlay();
}

function commitPolygonal() {
  if (lassoDraft && lassoDraft.points.length > 2) {
    const mod = lassoDraft.mod;
    const points = lassoDraft.points;
    lassoDraft = null;
    applySelectionShapes([{ points }], "Polygonal Lasso", mod);
    return;
  }
  lassoDraft = null;
  renderOverlay();
}

// Dragging inside the selection moves the outline (never pixels), one undo step,
// offset rounded to whole pixels so edges stay crisp.
function beginSelectionMove(point) {
  if (session.tool === "wand") return false;
  const selection = session.selection;
  if (!selection || selectionIsEmpty(selection) || lassoDraft) return false;
  const b = selection.bounds;
  const inside = point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height
    && selectionContains(selection, point);
  if (!inside) return false;
  beginEdit("Move Selection");
  stroke = { kind: "moveSelection", origin: selection, start: point };
  return true;
}

function moveSelectionTo(point) {
  const origin = stroke.origin;
  const dx = Math.round(point.x - stroke.start.x);
  const dy = Math.round(point.y - stroke.start.y);
  if (!dx && !dy) { session.selection = origin; renderOverlay(); return; }
  const mask = translateMask(origin.mask, origin.width, origin.height, dx, dy);
  session.selection = makeSelection(mask, origin.width, origin.height, { feather: origin.feather });
  renderOverlay();
}

// ---- Magic Wand ----

function runWand(point, mod) {
  const m = manifest();
  const layer = activeLayer();
  if (!layer) {
    if (session.setStatus) session.setStatus("Select a layer to sample first.", true);
    return;
  }
  // Sample source: the active layer drawn at its transform, or the composite.
  const source = document.createElement("canvas");
  source.width = m.width;
  source.height = m.height;
  const context = source.getContext("2d", { willReadFrequently: true });
  if (session.wand.sampleAllLayers) {
    const composite = renderComposite();
    if (composite) context.drawImage(composite, 0, 0);
  } else {
    const asset = session.doc.images.get(layer.imageFile);
    if (asset && layer.transform) {
      const t = layer.transform;
      context.save();
      context.translate(t.origin.x + t.size.width / 2, t.origin.y + t.size.height / 2);
      context.rotate(((t.rotation || 0) * Math.PI) / 180);
      context.scale(
        (t.flipX ? -1 : 1) * t.size.width / (asset.width || t.size.width),
        (t.flipY ? -1 : 1) * t.size.height / (asset.height || t.size.height),
      );
      context.drawImage(asset, -asset.width / 2, -asset.height / 2);
      context.restore();
    }
  }
  const image = context.getImageData(0, 0, m.width, m.height);
  const radius = Math.max(0, (Number(session.wand.sampleSize) - 1) / 2);
  const x = Math.max(0, Math.min(m.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(m.height - 1, Math.round(point.y)));
  let mask;
  if (session.wand.mode === "Object") {
    // The macOS app traces the clicked subject with Vision; here the nearest
    // matching region's outline stands in (recorded as a parity deviation).
    mask = wandMask(image.data, m.width, m.height, x, y, radius, Math.max(8, session.wand.tolerance), true);
  } else {
    mask = wandMask(image.data, m.width, m.height, x, y, radius, session.wand.tolerance, session.wand.contiguous);
  }
  applySelectionMask(mask, "Magic Wand", mod);
}

function renderComposite() {
  try {
    return renderDocument();
  } catch {
    return null;
  }
}

// ---- Crop ----

function cropRatio() {
  const m = manifest();
  switch (session.cropRatioChoice) {
    case "Original": return m.width / m.height;
    case "1:1": return 1;
    case "4:3": return 4 / 3;
    case "3:4": return 3 / 4;
    case "16:9": return 16 / 9;
    case "9:16": return 9 / 16;
    default: return null;
  }
}

function snappedRect(rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x, y,
    width: Math.max(1, Math.round(rect.x + rect.width) - x),
    height: Math.max(1, Math.round(rect.y + rect.height) - y),
  };
}

function startCropDrag(point, mod) {
  const m = manifest();
  const frame = session.cropRect ? snappedRect(session.cropRect) : null;
  if (frame) {
    const tolerance = 8;
    for (let i = 0; i < CROP_HANDLES.length; i += 1) {
      const [hx, hy] = CROP_HANDLES[i];
      const cx = frame.x + hx * frame.width;
      const cy = frame.y + hy * frame.height;
      if (Math.abs(point.x - cx) <= tolerance && Math.abs(point.y - cy) <= tolerance) {
        stroke = { kind: "cropDrag", mode: "resize", index: i, start: point, original: frame };
        return;
      }
    }
    if (point.x > frame.x && point.x < frame.x + frame.width
      && point.y > frame.y && point.y < frame.y + frame.height) {
      stroke = { kind: "cropDrag", mode: "move", start: point, original: frame };
      return;
    }
  }
  stroke = { kind: "cropDrag", mode: "create", start: roundPoint(point), original: null };
  session.cropRect = { x: stroke.start.x, y: stroke.start.y, width: 0, height: 0 };
}

function cropDragTo(point, mod) {
  const ratio = cropRatio();
  if (stroke.mode === "create") {
    session.cropRect = cropCreate(stroke.start, point, ratio, mod.alt);
  } else if (stroke.mode === "move") {
    const moved = snappedRect({
      x: stroke.original.x + (point.x - stroke.start.x),
      y: stroke.original.y + (point.y - stroke.start.y),
      width: stroke.original.width,
      height: stroke.original.height,
    });
    session.cropRect = moved;
  } else {
    session.cropRect = cropResize(stroke.original, stroke.index, point, ratio, mod.alt);
  }
  renderOverlay();
}

// A frame dragged from `start` to `end` — or, symmetric (Option), grown out from
// `start` as its center. Ratio clamps the smaller axis to the larger's proportion.
function cropCreate(start, end, ratio, symmetric) {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (ratio) {
    if (Math.abs(dx) > Math.abs(dy) * ratio) dy = (dy < 0 ? -1 : 1) * Math.abs(dx) / ratio;
    else dx = (dx < 0 ? -1 : 1) * Math.abs(dy) * ratio;
  }
  if (symmetric) {
    return snappedRect({
      x: start.x - Math.abs(dx), y: start.y - Math.abs(dy),
      width: Math.abs(dx) * 2, height: Math.abs(dy) * 2,
    });
  }
  return snappedRect({
    x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy),
    width: Math.abs(dx), height: Math.abs(dy),
  });
}

// A handle dragged to `point`: the handle's edges move, the opposite edges anchor;
// Option mirrors about the center; a ratio keeps the frame's proportion.
function cropResize(original, index, point, ratio, symmetric) {
  const [hx, hy] = CROP_HANDLES[index];
  let minX = original.x;
  let minY = original.y;
  let maxX = original.x + original.width;
  let maxY = original.y + original.height;
  if (hx === 0) minX = Math.min(point.x, maxX - 1);
  else if (hx === 1) maxX = Math.max(point.x, minX + 1);
  if (hy === 0) minY = Math.min(point.y, maxY - 1);
  else if (hy === 1) maxY = Math.max(point.y, minY + 1);
  if (symmetric) {
    const cx = original.x + original.width / 2;
    const cy = original.y + original.height / 2;
    if (hx === 0) maxX = 2 * cx - minX;
    else if (hx === 1) minX = 2 * cx - maxX;
    if (hy === 0) maxY = 2 * cy - minY;
    else if (hy === 1) minY = 2 * cy - maxY;
  }
  let rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  if (ratio) {
    // The dragged edge's axis drives; the other dimension follows about the
    // anchored opposite edge (the center when symmetric).
    const anchorX = symmetric ? original.x + original.width / 2 : hx === 0 ? original.x + original.width : original.x;
    const anchorY = symmetric ? original.y + original.height / 2 : hy === 0 ? original.y + original.height : original.y;
    if (hx !== 0.5) {
      const height = rect.width / ratio;
      rect.height = height;
      rect.y = hy === 0.5 ? anchorY - height / 2 : hy === 0 ? anchorY - height : anchorY;
    } else if (hy !== 0.5) {
      const width = rect.height * ratio;
      rect.width = width;
      rect.x = hx === 0.5 ? anchorX - width / 2 : hx === 0 ? anchorX - width : anchorX;
    }
  }
  return snappedRect(rect);
}

// Changing the ratio keeps the width and re-fits the height about the middle.
function changeCropRatio() {
  const rect = session.cropRect;
  const ratio = cropRatio();
  if (!rect || !ratio) return;
  const height = rect.width / ratio;
  session.cropRect = snappedRect({ x: rect.x, y: rect.y + rect.height / 2 - height / 2, width: rect.width, height });
}

// Commit translates the whole document by (-x, -y): every layer's origin (and its
// mask's placement) plus the guides, as CanvasResizer does.
function commitCrop() {
  const rect = session.cropRect;
  if (!rect) return;
  const r = snappedRect(rect);
  const m = manifest();
  beginEdit("Crop");
  m.width = r.width;
  m.height = r.height;
  for (const layer of m.layers) {
    if (layer.transform) {
      layer.transform.origin.x -= r.x;
      layer.transform.origin.y -= r.y;
    }
    if (layer.maskPlacement && layer.maskPlacement.origin) {
      layer.maskPlacement.origin.x -= r.x;
      layer.maskPlacement.origin.y -= r.y;
    }
  }
  if (Array.isArray(m.guides)) {
    for (const guide of m.guides) {
      if (guide.axis === "vertical") guide.position -= r.x;
      else guide.position -= r.y;
    }
  }
  session.cropRect = null;
  endEdit();
  markDirty();
  emit("document");
}

// ---- Painting ----

// The painting target: the active layer's pixels (or its mask) as a canvas.
// With `convert`, an image source becomes a canvas through replaceAsset so the
// conversion is undoable like any pixel edit.
function paintTarget(convert = false) {
  const layer = activeLayer();
  if (!layer || layer.isGroup || layer.adjustment) return null;
  const useMask = session.maskTarget === "mask" && layer.maskFile;
  const file = useMask ? layer.maskFile : layer.imageFile;
  if (!file && !useMask) return null;
  let source = session.doc.images.get(file);
  if (!source) return null;
  if (!(source instanceof HTMLCanvasElement)) {
    if (!convert) return { layer, file, canvas: null, isMask: useMask };
    source = replaceAsset(file, canvasOf(source));
  }
  return { layer, file, canvas: source, isMask: useMask };
}

function brushFalloff(u) {
  const k = 2.5;
  const soft = Math.exp(-k * u * u) - Math.exp(-k);
  return Math.max(0, soft / (1 - Math.exp(-k)));
}

// The selection's coverage resampled into the layer's pixel grid: multiply paint
// amounts by it so pixels outside the selection keep the original. Null when no
// selection; a zeroed array when the selection is empty (paint nothing).
export function selectionCoverageGrid(canvas, layer) {
  const selection = session.selection;
  if (!selection) return null;
  const m = manifest();
  const { rect: region, coverage } = selectionClip(selection, { x: 0, y: 0, width: m.width, height: m.height });
  if (!coverage) return new Float32Array(canvas.width * canvas.height);
  const grid = document.createElement("canvas");
  grid.width = canvas.width;
  grid.height = canvas.height;
  const context = grid.getContext("2d", { willReadFrequently: true });
  const t = layer.transform;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.translate(t.size.width / 2, t.size.height / 2);
  context.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
  context.rotate(-((t.rotation || 0) * Math.PI) / 180);
  context.translate(-t.origin.x - t.size.width / 2, -t.origin.y - t.size.height / 2);
  context.drawImage(coverage, region.x, region.y);
  const data = context.getImageData(0, 0, grid.width, grid.height).data;
  const out = new Float32Array(grid.width * grid.height);
  for (let i = 0; i < out.length; i += 1) out[i] = data[i * 4 + 3] / 255;
  return out;
}

function startBrush(point, options = {}) {
  const peeked = paintTarget(false);
  if (!peeked) {
    if (session.setStatus) session.setStatus("Select a paintable layer first.", true);
    return;
  }
  beginEdit(options.blur ? "Blur" : options.healing ? "Spot Healing" : options.erasing ? "Erase" : "Brush");
  const target = paintTarget(true);
  if (!target || !target.canvas) { cancelEdit(); return; }
  const settings = { ...session.brush, ...options };
  stroke = {
    kind: "brush",
    target,
    settings,
    last: point,
    // Stroke-capped opacity: dabs accumulate coverage; color applies once at the end.
    coverage: document.createElement("canvas"),
  };
  stroke.coverage.width = target.canvas.width;
  stroke.coverage.height = target.canvas.height;
  stroke.coverageContext = stroke.coverage.getContext("2d", { willReadFrequently: true });
  dab(point);
}

function startHealing(point) {
  const target = paintTarget(false);
  if (!target || target.isMask) {
    if (session.setStatus) session.setStatus("Spot Healing works on a layer's pixels.", true);
    return;
  }
  startBrush(point, { healing: true });
}

function brushTo(point) {
  if (!stroke || stroke.kind !== "brush") return;
  // Interpolate dabs along the segment so fast strokes stay continuous.
  const from = stroke.last;
  const distance = Math.hypot(point.x - from.x, point.y - from.y);
  const spacing = Math.max(1, stroke.settings.diameter * 0.15);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  for (let i = 1; i <= steps; i += 1) {
    dab({
      x: from.x + ((point.x - from.x) * i) / steps,
      y: from.y + ((point.y - from.y) * i) / steps,
    });
  }
  stroke.last = point;
}

// Dabs land in the layer's own pixel grid. A document-space circle maps to an
// axis-aligned ellipse there (rotate happens after scale), so the coverage test
// normalizes each axis by its own reach.
function dab(point) {
  const { layer, canvas } = stroke.target;
  const settings = stroke.settings;
  if (stroke.clone) cloneOffsetFor(point);
  const inverse = inverseTransformOf(layer, canvas.width, canvas.height);
  if (!inverse) return;
  const local = toLayerPixels(point, inverse);
  const radius = settings.diameter / 2;
  const hardness = Math.max(0, Math.min(1, settings.hardness));
  const context = stroke.coverageContext;
  const cx = local.x;
  const cy = local.y;
  const reachX = radius / Math.abs(inverse.scaleX || 1);
  const reachY = radius / Math.abs(inverse.scaleY || 1);
  const x0 = Math.max(0, Math.floor(cx - reachX));
  const y0 = Math.max(0, Math.floor(cy - reachY));
  const x1 = Math.min(canvas.width, Math.ceil(cx + reachX));
  const y1 = Math.min(canvas.height, Math.ceil(cy + reachY));
  if (x1 <= x0 || y1 <= y0) return;
  const image = context.getImageData(x0, y0, x1 - x0, y1 - y0);
  const pixels = image.data;
  const width = x1 - x0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const nx = (x + 0.5 - cx) / reachX;
      const ny = (y + 0.5 - cy) / reachY;
      const distance = Math.hypot(nx, ny);
      if (distance > 1) continue;
      let coverage;
      if (hardness >= 1) coverage = 1;
      else if (distance < hardness) coverage = 1;
      else coverage = brushFalloff(distance);
      const index = ((y - y0) * width + (x - x0)) * 4 + 3;
      if (coverage > pixels[index] / 255) pixels[index] = Math.round(coverage * 255);
    }
  }
  context.putImageData(image, x0, y0);
}

// Bakes the stroke: color flows through accumulated coverage, capped at brush
// opacity and the selection's coverage. The result is a NEW canvas (immutable
// assets); undo walks the swap pair back.
function endBrush(active = stroke) {
  if (!active) return;
  stroke = null;
  const { canvas, file, isMask, layer } = active.target;
  const settings = active.settings;
  const width = canvas.width;
  const height = canvas.height;
  const coverage = active.coverageContext.getImageData(0, 0, width, height).data;
  let painted = false;
  for (let i = 3; i < coverage.length; i += 4) {
    if (coverage[i] > 0) { painted = true; break; }
  }
  if (!painted) { cancelEdit(); return; }
  const next = document.createElement("canvas");
  next.width = width;
  next.height = height;
  const context = next.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const out = context.getImageData(0, 0, width, height);
  const outData = out.data;
  const sel = selectionCoverageGrid(next, layer);
  if (isMask) {
    // Masks paint grayscale coverage directly.
    const paint = settings.erasing ? 0 : 255;
    for (let i = 0, p = 0; i < outData.length; i += 4, p += 1) {
      const a = (coverage[i + 3] / 255) * settings.opacity * (sel ? sel[p] : 1);
      if (a > 0) outData[i] = Math.round(outData[i] * (1 - a) + paint * a);
    }
  } else if (settings.blur) {
    // Blur brush: the stroke's coverage softens the layer beneath it.
    const radius = Math.max(1, Math.round(settings.blurRadius));
    const blurred = boxBlur(out, width, height, radius).data;
    for (let i = 0, p = 0; i < outData.length; i += 4, p += 1) {
      const a = (coverage[i + 3] / 255) * settings.opacity * (sel ? sel[p] : 1);
      if (a <= 0) continue;
      for (let c = 0; c < 4; c += 1) {
        outData[i + c] = Math.round(outData[i + c] * (1 - a) + blurred[i + c] * a);
      }
    }
  } else if (settings.healing) {
    // HealPixels.c port: the stroke's coverage is the hole. The coverage the
    // solver sees already carries the selection's clip.
    const pixels = new Uint8ClampedArray(outData);
    const hole = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < coverage.length; i += 4, p += 1) {
      hole[p] = Math.round((coverage[i + 3] / 255) * 255 * (sel ? sel[p] : 1));
    }
    const mode = Math.max(0, HEAL_MODES.indexOf(session.healMode));
    const seed = (Math.random() * 0xffffffff) >>> 0;
    spotHeal(pixels, hole, width, height, settings.opacity, mode, seed);
    outData.set(pixels);
  } else if (settings.clone) {
    applyClone(out, coverage, sel, settings, active);
  } else {
    const color = settings.erasing
      ? null
      : {
          red: Math.round(session.foregroundColor.red * 255),
          green: Math.round(session.foregroundColor.green * 255),
          blue: Math.round(session.foregroundColor.blue * 255),
        };
    for (let i = 0, p = 0; i < outData.length; i += 4, p += 1) {
      const a = (coverage[i + 3] / 255) * settings.opacity * (sel ? sel[p] : 1);
      if (a <= 0) continue;
      if (color) {
        outData[i] = Math.round(outData[i] * (1 - a) + color.red * a);
        outData[i + 1] = Math.round(outData[i + 1] * (1 - a) + color.green * a);
        outData[i + 2] = Math.round(outData[i + 2] * (1 - a) + color.blue * a);
      } else {
        outData[i + 3] = Math.round(outData[i + 3] * (1 - a));
      }
    }
  }
  context.putImageData(out, 0, 0);
  replaceAsset(file, next);
  endEdit();
  markDirty();
}

// Clone stamp bake: each painted pixel takes the sample at (its document position
// minus the stroke's offset) — This Layer from the layer's own pixels, All Layers
// from the composite as it stood when the stroke began.
function applyClone(out, coverage, sel, settings, active) {
  const { layer, canvas, file } = active.target;
  const clone = active.clone;
  if (!clone || !session.cloneSource) return;
  const width = canvas.width;
  const height = canvas.height;
  const inverse = inverseTransformOf(layer, width, height);
  const composite = clone.sample === "All Layers" ? renderComposite() : null;
  let compositeData = null;
  if (composite) {
    const context = composite.getContext("2d", { willReadFrequently: true });
    compositeData = context.getImageData(0, 0, composite.width, composite.height).data;
  }
  const sourceData = compositeData
    || canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const sourceWidth = composite ? composite.width : width;
  const sourceHeight = composite ? composite.height : height;
  const outData = out.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * 4;
      const a = (coverage[i + 3] / 255) * settings.opacity * (sel ? sel[p] : 1);
      if (a <= 0) continue;
      const doc = forwardPoint(inverse, x + 0.5, y + 0.5);
      const sx = Math.round(doc.x - clone.offset.x);
      const sy = Math.round(doc.y - clone.offset.y);
      if (sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight) continue;
      const s = (sy * sourceWidth + sx) * 4;
      outData[i] = Math.round(outData[i] * (1 - a) + sourceData[s] * a);
      outData[i + 1] = Math.round(outData[i + 1] * (1 - a) + sourceData[s + 1] * a);
      outData[i + 2] = Math.round(outData[i + 2] * (1 - a) + sourceData[s + 2] * a);
      outData[i + 3] = Math.round(outData[i + 3] * (1 - a) + sourceData[s + 3] * a);
    }
  }
}

function boxBlur(image, width, height, radius) {
  const source = image.data;
  const result = new ImageData(width, height);
  const target = result.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const index = (yy * width + xx) * 4;
          r += source[index]; g += source[index + 1]; b += source[index + 2]; a += source[index + 3];
          count += 1;
        }
      }
      const index = (y * width + x) * 4;
      target[index] = r / count; target[index + 1] = g / count;
      target[index + 2] = b / count; target[index + 3] = a / count;
    }
  }
  return result;
}

// ---- Clone stamp ----

function startClone(point, mod) {
  if (mod.alt) {
    session.cloneSource = { x: point.x, y: point.y };
    session.cloneOffset = null;
    if (session.setStatus) session.setStatus("Clone source set.");
    return;
  }
  if (!session.cloneSource) {
    if (session.setStatus) session.setStatus("Alt-click to set the clone source first.", true);
    return;
  }
  const target = paintTarget(false);
  if (!target || target.isMask) {
    if (session.setStatus) session.setStatus("The Clone Stamp works on a layer's pixels.", true);
    return;
  }
  beginEdit("Clone Stamp");
  const converted = paintTarget(true);
  stroke = {
    kind: "brush",
    target: converted,
    settings: { ...session.brush, erasing: false },
    last: point,
    coverage: document.createElement("canvas"),
    clone: { sample: session.clone.sample, offset: null },
  };
  stroke.coverage.width = converted.canvas.width;
  stroke.coverage.height = converted.canvas.height;
  stroke.coverageContext = stroke.coverage.getContext("2d", { willReadFrequently: true });
  dab(point);
}

// The stroke's offset: source-to-dab vector, fixed at the first dab. Aligned
// strokes reuse the session's offset across strokes; Alt-click cleared it.
function cloneOffsetFor(point) {
  if (!stroke.clone) return;
  if (stroke.clone.offset !== null) return;
  if (session.clone.aligned && session.cloneOffset) {
    stroke.clone.offset = session.cloneOffset;
    return;
  }
  stroke.clone.offset = {
    x: point.x - session.cloneSource.x,
    y: point.y - session.cloneSource.y,
  };
  if (session.clone.aligned) session.cloneOffset = stroke.clone.offset;
}

// ---- Warp stroke (the blur tool's Liquify and Smudge modes) ----
// Port of WarpStroke: dabs run on a document-size working copy of the displayed
// layer. Smudge carries a (2r+1)² RGBA square; Liquify forward-pushes pixels via
// bilinear samples. The finish stamps the result into the layer along the stroke
// with a hard brush one step per diameter/20.

function startWarp(point) {
  const layer = activeLayer();
  if (!layer || layer.isGroup || layer.adjustment || !layer.imageFile) {
    if (session.setStatus) session.setStatus("Select a paintable layer first.", true);
    return;
  }
  if (session.maskTarget === "mask") {
    if (session.setStatus) session.setStatus("Smudge and Liquify work on a layer's pixels, not its mask.", true);
    return;
  }
  const asset = session.doc.images.get(layer.imageFile);
  if (!asset) return;
  const m = manifest();
  beginEdit(session.blurMode);
  const work = document.createElement("canvas");
  work.width = m.width;
  work.height = m.height;
  const wctx = work.getContext("2d", { willReadFrequently: true });
  const t = layer.transform;
  wctx.save();
  wctx.translate(t.origin.x + t.size.width / 2, t.origin.y + t.size.height / 2);
  wctx.rotate(((t.rotation || 0) * Math.PI) / 180);
  wctx.scale(
    (t.flipX ? -1 : 1) * t.size.width / (asset.width || t.size.width),
    (t.flipY ? -1 : 1) * t.size.height / (asset.height || t.size.height),
  );
  wctx.drawImage(asset, -asset.width / 2, -asset.height / 2);
  wctx.restore();
  stroke = {
    kind: "warp",
    mode: session.blurMode,
    layer,
    file: layer.imageFile,
    work,
    pixels: wctx.getImageData(0, 0, m.width, m.height),
    diameter: Math.max(2, session.brush.diameter),
    hardness: Math.min(0.98, Math.max(0, session.brush.hardness)),
    strength: Math.min(1, Math.max(0.01, session.brush.opacity)),
    last: null,
    points: [],
    carried: null,
  };
  warpTo(point);
}

function warpWeight(u, hardness) {
  if (u >= 1) return 0;
  if (u <= hardness) return 1;
  const t = (1 - u) / (1 - hardness);
  return t * t * (3 - 2 * t);
}

function warpTo(point) {
  if (!stroke || stroke.kind !== "warp") return;
  if (stroke.last === null) {
    stroke.last = point;
    if (stroke.mode === "Smudge") warpPickUp(point);
    return;
  }
  const from = stroke.last;
  const distance = Math.hypot(point.x - from.x, point.y - from.y);
  // Smudge drags one dab's spacing at a time; spaced widely each step leaves a
  // faint echo. A pixel apart (a little more for a huge brush) the steps run
  // together into one smear.
  const spacing = Math.max(1, stroke.diameter * (stroke.mode === "Smudge" ? 0.005 : 0.025));
  if (distance < spacing) return;
  const steps = Math.ceil(distance / spacing);
  let previous = from;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const next = {
      x: from.x + (point.x - from.x) * t,
      y: from.y + (point.y - from.y) * t,
    };
    if (stroke.mode === "Smudge") warpSmudge(next);
    else warpPush(previous, next);
    stroke.points.push(next);
    previous = next;
  }
  stroke.last = point;
}

function warpPickUp(center) {
  const data = stroke.pixels.data;
  const width = stroke.pixels.width;
  const height = stroke.pixels.height;
  const r = Math.ceil(stroke.diameter / 2);
  const side = 2 * r + 1;
  const carried = new Float32Array(side * side * 4);
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  for (let dy = -r; dy <= r; dy += 1) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx += 1) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const p = (y * width + x) * 4;
      const c = ((dy + r) * side + dx + r) * 4;
      for (let k = 0; k < 4; k += 1) carried[c + k] = data[p + k];
    }
  }
  stroke.carried = carried;
  stroke.carriedSide = side;
}

function warpSmudge(center) {
  const r = Math.ceil(stroke.diameter / 2);
  const side = 2 * r + 1;
  if (!stroke.carried) warpPickUp(center);
  const data = stroke.pixels.data;
  const width = stroke.pixels.width;
  const height = stroke.pixels.height;
  const keep = stroke.strength;
  const invR = 1 / (stroke.diameter / 2);
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  for (let dy = -r; dy <= r; dy += 1) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx += 1) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const w = warpWeight(Math.sqrt(dx * dx + dy * dy) * invR, stroke.hardness);
      if (w <= 0) continue;
      const p = (y * width + x) * 4;
      const c = ((dy + r) * side + dx + r) * 4;
      for (let k = 0; k < 4; k += 1) {
        const under = data[p + k];
        // What was under the brush at the last dab, laid down here at the smudge's
        // strength; the brush then carries what it just left, and nothing older.
        const painted = under + (stroke.carried[c + k] - under) * w * keep;
        data[p + k] = Math.max(0, Math.min(255, Math.round(painted)));
        stroke.carried[c + k] = painted;
      }
    }
  }
}

// Forward warp: pixels under the brush move with it, most at its center, fading
// to none at its rim. Each dab samples a copy of the area as it was.
function warpPush(a, b) {
  const r = Math.ceil(stroke.diameter / 2);
  const data = stroke.pixels.data;
  const width = stroke.pixels.width;
  const height = stroke.pixels.height;
  const moveX = (b.x - a.x) * stroke.strength;
  const moveY = (b.y - a.y) * stroke.strength;
  const margin = Math.ceil(Math.max(Math.abs(moveX), Math.abs(moveY))) + 2;
  const cx = Math.round(b.x);
  const cy = Math.round(b.y);
  const x0 = Math.max(0, cx - r - margin);
  const x1 = Math.min(width - 1, cx + r + margin);
  const y0 = Math.max(0, cy - r - margin);
  const y1 = Math.min(height - 1, cy + r + margin);
  if (x0 > x1 || y0 > y1) return;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const scratch = new Float32Array(cw * ch * 4);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const p = ((y + y0) * width + x + x0) * 4;
      const s = (y * cw + x) * 4;
      for (let k = 0; k < 4; k += 1) scratch[s + k] = data[p + k];
    }
  }
  const invR = 1 / (stroke.diameter / 2);
  for (let dy = -r; dy <= r; dy += 1) {
    const y = cy + dy;
    if (y < y0 || y > y1) continue;
    for (let dx = -r; dx <= r; dx += 1) {
      const x = cx + dx;
      if (x < x0 || x > x1) continue;
      const w = warpWeight(Math.sqrt(dx * dx + dy * dy) * invR, stroke.hardness);
      if (w <= 0) continue;
      // Bilinear sample of the old pixels, from behind the brush's travel.
      const sx = Math.min(cw - 1, Math.max(0, x - x0 - moveX * w));
      const sy = Math.min(ch - 1, Math.max(0, y - y0 - moveY * w));
      const ix = Math.min(cw - 2, Math.floor(sx));
      const iy = Math.min(ch - 2, Math.floor(sy));
      if (ix < 0 || iy < 0) continue;
      const fx = sx - ix;
      const fy = sy - iy;
      const p = (y * width + x) * 4;
      const s00 = (iy * cw + ix) * 4;
      const s10 = s00 + 4;
      const s01 = s00 + cw * 4;
      const s11 = s01 + 4;
      for (let k = 0; k < 4; k += 1) {
        const top = scratch[s00 + k] + (scratch[s10 + k] - scratch[s00 + k]) * fx;
        const bottom = scratch[s01 + k] + (scratch[s11 + k] - scratch[s01 + k]) * fx;
        data[p + k] = Math.max(0, Math.min(255, Math.round(top + (bottom - top) * fy)));
      }
    }
  }
}

// Paints the finished warp into the layer's pixels along the stroke, as one edit.
function finishWarp(warp) {
  stroke = null;
  if (!warp.points.length) { cancelEdit(); return; }
  const layer = warp.layer;
  const current = session.doc.images.get(warp.file);
  if (!current) { cancelEdit(); return; }
  const width = current.width;
  const height = current.height;
  const next = document.createElement("canvas");
  next.width = width;
  next.height = height;
  const context = next.getContext("2d", { willReadFrequently: true });
  context.drawImage(current, 0, 0);
  const out = context.getImageData(0, 0, width, height);
  const outData = out.data;
  const workData = warp.pixels.data;
  const workWidth = warp.pixels.width;
  const workHeight = warp.pixels.height;
  const inverse = inverseTransformOf(layer, width, height);
  const sel = selectionCoverageGrid(next, layer);
  // A hard tip a little wider than the brush covers everything the stroke moved;
  // a point every twentieth of its width covers what every dab did.
  const radius = (warp.diameter + 4) / 2;
  const spacing = Math.max(1, warp.diameter * 0.05);
  const reachX = radius / Math.abs(inverse.scaleX || 1);
  const reachY = radius / Math.abs(inverse.scaleY || 1);
  let kept = null;
  for (let index = 0; index < warp.points.length; index += 1) {
    const point = warp.points[index];
    if (kept && index < warp.points.length - 1
      && Math.hypot(point.x - kept.x, point.y - kept.y) < spacing) continue;
    kept = point;
    const local = toLayerPixels(point, inverse);
    const x0 = Math.max(0, Math.floor(local.x - reachX));
    const y0 = Math.max(0, Math.floor(local.y - reachY));
    const x1 = Math.min(width, Math.ceil(local.x + reachX));
    const y1 = Math.min(height, Math.ceil(local.y + reachY));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const p = y * width + x;
        const i = p * 4;
        const clip = sel ? sel[p] : 1;
        if (clip <= 0) continue;
        const doc = forwardPoint(inverse, x + 0.5, y + 0.5);
        const distance = Math.hypot(doc.x - point.x, doc.y - point.y);
        if (distance > radius) continue;
        const sx = Math.max(0, Math.min(workWidth - 1, Math.round(doc.x)));
        const sy = Math.max(0, Math.min(workHeight - 1, Math.round(doc.y)));
        const s = (sy * workWidth + sx) * 4;
        for (let k = 0; k < 4; k += 1) outData[i + k] = workData[s + k];
      }
    }
  }
  context.putImageData(out, 0, 0);
  replaceAsset(warp.file, next);
  endEdit();
  markDirty();
}

// ---- Gradient ----

function applyGradient(start, end) {
  let target = paintTarget(false);
  if (!target || target.isMask) {
    if (session.setStatus) session.setStatus("Select a paintable layer first.", true);
    return;
  }
  beginEdit("Gradient");
  target = paintTarget(true);
  const canvas = target.canvas;
  const inverse = inverseTransformOf(target.layer, canvas.width, canvas.height);
  const a = toLayerPixels(start, inverse);
  const b = toLayerPixels(end, inverse);
  const g = session.gradient;
  const fg = session.foregroundColor;
  const bg = session.backgroundColor;
  const toCss = (color, alpha) => `rgba(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)},${alpha})`;
  const transparent = { red: fg.red, green: fg.green, blue: fg.blue };
  let stopA = { color: fg, alpha: 1 };
  let stopB = g.style === "Foreground to Transparent" ? { color: transparent, alpha: 0 } : { color: bg, alpha: 1 };
  if (g.reversed) [stopA, stopB] = [stopB, stopA];
  // Paint the gradient on its own plane so the selection clips it before it lands.
  const plane = document.createElement("canvas");
  plane.width = canvas.width;
  plane.height = canvas.height;
  const pctx = plane.getContext("2d");
  let gradient;
  if (g.shape === "Radial") {
    const radius = Math.max(0.001, Math.hypot(b.x - a.x, b.y - a.y));
    gradient = pctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, radius);
  } else {
    gradient = pctx.createLinearGradient(a.x, a.y, b.x, b.y);
  }
  gradient.addColorStop(0, toCss(stopA.color, stopA.alpha));
  gradient.addColorStop(1, toCss(stopB.color, stopB.alpha));
  pctx.globalAlpha = g.opacity;
  pctx.fillStyle = gradient;
  pctx.fillRect(0, 0, plane.width, plane.height);
  const selection = session.selection;
  if (selection) {
    const m = manifest();
    const { rect: region, coverage } = selectionClip(selection, { x: 0, y: 0, width: m.width, height: m.height });
    if (!coverage) { cancelEdit(); return; }
    const t = target.layer.transform;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.translate(t.size.width / 2, t.size.height / 2);
    pctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
    pctx.rotate(-((t.rotation || 0) * Math.PI) / 180);
    pctx.translate(-t.origin.x - t.size.width / 2, -t.origin.y - t.size.height / 2);
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(coverage, region.x, region.y);
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.globalCompositeOperation = "source-over";
  }
  const next = document.createElement("canvas");
  next.width = canvas.width;
  next.height = canvas.height;
  const nctx = next.getContext("2d");
  nctx.drawImage(canvas, 0, 0);
  nctx.drawImage(plane, 0, 0);
  replaceAsset(target.file, next);
  endEdit();
  markDirty();
  emit("document");
}

// ---- Shape and text layers ----

function applyShape(rect) {
  if (!doc() || rect.width < 1 || rect.height < 1) return;
  const m = manifest();
  beginEdit("Draw Shape");
  const shape = {
    kind: session.shape.kind,
    red: session.foregroundColor.red,
    green: session.foregroundColor.green,
    blue: session.foregroundColor.blue,
    cornerRadius: session.shape.cornerRadius,
    lineWidth: session.shape.lineWidth,
    start: { x: 0, y: 0 },
    end: { x: rect.width, y: rect.height },
  };
  const layer = {
    id: crypto.randomUUID(),
    name: nextShapeName(),
    isVisible: true,
    opacity: 1,
    blendMode: "Normal",
    shape,
    transform: {
      origin: { x: rect.x, y: rect.y },
      size: { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    },
  };
  m.layers.push(layer);
  endEdit();
  setActiveLayer(layer.id);
  markDirty();
  emit("document");
}

function nextShapeName() {
  const layers = manifest().layers;
  let n = 1;
  while (layers.some((layer) => layer.name === `${session.shape.kind} ${n}`)) n += 1;
  return `${session.shape.kind} ${n}`;
}

function placeType(point) {
  if (!doc()) return;
  const m = manifest();
  const style = {
    content: "Text",
    fontName: "Helvetica",
    fontSize: session.typeTool?.fontSize ?? 72,
    red: session.foregroundColor.red,
    green: session.foregroundColor.green,
    blue: session.foregroundColor.blue,
    alignment: "Left",
    tracking: 0,
    leading: 0,
    boxSize: null,
    colorRuns: null,
    fontRuns: null,
  };
  beginEdit("Add Text");
  const layer = {
    id: crypto.randomUUID(),
    name: "Text",
    isVisible: true,
    opacity: 1,
    blendMode: "Normal",
    text: style,
    transform: {
      origin: { x: point.x, y: point.y },
      size: { width: Math.max(16, style.fontSize * 6), height: Math.max(16, Math.round(style.fontSize * 1.4)) },
    },
  };
  m.layers.push(layer);
  endEdit();
  setActiveLayer(layer.id);
  markDirty();
  emit("document");
  if (session.setStatus) session.setStatus("Text layer added — edit content in the type sheet (Layer panel tag: text).");
}

// ---- View tools ----

function startMove(point) {
  const layer = activeLayer();
  if (!layer) return;
  beginEdit("Move Layer");
  stroke = { kind: "move", origin: { ...layer.transform.origin }, start: point, layer };
}

function moveLayerTo(point) {
  const layer = stroke.layer;
  let x = stroke.origin.x + (point.x - stroke.start.x);
  let y = stroke.origin.y + (point.y - stroke.start.y);
  if (session.snapEnabled) ({ x, y } = snapMove(layer, x, y));
  layer.transform.origin.x = x;
  layer.transform.origin.y = y;
}

// View › Snap To for the move tool: the dragged layer's edges and center seek
// guides, grid lines, other layers' edges and the document bounds. The snap
// threshold lives in screen pixels (8 ÷ zoom) so it feels the same at every zoom.
function snapMove(layer, x, y) {
  const m = manifest();
  const transform = layer.transform;
  const width = transform.size.width || 0;
  const height = transform.size.height || 0;
  const threshold = 8 / (session.viewport.zoom || 1);
  const targetsX = [], targetsY = [];
  // Document bounds and center.
  if (session.snapToDocumentBounds !== false) {
    targetsX.push(0, m.width, (m.width - width) / 2);
    targetsY.push(0, m.height, (m.height - height) / 2);
  }
  // Guides: a vertical guide pins x, a horizontal guide pins y.
  if (session.snapToGuides !== false && Array.isArray(m.guides)) {
    for (const guide of m.guides) {
      if (guide.axis === "vertical") targetsX.push(guide.position);
      else targetsY.push(guide.position);
    }
  }
  // Grid lines.
  const grid = session.gridSize || 50;
  if (session.snapToGrid && grid > 0) {
    targetsX.push(Math.round(x / grid) * grid, Math.round((x + width) / grid) * grid - width);
    targetsY.push(Math.round(y / grid) * grid, Math.round((y + height) / grid) * grid - height);
  }
  // Other layers' edges and centers.
  if (session.snapToLayers && Array.isArray(m.layers)) {
    for (const other of m.layers) {
      if (other === transform || other.id === layer.id || !other.transform || other.isGroup) continue;
      const t = other.transform;
      const ow = t.size.width || 0, oh = t.size.height || 0;
      targetsX.push(t.origin.x, t.origin.x + ow, t.origin.x + ow / 2 - width / 2);
      targetsY.push(t.origin.y, t.origin.y + oh, t.origin.y + oh / 2 - height / 2);
    }
  }
  const snap = (value, targets) => {
    let best = value, bestDistance = threshold;
    for (const target of targets) {
      const distance = Math.abs(value - target);
      if (distance < bestDistance) { bestDistance = distance; best = target; }
    }
    return best;
  };
  return { x: snap(x, targetsX), y: snap(y, targetsY) };
}

function pickColor(point) {
  const canvas = els.canvas;
  const context = canvas.getContext("2d");
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const data = context.getImageData(x, y, 1, 1).data;
  session.foregroundColor = { red: data[0] / 255, green: data[1] / 255, blue: data[2] / 255 };
  emit("colors");
  if (session.setStatus) {
    session.setStatus(`Foreground ${Math.round(data[0])}, ${Math.round(data[1])}, ${Math.round(data[2])}`);
  }
}

// ---- Transform math ----

// LayerTransform: origin is the top-left corner and center = origin + size/2.
// Document point → layer pixel inverts translate(center)·rotate·flip·scale.
function inverseTransformOf(layer, assetWidth, assetHeight) {
  const transform = layer.transform;
  if (!transform) return null;
  const rotation = ((transform.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const sizeW = transform.size.width || 1;
  const sizeH = transform.size.height || 1;
  return {
    cos, sin,
    // Grid mapping includes the asset→size scale so dabs land on real pixels.
    scaleX: ((transform.flipX ? -1 : 1) * sizeW) / (assetWidth || sizeW),
    scaleY: ((transform.flipY ? -1 : 1) * sizeH) / (assetHeight || sizeH),
    sizeW, sizeH,
    center: { x: transform.origin.x + sizeW / 2, y: transform.origin.y + sizeH / 2 },
  };
}

function toLayerPixels(point, inverse) {
  const dx = point.x - inverse.center.x;
  const dy = point.y - inverse.center.y;
  const rx = inverse.cos * dx + inverse.sin * dy;
  const ry = -inverse.sin * dx + inverse.cos * dy;
  return {
    x: inverse.sizeW / 2 + rx / inverse.scaleX,
    y: inverse.sizeH / 2 + ry / inverse.scaleY,
  };
}

// Layer pixel → document point: the forward transform of toLayerPixels.
function forwardPoint(inverse, lx, ly) {
  const ax = inverse.scaleX * (lx - inverse.sizeW / 2);
  const ay = inverse.scaleY * (ly - inverse.sizeH / 2);
  return {
    x: inverse.center.x + inverse.cos * ax - inverse.sin * ay,
    y: inverse.center.y + inverse.sin * ax + inverse.cos * ay,
  };
}
