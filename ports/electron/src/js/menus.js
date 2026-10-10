// The menu bar: dropdowns mirroring the macOS app's command structure
// (CompositorApp.swift .commands). Every item runs a documentOps command or an
// app action; ops guard their own preconditions and report through the status bar.

import { session, undo, redo, emit, activeLayer } from "./state.js";
import { ADJUSTMENT_KINDS, FILTER_KINDS } from "./format.js";
import { documentOps } from "./ops.js";
import { fitZoom, setZoom } from "./tools.js";

// FILTER_KINDS already excludes the image adjustments; Content-Aware Fill lives
// under Edit in the macOS app, so it's left out of the Filter menu too.
const FILTER_MENU_KINDS = FILTER_KINDS.filter((kind) => kind !== "Content-Aware Fill");

const RECENT_KEY = "compositor.recentProjects";
const RECENT_LIMIT = 8;

export function recentProjects() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecentProject(path) {
  if (!path) return;
  const list = [path, ...recentProjects().filter((entry) => entry !== path)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode): the menu just stays empty.
  }
}

function openRecentItems() {
  const list = recentProjects();
  if (!list.length) return [];
  return [
    { divider: true },
    ...list.map((path) => ({
      title: `Open Recent — ${path.replace(/^.*[\\/]/, "").replace(/\.comp$/i, "")}`,
      run: () => session.openProject?.(path),
    })),
    { title: "Clear Menu", run: () => { try { localStorage.removeItem(RECENT_KEY); } catch {} } },
  ];
}

function toggleFlag(name) {
  session[name] = !session[name];
  emit("document");
}

const MENUS = [
  {
    id: "menu-file",
    // Dynamic: the Open Recent section follows localStorage.
    items: () => [
      { title: "New Canvas…", key: "⌘N", run: () => documentOps.newProject() },
      { title: "Open Project…", key: "⌘O", run: () => document.getElementById("pickFolder")?.click() },
      ...openRecentItems(),
      { title: "Import Images…", run: () => document.getElementById("importImages")?.click() },
      { divider: true },
      { title: "Save", key: "⌘S", run: () => session.app?.save() },
      { title: "Save As…", key: "⇧⌘S", run: () => session.app?.saveAs() },
      { divider: true },
      { title: "Export PNG…", key: "⇧⌘E", run: () => session.app?.exportImage("png") },
      { title: "Export JPEG…", key: "⇧⌥⌘S", run: () => documentOps.exportJpegSheet() },
      { divider: true },
      { title: "Close Project", key: "⌘W", run: () => documentOps.closeProject() },
    ],
  },
  {
    id: "menu-edit",
    items: [
      { title: "Undo", key: "⌘Z", run: () => undo() },
      { title: "Redo", key: "⇧⌘Z", run: () => redo() },
      { divider: true },
      { title: "Cut", key: "⌘X", run: () => documentOps.cut() },
      { title: "Copy", key: "⌘C", run: () => documentOps.copy() },
      { title: "Copy Merged", key: "⇧⌘C", run: () => documentOps.copyMerged() },
      { title: "Paste", key: "⌘V", run: () => documentOps.paste() },
      { divider: true },
      { title: "Fill with Foreground Color", key: "⌥⌫", run: () => documentOps.fillSelection("Foreground") },
      { title: "Fill with Background Color", key: "⌘⌫", run: () => documentOps.fillSelection("Background") },
      { title: "Clear Selection Pixels", run: () => documentOps.clearSelectedPixels() },
      { title: "Content-Aware Fill…", key: "⇧⌫", run: () => documentOps.contentAwareFill() },
    ],
  },
  {
    id: "menu-select",
    items: [
      { title: "All", key: "⌘A", run: () => documentOps.selectAll() },
      { title: "Deselect", key: "⌘D", run: () => documentOps.deselect() },
      { title: "Inverse", key: "⇧⌘I", run: () => documentOps.inverseSelection() },
      { title: "Layer's Pixels", run: () => documentOps.loadLayerSelection() },
      { title: "Subject", run: () => documentOps.selectSubject() },
      { title: "Color Range…", run: () => documentOps.colorRange() },
      { title: "Mask's Black Areas", run: () => documentOps.loadMaskSelection() },
      { divider: true },
      { title: "Expand…", run: () => documentOps.expandSelection() },
      { title: "Contract…", run: () => documentOps.contractSelection() },
      { title: "Feather…", run: () => documentOps.featherSelection() },
    ],
  },
  {
    id: "menu-image",
    items: [
      { title: "Curves…", key: "⌘M", run: () => documentOps.beginAdjustment("Curves") },
      { title: "Levels…", key: "⌘L", run: () => documentOps.beginAdjustment("Levels") },
      { title: "Hue/Saturation…", key: "⌘U", run: () => documentOps.beginAdjustment("Hue/Saturation") },
      { title: "Black & White…", run: () => documentOps.beginAdjustment("Black & White") },
      { title: "Color Balance…", run: () => documentOps.beginAdjustment("Color Balance") },
      { title: "Exposure…", run: () => documentOps.beginAdjustment("Exposure") },
      { title: "Gradient Map…", run: () => documentOps.beginAdjustment("Gradient Map") },
      { title: "Grain…", run: () => documentOps.beginAdjustment("Grain") },
      {
        title: () => (activeLayer()?.maskFile && session.maskTarget === "mask" ? "Invert Mask" : "Invert"),
        key: "⌘I",
        run: () => documentOps.invertPixels(),
      },
      { divider: true },
      { title: "Canvas Size…", key: "⌥⌘C", run: () => documentOps.canvasSize() },
      { title: "Image Size…", key: "⌥⌘I", run: () => documentOps.imageSize() },
      { title: "Trim…", run: () => documentOps.trim() },
      { divider: true },
      { title: "Rotate Canvas 90° Clockwise", run: () => documentOps.rotateCanvas(90) },
      { title: "Rotate Canvas 90° Counterclockwise", run: () => documentOps.rotateCanvas(-90) },
      { title: "Flip Canvas Horizontal", run: () => documentOps.flipCanvas("Horizontal") },
      { title: "Flip Canvas Vertical", run: () => documentOps.flipCanvas("Vertical") },
    ],
  },
  {
    id: "menu-layer",
    items: [
      { title: "New Adjustment Layer…", run: () => documentOps.newAdjustmentLayerSheet() },
      { title: "Edit Adjustment…", run: () => documentOps.editAdjustment() },
      { divider: true },
      // The macOS title flips with the selection: Layer via Copy vs Duplicate Layer.
      {
        title: () => (session.selection ? "Layer via Copy" : "Duplicate Layer"),
        key: "⌘J",
        run: () => (session.selection ? documentOps.layerViaCopy() : documentOps.duplicateLayer()),
      },
      { divider: true },
      {
        title: () => (activeLayer()?.maskSourceID ? "Release Clipping Mask" : "Create Clipping Mask"),
        key: "⌥⌘G",
        run: () => documentOps.toggleClippingMask(),
      },
      { divider: true },
      { title: "Group Selected Layers", key: "⌘G", run: () => documentOps.groupSelection() },
      { title: "Ungroup Layers", key: "⇧⌘G", run: () => documentOps.ungroup() },
      { title: "Move Out of Folder", run: () => documentOps.moveLayerOut() },
      { title: "New Blank Layer", key: "⇧⌘N", run: () => documentOps.addLayer() },
      { title: "Rename Layer…", run: () => documentOps.renameLayer() },
      {
        title: () => (activeLayer()?.isVisible === false ? "Show Layer" : "Hide Layer"),
        run: () => documentOps.toggleVisibility(),
      },
      { divider: true },
      { title: "Move Layer Up", key: "]", run: () => documentOps.moveLayerUp() },
      { title: "Move Layer Down", key: "[", run: () => documentOps.moveLayerDown() },
      { title: "Merge Layers", key: "⌘E", run: () => documentOps.mergeDown() },
      { divider: true },
      { title: "Flip Layer Horizontal", run: () => documentOps.flipLayer("Horizontal") },
      { title: "Flip Layer Vertical", run: () => documentOps.flipLayer("Vertical") },
      { divider: true },
      {
        title: () => (session.selectedLayerIds?.size > 1 ? "Delete Layers"
          : activeLayer()?.maskFile && session.maskTarget === "mask" ? "Delete Layer Mask" : "Delete Layer"),
        run: () => documentOps.deleteLayer(),
      },
    ],
  },
  {
    id: "menu-filter",
    items: FILTER_MENU_KINDS.map((kind) => ({ title: `${kind}…`, run: () => documentOps.applyFilter(kind) })),
  },
  {
    id: "menu-view",
    items: [
      { title: "Command Palette…", key: "⌘K", run: () => document.getElementById("commandPalette")?.click() },
      { title: "Canvas Only (F)", run: () => document.body.classList.toggle("canvas-only") },
      { divider: true },
      { title: "Fit Canvas", key: "⌘0", run: () => fitZoom() },
      { title: "Actual Pixels", key: "⌘1", run: () => setZoom(1) },
      { title: "Zoom In", key: "⌘+", run: () => setZoom(session.viewport.zoom * 1.25) },
      { title: "Zoom Out", key: "⌘−", run: () => setZoom(session.viewport.zoom / 1.25) },
      {
        title: () => `${session.showPixelGrid ? "✓ " : ""}Pixel Grid (800% and above)`,
        run: () => toggleFlag("showPixelGrid"),
      },
      { divider: true },
      { title: () => `${session.showGrid ? "✓ " : ""}Grid`, key: "⌘'", run: () => toggleFlag("showGrid") },
      { title: () => `${session.showGuides ? "✓ " : ""}Guides`, key: "⌘;", run: () => toggleFlag("showGuides") },
      { title: "Grid Settings…", run: () => documentOps.gridSettings() },
      { divider: true },
      { title: () => `${session.snapEnabled ? "✓ " : ""}Snap`, key: "⇧⌘;", run: () => toggleFlag("snapEnabled") },
      { title: () => `${session.snapToGuides ? "✓ " : ""}Snap to Guides`, run: () => toggleFlag("snapToGuides") },
      { title: () => `${session.snapToGrid ? "✓ " : ""}Snap to Grid`, run: () => toggleFlag("snapToGrid") },
      { title: () => `${session.snapToLayers ? "✓ " : ""}Snap to Layers`, run: () => toggleFlag("snapToLayers") },
      { title: () => `${session.snapToDocumentBounds ? "✓ " : ""}Snap to Document Bounds`, run: () => toggleFlag("snapToDocumentBounds") },
      { divider: true },
      { title: () => `${session.locksGuides ? "✓ " : ""}Lock Guides`, key: "⌥;", run: () => toggleFlag("locksGuides") },
      { title: "Clear Guides", run: () => documentOps.clearGuides() },
    ],
  },
  {
    id: "menu-help",
    items: [
      { title: "Command Palette…", key: "⌘K", run: () => document.getElementById("commandPalette")?.click() },
    ],
  },
];

let openDropdown = null;

function closeAll() {
  if (openDropdown) {
    openDropdown.classList.remove("open");
    openDropdown = null;
  }
}

function itemsOf(menu) {
  return typeof menu.items === "function" ? menu.items() : menu.items;
}

// Fills (or refills) a dropdown from the menu's item list. Dynamic menus —
// File's Open Recent, the flipping titles — rebuild on every open.
function fillDropdown(dropdown, menu) {
  dropdown.replaceChildren();
  for (const item of itemsOf(menu)) {
    if (item.divider) {
      const divider = document.createElement("div");
      divider.className = "menu-divider";
      dropdown.appendChild(divider);
      continue;
    }
    const row = document.createElement("button");
    row.className = "menu-item";
    const title = document.createElement("span");
    title.textContent = typeof item.title === "function" ? item.title() : item.title;
    row.appendChild(title);
    if (item.key) {
      const key = document.createElement("span");
      key.className = "menu-key";
      key.textContent = item.key;
      row.appendChild(key);
    }
    row.addEventListener("click", () => {
      closeAll();
      item.run();
    });
    dropdown.appendChild(row);
  }
}

export function installMenus() {
  for (const menu of MENUS) {
    const host = document.getElementById(menu.id);
    if (!host) continue;
    const dropdown = document.createElement("div");
    dropdown.className = "dropdown";
    fillDropdown(dropdown, menu);
    host.appendChild(dropdown);
    host.addEventListener("click", (event) => {
      event.stopPropagation();
      const wasOpen = openDropdown === dropdown;
      closeAll();
      if (!wasOpen) {
        // Refresh dynamic content (Open Recent, flipping titles) on every open.
        fillDropdown(dropdown, menu);
        dropdown.classList.add("open");
        openDropdown = dropdown;
      }
    });
  }
  document.addEventListener("click", closeAll);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });
}
