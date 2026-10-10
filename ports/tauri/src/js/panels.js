// Layers panel: rows with visibility, opacity, blend, name and nesting indent.
// Mirrors the macOS LayersPanel semantics: display is topmost-first, rows show
// group/adjustment/text/mask tags, double-click renames, click selects.

import { session, emit, doc, manifest, layerById } from "./state.js";
import { BLEND_MODES, FOLDER_OPACITY_VERSION } from "./format.js";

function layerDepth(layer) {
  let depth = 0;
  let current = layer.parentID ? layerById(layer.parentID) : null;
  while (current) { depth += 1; current = current.parentID ? layerById(current.parentID) : null; }
  return depth;
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

function siblingHead(index) {
  const layers = manifest().layers;
  const parent = layers[index].parentID;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (layers[previous].parentID === parent) return previous;
  }
  return -1;
}

export const panelBuilder = {
  install(session) {
    session.panel = { moveLayer, subtreeEnd, isDescendantOf, siblingHead, layerDepth };
  },

  renderLayers(els) {
    const list = els.layerList || els;
    const m = manifest();
    list.replaceChildren();
    if (!m) return;
    const layers = m.layers;
    // Display topmost first.
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      list.appendChild(layerRow(layers[index], index));
    }
    if (!layers.length) {
      const hint = document.createElement("li");
      hint.className = "empty-hint";
      hint.textContent = "This project has no layers.";
      list.appendChild(hint);
    }
  },
};

function layerRow(layer, index) {
  const row = document.createElement("li");
  row.className = "layer-row";
  row.dataset.layerId = layer.id;
  row.dataset.index = String(index);
  row.style.paddingLeft = `${10 + layerDepth(layer) * 16}px`;
  if (session.activeLayerId === layer.id) row.classList.add("active");

  const visibility = document.createElement("input");
  visibility.type = "checkbox";
  visibility.checked = layer.isVisible !== false;
  visibility.title = "Visible";
  visibility.className = "layer-visible";
  visibility.addEventListener("change", () => {
    session.beginEdit("Toggle Visibility");
    layer.isVisible = visibility.checked;
    session.endEdit();
    session.markDirty();
  });

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = 0;
  opacity.max = 100;
  opacity.value = Math.round((typeof layer.opacity === "number" ? layer.opacity : 1) * 100);
  opacity.title = "Opacity";
  opacity.className = "layer-opacity";
  opacity.addEventListener("change", () => {
    session.beginEdit("Opacity");
    layer.opacity = Number(opacity.value) / 100;
    if (layer.isGroup && manifest().version < FOLDER_OPACITY_VERSION) {
      manifest().version = FOLDER_OPACITY_VERSION;
    } else if (manifest().version < 3) {
      manifest().version = 3;
    }
    session.endEdit();
    session.markDirty();
  });

  const blend = document.createElement("select");
  blend.className = "layer-blend";
  blend.title = "Blend mode";
  for (const mode of BLEND_MODES) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    blend.appendChild(option);
  }
  blend.value = layer.blendMode || "Normal";
  blend.addEventListener("change", () => {
    session.beginEdit("Blend Mode");
    layer.blendMode = blend.value;
    if (manifest().version < 3) manifest().version = 3;
    session.endEdit();
    session.markDirty();
  });

  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = layer.name || "Layer";
  name.title = `${layer.name || "Layer"} (${layer.id})`;
  for (const tag of tags(layer)) {
    name.appendChild(document.createTextNode(" "));
    name.appendChild(tag);
  }
  name.addEventListener("dblclick", () => {
    const input = document.createElement("input");
    input.value = layer.name || "";
    input.className = "layer-rename";
    name.replaceChildren(input);
    input.focus();
    input.select();
    const commit = () => {
      session.beginEdit("Rename Layer");
      layer.name = input.value.trim() || "Layer";
      session.endEdit();
      session.markDirty();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") panelBuilder.renderLayers(document.getElementById("layerList"));
    });
    input.addEventListener("blur", commit);
  });

  const up = document.createElement("button");
  up.className = "move";
  up.textContent = "↑";
  up.title = "Move up";
  up.addEventListener("click", () => { moveLayer(index, -1); });

  const down = document.createElement("button");
  down.className = "move";
  down.textContent = "↓";
  down.title = "Move down";
  down.addEventListener("click", () => { moveLayer(index, 1); });

  row.addEventListener("click", (event) => {
    if (event.target === visibility || event.target === blend) return;
    setActive(layer.id);
  });

  row.append(visibility, opacity, blend, name, up, down);
  return row;
}

function tags(layer) {
  const tags = [];
  const make = (text) => {
    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = text;
    return tag;
  };
  if (layer.isGroup) tags.push(make("group"));
  if (layer.adjustment) tags.push(make(layer.adjustment.kind));
  if (layer.text) tags.push(make("text"));
  if (layer.shape) tags.push(make(layer.shape.kind));
  if (layer.maskFile) tags.push(make(layer.maskEnabled === false ? "mask off" : "mask"));
  if (layer.maskSourceID) tags.push(make("clipped"));
  return tags;
}

function setActive(id) {
  session.activeLayerId = id;
  session.selectedLayerIds = new Set(id ? [id] : []);
  emit("selection");
}

// Subtree blocks must stay contiguous, so moves swap whole blocks.
function moveLayer(index, direction) {
  const layers = manifest().layers;
  session.beginEdit("Reorder Layers");
  const end = subtreeEnd(index);
  const block = layers.slice(index, end + 1);
  if (direction > 0) {
    if (end + 1 >= layers.length) { session.cancelEdit(); return; }
    const nextEnd = subtreeEnd(end + 1);
    layers.splice(index, block.length);
    layers.splice(nextEnd - block.length + 1, 0, ...block);
  } else {
    const head = siblingHead(index);
    if (head < 0) { session.cancelEdit(); return; }
    layers.splice(index, block.length);
    layers.splice(head, 0, ...block);
  }
  session.endEdit();
  session.markDirty();
}
