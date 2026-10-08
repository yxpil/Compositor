// Compositor Port: cross-platform .comp project viewer and light editor.
// Reads and writes the format documented in docs/project-format.md.

const { invoke } = window.__TAURI__.core;

// Blend modes from manifest version 3, mapped to canvas compositing.
const BLEND_TO_CANVAS = {
  Normal: "source-over",
  Multiply: "multiply",
  Screen: "screen",
  Overlay: "overlay",
  Darken: "darken",
  Lighten: "lighten",
  Difference: "difference",
  "Color Dodge": "color-dodge",
  "Color Burn": "color-burn",
};
const BLEND_MODES = Object.keys(BLEND_TO_CANVAS);
// Folders carry opacity from version 8, layers from version 3.
const FOLDER_OPACITY_VERSION = 8;

const state = {
  root: "",
  projects: [],
  path: null,
  manifest: null,
  images: new Map(),
  maskCache: new Map(),
  dirty: false,
};

const els = {};
for (const id of ["pickFolder", "folderPath", "refresh", "exportPng", "save",
  "projectList", "canvas", "status", "layerList"]) {
  els[id] = document.getElementById(id);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function projectDisplayName(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = index >= 0 ? path.slice(index + 1) : path;
  return base.replace(/\.comp$/i, "");
}

async function pickFolder() {
  try {
    const directory = await invoke("pick_folder", { start: state.root || null });
    if (!directory) return;
    state.root = directory;
    els.folderPath.value = directory;
    await refresh();
  } catch (error) {
    setStatus(String(error), true);
  }
}

async function refresh() {
  const root = els.folderPath.value.trim();
  if (!root) return;
  try {
    state.projects = await invoke("list_projects", { root });
    renderProjectList();
    const suffix = state.projects.length === 1 ? "project" : "projects";
    setStatus(`${state.root} — ${state.projects.length} ${suffix}`);
  } catch (error) {
    state.projects = [];
    renderProjectList();
    setStatus(String(error), true);
  }
}

function renderProjectList() {
  els.projectList.replaceChildren();
  for (const project of state.projects) {
    const item = document.createElement("li");
    item.textContent = project.name;
    if (project.path === state.path) item.classList.add("active");
    item.addEventListener("click", () => openProject(project.path));
    els.projectList.appendChild(item);
  }
}

async function openProject(path) {
  try {
    const loaded = await invoke("load_project", { path });
    state.path = loaded.path;
    state.manifest = loaded.manifest;
    state.dirty = false;
    state.maskCache.clear();

    const images = new Map();
    await Promise.all(loaded.images.map(async (asset) => {
      const image = new Image();
      image.src = `data:image/png;base64,${asset.base64}`;
      await image.decode();
      images.set(asset.file, image);
    }));
    state.images = images;

    renderProjectList();
    renderLayers();
    renderCanvas();
    els.exportPng.disabled = false;
    els.save.disabled = true;
    const manifest = state.manifest;
    const count = manifest.layers.length;
    setStatus(
      `${projectDisplayName(loaded.path)} — ${manifest.width}×${manifest.height} px, ` +
      `${count} layer${count === 1 ? "" : "s"}, format v${manifest.version}`
    );
  } catch (error) {
    setStatus(String(error), true);
  }
}

function layerById(id) {
  return state.manifest.layers.find((layer) => layer.id === id) || null;
}

function isVisibleWithAncestors(layer) {
  let current = layer;
  while (current) {
    if (!current.isVisible) return false;
    current = current.parentID ? layerById(current.parentID) : null;
  }
  return true;
}

function effectiveOpacity(layer) {
  let opacity = typeof layer.opacity === "number" ? layer.opacity : 1;
  let current = layer.parentID ? layerById(layer.parentID) : null;
  while (current) {
    if (typeof current.opacity === "number") opacity *= current.opacity;
    current = current.parentID ? layerById(current.parentID) : null;
  }
  return opacity;
}

function drawTransformed(context, transform, image) {
  const { origin, size } = transform;
  context.translate(origin.x + size.width / 2, origin.y + size.height / 2);
  context.rotate(((transform.rotation || 0) * Math.PI) / 180);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.imageSmoothingEnabled = transform.sampling !== "Nearest";
  context.imageSmoothingQuality = transform.sampling === "High quality" ? "high" : "medium";
  context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
}

// Masks store grayscale coverage without alpha, so luminance becomes alpha
// before the mask can clip a layer with destination-in.
function maskAsAlpha(maskFile) {
  if (state.maskCache.has(maskFile)) return state.maskCache.get(maskFile);
  const mask = state.images.get(maskFile);
  if (!mask) return null;
  const canvas = document.createElement("canvas");
  canvas.width = mask.naturalWidth;
  canvas.height = mask.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(mask, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 3] = pixels[i];
  }
  context.putImageData(data, 0, 0);
  state.maskCache.set(maskFile, canvas);
  return canvas;
}

// Renders one layer (pixels + optional mask) into its own canvas so the
// mask clips the layer before blend mode and opacity apply.
function layerCanvas(layer) {
  const image = state.images.get(layer.imageFile);
  if (!image) return null;
  const size = layer.transform.size;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width));
  canvas.height = Math.max(1, Math.round(size.height));
  const context = canvas.getContext("2d");
  drawTransformed(context, layer.transform, image);

  if (layer.maskFile && layer.maskEnabled !== false) {
    const mask = maskAsAlpha(layer.maskFile);
    if (mask) {
      const placement = layer.maskPlacement || layer.transform;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "destination-in";
      drawTransformed(context, placement, mask);
    }
  }
  return canvas;
}

function renderCanvas() {
  const manifest = state.manifest;
  if (!manifest) return;
  els.canvas.width = manifest.width;
  els.canvas.height = manifest.height;
  const context = els.canvas.getContext("2d");
  context.clearRect(0, 0, manifest.width, manifest.height);

  // Layers are stored bottom-to-top; groups are pass-through containers.
  for (const layer of manifest.layers) {
    if (!isVisibleWithAncestors(layer) || layer.isGroup) continue;
    const rendered = layerCanvas(layer);
    if (!rendered) continue;
    context.globalAlpha = effectiveOpacity(layer);
    context.globalCompositeOperation = BLEND_TO_CANVAS[layer.blendMode] || "source-over";
    context.drawImage(rendered, 0, 0);
  }
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
}

function layerDepth(layer) {
  let depth = 0;
  let current = layer.parentID ? layerById(layer.parentID) : null;
  while (current) {
    depth += 1;
    current = current.parentID ? layerById(current.parentID) : null;
  }
  return depth;
}

function renderLayers() {
  els.layerList.replaceChildren();
  const layers = state.manifest.layers;
  // Display topmost first.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    els.layerList.appendChild(layerRow(layers[index], index));
  }
  if (!layers.length) {
    const hint = document.createElement("li");
    hint.className = "empty-hint";
    hint.textContent = "This project has no layers.";
    els.layerList.appendChild(hint);
  }
}

function layerRow(layer, index) {
  const row = document.createElement("li");
  row.className = "layer-row";
  row.style.paddingLeft = `${10 + layerDepth(layer) * 16}px`;

  const visibility = document.createElement("input");
  visibility.type = "checkbox";
  visibility.checked = !!layer.isVisible;
  visibility.title = "Visible";
  visibility.addEventListener("change", () => {
    layer.isVisible = visibility.checked;
    markDirty();
  });

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = 0;
  opacity.max = 100;
  opacity.value = Math.round((typeof layer.opacity === "number" ? layer.opacity : 1) * 100);
  opacity.title = "Opacity";
  opacity.addEventListener("change", () => {
    const value = Number(opacity.value) / 100;
    layer.opacity = value;
    if (layer.isGroup && state.manifest.version < FOLDER_OPACITY_VERSION) {
      state.manifest.version = FOLDER_OPACITY_VERSION;
    } else if (state.manifest.version < 3) {
      state.manifest.version = 3;
    }
    markDirty();
  });

  const blend = document.createElement("select");
  for (const mode of BLEND_MODES) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    blend.appendChild(option);
  }
  blend.value = layer.blendMode || "Normal";
  blend.addEventListener("change", () => {
    layer.blendMode = blend.value;
    if (state.manifest.version < 3) state.manifest.version = 3;
    markDirty();
  });

  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = layer.name || "Layer";
  name.title = `${layer.name || "Layer"} (${layer.id})`;
  if (layer.isGroup || layer.adjustment) {
    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = layer.isGroup ? "group" : layer.adjustment.kind;
    name.appendChild(document.createTextNode(" "));
    name.appendChild(tag);
  }

  const up = document.createElement("button");
  up.className = "move";
  up.textContent = "↑";
  up.title = "Move up";
  up.addEventListener("click", () => moveLayer(index, -1));

  const down = document.createElement("button");
  down.className = "move";
  down.textContent = "↓";
  down.title = "Move down";
  down.addEventListener("click", () => moveLayer(index, 1));

  row.append(visibility, opacity, blend, name, up, down);
  return row;
}

// Subtree blocks must stay contiguous, so moves swap whole blocks.
function subtreeEnd(index) {
  const layers = state.manifest.layers;
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
  const layers = state.manifest.layers;
  const parent = layers[index].parentID;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (layers[previous].parentID === parent) return previous;
  }
  return -1;
}

function moveLayer(index, direction) {
  const layers = state.manifest.layers;
  const end = subtreeEnd(index);
  const block = layers.slice(index, end + 1);
  if (direction > 0) {
    if (end + 1 >= layers.length) return;
    const nextEnd = subtreeEnd(end + 1);
    layers.splice(index, block.length);
    layers.splice(nextEnd - block.length + 1, 0, ...block);
  } else {
    const head = siblingHead(index);
    if (head < 0) return;
    layers.splice(index, block.length);
    layers.splice(head, 0, ...block);
  }
  markDirty();
}

function markDirty() {
  state.dirty = true;
  els.save.disabled = false;
  renderLayers();
  renderCanvas();
}

async function save() {
  try {
    await invoke("save_manifest", { path: state.path, manifest: state.manifest });
    state.dirty = false;
    els.save.disabled = true;
    setStatus(`Saved ${projectDisplayName(state.path)}`);
  } catch (error) {
    setStatus(String(error), true);
  }
}

async function exportPng() {
  try {
    const blob = await new Promise((resolve) => els.canvas.toBlob(resolve, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const file = `${projectDisplayName(state.path)}.png`;
    const destination = await invoke("export_png", { fileName: file, base64Png: btoa(binary) });
    if (destination) setStatus(`Exported ${destination}`);
  } catch (error) {
    setStatus(String(error), true);
  }
}

els.pickFolder.addEventListener("click", pickFolder);
els.refresh.addEventListener("click", refresh);
els.folderPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") refresh();
});
els.save.addEventListener("click", save);
els.exportPng.addEventListener("click", exportPng);
