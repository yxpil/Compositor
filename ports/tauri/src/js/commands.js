// The command palette (⌘K / Ctrl+K): a filterable list of every document, layer,
// tool and view command. Commands carry their shortcut so the palette doubles as
// the shortcut cheat sheet.

import { session, emit } from "./state.js";
import { FILTER_KINDS } from "./format.js";
import { documentOps } from "./ops.js";
import { selectTool, setZoom, fitZoom } from "./tools.js";

let registry = [];

export const registerCommands = {
  install(sessionRef, els) {
    registry = buildRegistry(els);
  },

  open() {
    const existing = document.getElementById("paletteOverlay");
    if (existing) {
      existing.remove();
      return;
    }
    const overlay = document.createElement("div");
    overlay.id = "paletteOverlay";
    const palette = document.createElement("div");
    palette.className = "palette";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type a command…";
    input.className = "palette-input";
    const list = document.createElement("ul");
    list.className = "palette-list";
    palette.append(input, list);
    overlay.appendChild(palette);
    document.body.appendChild(overlay);

    const render = () => {
      const query = input.value.trim().toLowerCase();
      list.replaceChildren();
      for (const command of registry) {
        if (query && !command.title.toLowerCase().includes(query)) continue;
        const item = document.createElement("li");
        item.textContent = command.title;
        if (command.shortcut) {
          const hint = document.createElement("span");
          hint.className = "palette-shortcut";
          hint.textContent = command.shortcut;
          item.appendChild(hint);
        }
        item.addEventListener("click", () => {
          overlay.remove();
          command.run();
        });
        list.appendChild(item);
      }
      list.firstChild?.classList.add("selected");
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") overlay.remove();
      if (event.key === "Enter") {
        const first = list.querySelector("li:not([hidden])") || list.firstChild;
        if (first) {
          overlay.remove();
          first.click();
        }
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...list.querySelectorAll("li")];
        const index = items.findIndex((item) => item.classList.contains("selected"));
        items[index]?.classList.remove("selected");
        const next = event.key === "ArrowDown"
          ? items[Math.min(items.length - 1, index + 1)]
          : items[Math.max(0, index - 1)];
        next?.classList.add("selected");
      }
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    input.focus();
    render();
  },
};

function buildRegistry(els) {
  const commands = [];
  const add = (title, run, shortcut) => commands.push({ title, run, shortcut });
  const needsDoc = (run) => () => {
    if (!session.doc) {
      session.setStatus?.("Open a project first.", true);
      return;
    }
    run();
  };

  add("New Project…", () => documentOps.newProject());
  add("Open Folder…", () => els.pickFolder.click());
  add("Refresh Projects", () => session.app?.refresh());
  add("Import Image…", () => els.importImages.click());
  add("Save Project", needsDoc(() => session.app?.save()), "⌘S");
  add("Export PNG", needsDoc(() => session.app?.exportImage("png")), "⇧⌘E");
  add("Export JPEG…", needsDoc(() => documentOps.exportJpegSheet()), "⇧⌥⌘S");
  add("Close Project", needsDoc(() => documentOps.closeProject()), "⌘W");
  add("Undo", needsDoc(() => session.app?.els.undo.click()), "⌘Z");
  add("Redo", needsDoc(() => session.app?.els.redo.click()), "⇧⌘Z");

  add("New Layer", needsDoc(() => documentOps.addLayer()), "⇧⌘N");
  add("New Group", needsDoc(() => documentOps.addGroup()));
  add("Duplicate Layer / Layer via Copy", needsDoc(() =>
    session.selection ? documentOps.layerViaCopy() : documentOps.duplicateLayer()), "⌘J");
  add("Delete Layer", needsDoc(() => documentOps.deleteLayer()));
  add("Merge Down", needsDoc(() => documentOps.mergeDown()), "⌘E");
  add("Add Mask", needsDoc(() => documentOps.addMask()));
  add("Group Selected Layers", needsDoc(() => documentOps.groupSelection()), "⌘G");
  add("Ungroup Layers", needsDoc(() => documentOps.ungroup()), "⇧⌘G");
  add("Move Out of Folder", needsDoc(() => documentOps.moveLayerOut()));
  add("Create/Release Clipping Mask", needsDoc(() => documentOps.toggleClippingMask()), "⌥⌘G");
  add("Rename Layer…", needsDoc(() => documentOps.renameLayer()));
  add("Toggle Layer Visibility", needsDoc(() => documentOps.toggleVisibility()));
  add("Move Layer Up", needsDoc(() => documentOps.moveLayerUp()), "]");
  add("Move Layer Down", needsDoc(() => documentOps.moveLayerDown()), "[");

  add("Select All", needsDoc(() => documentOps.selectAll()), "⌘A");
  add("Deselect", needsDoc(() => documentOps.deselect()), "⌘D");
  add("Inverse Selection", needsDoc(() => documentOps.inverseSelection()), "⇧⌘I");
  add("Select Layer's Pixels", needsDoc(() => documentOps.loadLayerSelection()));
  add("Select Color Range…", needsDoc(() => documentOps.colorRange()));
  add("Select Mask's Black Areas", needsDoc(() => documentOps.loadMaskSelection()));
  add("Expand Selection…", needsDoc(() => documentOps.expandSelection()));
  add("Contract Selection…", needsDoc(() => documentOps.contractSelection()));
  add("Feather Selection…", needsDoc(() => documentOps.featherSelection()));

  add("Cut", needsDoc(() => documentOps.cut()), "⌘X");
  add("Copy", needsDoc(() => documentOps.copy()), "⌘C");
  add("Copy Merged", needsDoc(() => documentOps.copyMerged()), "⇧⌘C");
  add("Paste", needsDoc(() => documentOps.paste()), "⌘V");
  add("Fill with Foreground Color", needsDoc(() => documentOps.fillSelection("Foreground")), "⌥⌫");
  add("Fill with Background Color", needsDoc(() => documentOps.fillSelection("Background")), "⌘⌫");
  add("Clear Selection Pixels", needsDoc(() => documentOps.clearSelectedPixels()));
  add("Content-Aware Fill…", needsDoc(() => documentOps.contentAwareFill()), "⇧⌫");

  for (const kind of ["Curves", "Levels", "Hue/Saturation", "Black & White", "Color Balance", "Exposure", "Gradient Map", "Grain"]) {
    add(`Adjust Pixels: ${kind}…`, needsDoc(() => documentOps.beginAdjustment(kind)));
  }
  add("Invert Pixels", needsDoc(() => documentOps.invertPixels()), "⌘I");
  add("New Adjustment Layer…", needsDoc(() => documentOps.newAdjustmentLayerSheet()));
  add("Edit Adjustment…", needsDoc(() => documentOps.editAdjustment()));
  for (const kind of FILTER_KINDS) {
    add(`Filter: ${kind}…`, needsDoc(() => documentOps.applyFilter(kind)));
  }

  add("Canvas Size…", needsDoc(() => documentOps.canvasSize()), "⌥⌘C");
  add("Image Size…", needsDoc(() => documentOps.imageSize()), "⌥⌘I");
  add("Trim…", needsDoc(() => documentOps.trim()));
  add("Rotate Canvas 90° Clockwise", needsDoc(() => documentOps.rotateCanvas(90)));
  add("Rotate Canvas 90° Counterclockwise", needsDoc(() => documentOps.rotateCanvas(-90)));
  add("Flip Canvas Horizontal", needsDoc(() => documentOps.flipCanvas("Horizontal")));
  add("Flip Canvas Vertical", needsDoc(() => documentOps.flipCanvas("Vertical")));
  add("Flip Layer Horizontal", needsDoc(() => documentOps.flipLayer("Horizontal")));
  add("Flip Layer Vertical", needsDoc(() => documentOps.flipLayer("Vertical")));

  const toolShortcuts = {
    move: "V", marquee: "M", lasso: "L", wand: "W", crop: "C", brush: "B",
    spotHealing: "J", cloneStamp: "S", blur: "R", gradient: "G", shape: "U",
    type: "T", eyedropper: "I", hand: "H", zoom: "Z",
  };
  for (const [tool, shortcut] of Object.entries(toolShortcuts)) {
    add(`Tool: ${tool}`, () => selectTool(tool), shortcut);
  }

  add("Zoom In", needsDoc(() => setZoom(session.viewport.zoom * 1.25)), "+");
  add("Zoom Out", needsDoc(() => setZoom(session.viewport.zoom / 1.25)), "−");
  add("Fit on Screen", needsDoc(() => fitZoom()), "⌘0");
  add("Actual Pixels", needsDoc(() => setZoom(1)), "⌘1");
  add("Canvas Only", () => document.body.classList.toggle("canvas-only"), "F");
  add("Toggle Grid", needsDoc(() => {
    session.showGrid = !session.showGrid;
    emit("document");
  }));
  add("Toggle Guides", needsDoc(() => {
    session.showGuides = !session.showGuides;
    emit("document");
  }));
  return commands;
}
