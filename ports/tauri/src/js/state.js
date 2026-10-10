// Session state: the open document, undo history and editor settings.
// Undo follows the macOS app's DocumentHistory: every edit pushes a manifest snapshot
// plus swap pairs for the assets its pixel edits replaced. Canvases are immutable —
// a pixel edit writes a new canvas and records {file, before, after}; undo and redo
// only swap references back, so untouched pixels are shared and history stays cheap.

import { createRenderer } from "./render.js";
import { validateManifest } from "./format.js";

export const session = {
  root: "",
  projects: [],
  // The open document.
  doc: null,          // { path, manifest, images: Map(file -> ImageBitmap|HTMLImageElement) }
  dirty: false,
  // Editor settings (session-level, not serialized).
  tool: "move",
  activeLayerId: null,
  selectedLayerIds: new Set(),
  foregroundColor: { red: 0, green: 0, blue: 0 },
  backgroundColor: { red: 1, green: 1, blue: 1 },
  brush: { diameter: 40, hardness: 1, opacity: 1, smoothing: 0, blurRadius: 5, erasing: false, healing: false, healingMode: "Content-Aware" },
  clone: { aligned: true, sample: "This Layer" },
  wand: { tolerance: 32, sampleSize: 1, contiguous: true, sampleAllLayers: false, mode: "Wand" },
  selectionMode: "New",           // New | Add | Subtract (Shift adds, Alt subtracts while dragging)
  lassoKind: "Freehand",          // Freehand | Polygonal
  marqueeKind: "Rectangle",       // Rectangle | Ellipse
  blurMode: "Liquify",            // Liquify | Blur | Smudge (the blur tool's modes)
  cropRatioChoice: "Free",        // Free | Original | 1:1 | 4:3 | 3:4 | 16:9 | 9:16
  healMode: "Content-Aware",      // Content-Aware | Very Smooth | Proximity Match
  gradient: { shape: "Linear", style: "Foreground to Background", reversed: false, opacity: 1 },
  shape: { kind: "Rectangle", cornerRadius: 0, lineWidth: 4 },
  textDefaults: null,
  viewport: { zoom: 1, offsetX: 0, offsetY: 0 },
  showGrid: false,
  gridSize: 50,
  showGuides: true,
  showRulers: false,
  showPixelGrid: false,
  snapEnabled: true,
  snapToGuides: true,
  snapToGrid: false,
  snapToLayers: false,
  snapToDocumentBounds: true,
  locksGuides: false,
  maskTarget: "image",          // image | mask: what the tools paint on
  selection: null,              // { x, y, width, height } in document pixels
  rasterizers: {},              // text/shape live rasters installed by tools.js
  history: [],
  historyIndex: -1,
  listeners: new Map(),
};

export function on(event, handler) {
  if (!session.listeners.has(event)) session.listeners.set(event, new Set());
  session.listeners.get(event).add(handler);
}

export function emit(event, payload) {
  const handlers = session.listeners.get(event);
  if (handlers) for (const handler of handlers) handler(payload);
}

export function doc() { return session.doc; }

export function manifest() { return session.doc ? session.doc.manifest : null; }

export function layerById(id) {
  const layers = manifest()?.layers;
  return layers ? layers.find((layer) => layer.id === id) || null : null;
}

export function activeLayer() {
  return session.activeLayerId ? layerById(session.activeLayerId) : null;
}

export function setActiveLayer(id) {
  session.activeLayerId = id;
  session.selectedLayerIds = new Set(id ? [id] : []);
  emit("selection");
}

// ---- Undo history ----
// A history entry stores the manifest, the active layer, the selection reference and
// the edit's asset swap pairs. Pixels never snapshot: a pixel edit swaps in a new
// canvas (replaceAsset) and the pair {file, before, after} is enough to walk back.

const HISTORY_LIMIT = 100;
let nextAssetId = 1;

// Tags a canvas so the effects cache can key on it (render.js). Every replacement
// gets a fresh tag, so a stale cache entry can never be reused.
export function tagAsset(canvas) {
  if (canvas && canvas.__assetId === undefined) canvas.__assetId = `a${nextAssetId++}`;
  return canvas;
}

function touchAsset(file) {
  if (!session.doc) return;
  if (!session.doc.dirtyAssets) session.doc.dirtyAssets = new Set();
  session.doc.dirtyAssets.add(file);
}

function snapshotState(swaps = []) {
  return {
    manifest: JSON.parse(JSON.stringify(session.doc.manifest)),
    path: session.doc.path,
    activeLayerId: session.activeLayerId,
    selection: session.selection, // immutable object, shared by reference
    swaps,
  };
}

export function beginEdit(label) {
  session.pendingEdit = { label, swaps: [] };
}

export function endEdit() {
  const edit = session.pendingEdit;
  session.pendingEdit = null;
  if (!edit) return;
  // Truncate any redo tail and append the post-edit state. history[0] is the
  // untouched document (pushInitialHistory), so undo restores the previous entry
  // and redo replays the current one.
  session.history = session.history.slice(0, session.historyIndex + 1);
  session.history.push({ label: edit.label, state: snapshotState(edit.swaps) });
  if (session.history.length > HISTORY_LIMIT) session.history.shift();
  session.historyIndex = session.history.length - 1;
  emit("history");
}

// Seeds the history with the just-opened / just-created document so the first
// edit is undoable back to it.
export function pushInitialHistory(label = "Open") {
  session.history = [{ label, state: snapshotState() }];
  session.historyIndex = 0;
  emit("history");
}

export function cancelEdit() {
  session.pendingEdit = null;
}

export function canUndo() { return session.historyIndex > 0; }
export function canRedo() { return session.historyIndex < session.history.length - 1; }

function applySwaps(swaps, which) {
  for (const swap of swaps) {
    const canvas = swap[which];
    if (canvas) {
      session.doc.images.set(swap.file, canvas);
      touchAsset(swap.file);
    }
  }
}

export function undo() {
  if (!canUndo()) return false;
  const entry = session.history[session.historyIndex];
  session.historyIndex -= 1;
  applySwaps(entry.state.swaps, "before"); // after -> before walks the edit back
  restoreHistory();
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  session.historyIndex += 1;
  const entry = session.history[session.historyIndex];
  applySwaps(entry.state.swaps, "after"); // before -> after replays it
  restoreHistory();
  return true;
}

function restoreHistory() {
  const entry = session.history[session.historyIndex];
  if (!entry) return;
  session.doc.manifest = JSON.parse(JSON.stringify(entry.state.manifest));
  validateManifest(session.doc.manifest);
  session.doc.path = entry.state.path;
  session.activeLayerId = entry.state.activeLayerId;
  session.selectedLayerIds = new Set(session.activeLayerId ? [session.activeLayerId] : []);
  session.selection = entry.state.selection || null;
  session.dirty = true;
  emit("history");
  emit("document");
}

// Stores a writable copy of an asset's pixels under a new name (brush strokes, filters).
export function adoptAsset(file, canvas) {
  tagAsset(canvas);
  session.doc.images.set(file, canvas);
  touchAsset(file);
  return file;
}

// Immutable-canvas pixel edit: installs `newCanvas` as `file`'s pixels and records
// the swap in the open edit so undo/redo can walk it back. Consecutive replacements
// of one file in a single edit coalesce — the pair keeps the state at edit start.
export function replaceAsset(file, newCanvas) {
  if (!session.doc || !file) return file;
  const before = session.doc.images.get(file);
  if (before === newCanvas) return file;
  if (session.pendingEdit) {
    const existing = session.pendingEdit.swaps.find((swap) => swap.file === file);
    if (existing) existing.after = newCanvas;
    else session.pendingEdit.swaps.push({ file, before, after: newCanvas });
  }
  tagAsset(newCanvas);
  session.doc.images.set(file, newCanvas);
  touchAsset(file);
  return file;
}

export function markDirty() {
  session.dirty = true;
  emit("document");
}

// ---- Rendering ----

export function renderDocument(target) {
  if (!session.doc) return null;
  const hooks = {
    // Live text/shape layers without a cached PNG rasterize from their metadata.
    rasterize: (layer) => {
      const kind = layer.shape ? "shape" : "text";
      return session.rasterizers?.[kind] ? session.rasterizers[kind](layer) : null;
    },
  };
  const renderer = createRenderer(session.doc.manifest, session.doc.images, hooks);
  const canvas = renderer.render();
  if (target) {
    const context = target.getContext("2d");
    target.width = canvas.width;
    target.height = canvas.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(canvas, 0, 0);
  }
  return canvas;
}

export function invalidateCaches() {
  if (!session.doc) return;
  // Called after pixel edits: nothing cached across frames except mask luma, which
  // only changes when an asset file is rewritten (callers re-render anyway).
  emit("document");
}
