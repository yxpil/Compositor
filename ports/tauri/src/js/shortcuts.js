// Keyboard shortcuts, following the macOS app's bindings: Photoshop-style tool
// letters, undo/redo/save/export, command palette, zoom controls, nudge arrows.

import { session, activeLayer, canUndo, canRedo, undo, redo, emit } from "./state.js";
import { documentOps } from "./ops.js";
import { selectTool, setZoom, fitZoom } from "./tools.js";
import { registerCommands } from "./commands.js";

const TOOL_KEYS = {
  v: "move", m: "marquee", l: "lasso", w: "wand", c: "crop", b: "brush",
  j: "spotHealing", s: "cloneStamp", r: "blur", g: "gradient", u: "shape",
  t: "type", i: "eyedropper", h: "hand", z: "zoom",
};

const modifier = (event) => (event.ctrlKey || event.metaKey);

export function installShortcuts() {
  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
        || target.isContentEditable)) {
      return;
    }
    if (document.getElementById("paletteOverlay")) {
      return; // the palette handles its own keys
    }

    const key = event.key.toLowerCase();
    // New and Open work without a document; everything else needs one.
    if (!session.doc && !(modifier(event) && (key === "n" || key === "o"))) return;
    if (modifier(event)) {
      switch (key) {
        case "z":
          event.preventDefault();
          if (event.shiftKey ? canRedo() : canUndo()) event.shiftKey ? redo() : undo();
          return;
        case "y":
          event.preventDefault();
          if (canRedo()) redo();
          return;
        case "s":
          event.preventDefault();
          if (event.shiftKey && event.altKey) documentOps.exportJpegSheet();
          else session.app?.save();
          return;
        case "e":
          event.preventDefault();
          if (event.shiftKey) session.app?.exportImage("png");
          else documentOps.mergeDown();
          return;
        case "k":
          event.preventDefault();
          registerCommands.open();
          return;
        case "a":
          event.preventDefault();
          documentOps.selectAll();
          return;
        case "d":
          event.preventDefault();
          documentOps.deselect();
          return;
        case "i":
          event.preventDefault();
          if (event.shiftKey) documentOps.inverseSelection();
          else documentOps.invertPixels();
          return;
        case "m":
          event.preventDefault();
          documentOps.beginAdjustment("Curves");
          return;
        case "l":
          event.preventDefault();
          documentOps.beginAdjustment("Levels");
          return;
        case "u":
          event.preventDefault();
          documentOps.beginAdjustment("Hue/Saturation");
          return;
        case "c":
          event.preventDefault();
          if (event.altKey) documentOps.canvasSize();
          else if (event.shiftKey) documentOps.copyMerged();
          else documentOps.copy();
          return;
        case "x":
          event.preventDefault();
          documentOps.cut();
          return;
        case "v":
          event.preventDefault();
          documentOps.paste();
          return;
        case "n":
          event.preventDefault();
          if (event.shiftKey) documentOps.addLayer();
          else documentOps.newProject();
          return;
        case "o":
          event.preventDefault();
          document.getElementById("pickFolder")?.click();
          return;
        case "w":
          event.preventDefault();
          documentOps.closeProject();
          return;
        case "g":
          event.preventDefault();
          if (event.altKey) documentOps.toggleClippingMask();
          else if (event.shiftKey) documentOps.ungroup();
          else documentOps.groupSelection();
          return;
        case "j":
          event.preventDefault();
          // ⌘J: Layer via Copy with a selection, Duplicate Layer without (the macOS binding).
          if (event.shiftKey || event.altKey) session.app?.exportImage("jpeg");
          else if (session.selection) documentOps.layerViaCopy();
          else documentOps.duplicateLayer();
          return;
        case "0":
          event.preventDefault();
          fitZoom();
          return;
        case "1":
          event.preventDefault();
          setZoom(1);
          return;
        case "=":
        case "+":
          event.preventDefault();
          setZoom(session.viewport.zoom * 1.25);
          return;
        case "-":
          event.preventDefault();
          setZoom(session.viewport.zoom / 1.25);
          return;
        case "'":
          event.preventDefault();
          session.showGrid = !session.showGrid;
          emit("document");
          return;
        case ";":
          event.preventDefault();
          if (event.shiftKey) documentOps.gridSettings();
          else { session.showGuides = !session.showGuides; emit("document"); }
          return;
        default:
          return;
      }
    }

    switch (event.key) {
      case "Delete":
      case "Backspace":
        event.preventDefault();
        // Photoshop-style: ⌥⌫ fills with the foreground, ⌘⌫ with the background,
        // ⇧⌫ content-aware fills, plain delete clears selected pixels or deletes the layer.
        if (event.altKey) documentOps.fillSelection("Foreground");
        else if (modifier(event)) documentOps.fillSelection("Background");
        else if (event.shiftKey) documentOps.contentAwareFill();
        else if (session.selection) documentOps.clearSelectedPixels();
        else documentOps.deleteLayer();
        return;
      case "f":
        event.preventDefault();
        document.body.classList.toggle("canvas-only");
        return;
      case "]":
        documentOps.moveLayerUp();
        return;
      case "[":
        documentOps.moveLayerDown();
        return;
      case "+":
      case "=":
        setZoom(session.viewport.zoom * 1.25);
        return;
      case "-":
        setZoom(session.viewport.zoom / 1.25);
        return;
      case "Escape":
        session.selection = null;
        emit("selection");
        return;
      default:
        break;
    }

    if (TOOL_KEYS[key]) {
      selectTool(TOOL_KEYS[key]);
      return;
    }

    const layer = activeLayer();
    if (layer && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      session.beginEdit?.("Nudge");
      if (event.key === "ArrowLeft") layer.transform.origin.x -= step;
      if (event.key === "ArrowRight") layer.transform.origin.x += step;
      if (event.key === "ArrowUp") layer.transform.origin.y -= step;
      if (event.key === "ArrowDown") layer.transform.origin.y += step;
      session.endEdit?.();
      session.markDirty();
    }
  });
}
