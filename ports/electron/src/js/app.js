// App shell: wires the host IPC, project browsing, the canvas and the layers panel.
// Feature modules (tools, panels, ops, io, psd) attach through state.js events and
// their own exports; this file owns bootstrap and the primary toolbar actions.

import { session, on, emit, doc, manifest, markDirty, beginEdit, endEdit, cancelEdit,
  setActiveLayer, renderDocument, canUndo, canRedo, undo, redo, pushInitialHistory } from "./state.js";
import { validateManifest, SAVE_VERSION } from "./format.js";
import { projectIO } from "./io.js";
import { panelBuilder } from "./panels.js";
import { installShortcuts } from "./shortcuts.js";
import { installTools } from "./tools.js";
import { installMenus, rememberRecentProject } from "./menus.js";
import { documentOps } from "./ops.js";
import { registerCommands } from "./commands.js";

const { invoke } = window.__COMPOSITOR__.core;

const els = {};
for (const id of ["pickFolder", "folderPath", "refresh", "newProject", "importImages", "undo", "redo",
  "commandPalette", "exportPng", "exportJpeg", "save", "projectList", "canvas", "status",
  "layerList", "addLayer", "addGroup", "duplicateLayer", "deleteLayer", "mergeDown", "addMask",
  "canvasHost", "toolOptions"]) {
  els[id] = document.getElementById(id);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}
session.setStatus = setStatus;

function projectDisplayName(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = index >= 0 ? path.slice(index + 1) : path;
  return base.replace(/\.comp$/i, "");
}
session.projectDisplayName = projectDisplayName;

// ---- Project browsing ----

async function pickFolder() {
  try {
    const directory = await invoke("pick_folder", { start: session.root || null });
    if (!directory) return;
    session.root = directory;
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
    session.projects = await invoke("list_projects", { root });
    renderProjectList();
    const suffix = session.projects.length === 1 ? "project" : "projects";
    setStatus(`${session.root} — ${session.projects.length} ${suffix}`);
  } catch (error) {
    session.projects = [];
    renderProjectList();
    setStatus(String(error), true);
  }
}

function renderProjectList() {
  els.projectList.replaceChildren();
  for (const project of session.projects) {
    const item = document.createElement("li");
    item.textContent = project.name;
    if (doc() && project.path === doc().path) item.classList.add("active");
    item.addEventListener("click", () => openProject(project.path));
    els.projectList.appendChild(item);
  }
}

async function openProject(path) {
  try {
    const loaded = await invoke("load_project", { path });
    validateManifest(loaded.manifest);
    const images = new Map();
    await Promise.all(loaded.images.map(async (asset) => {
      const blob = await (await fetch(`data:image/png;base64,${asset.base64}`)).blob();
      const image = await createImageBitmap(blob);
      images.set(asset.file, image);
    }));
    session.doc = { path: loaded.path, manifest: loaded.manifest, images };
    session.dirty = false;
    pushInitialHistory("Open");
    const first = loaded.manifest.layers[loaded.manifest.layers.length - 1];
    setActiveLayer(first ? first.id : null);
    rememberRecentProject(loaded.path);
    renderProjectList();
    emit("document");
    const count = loaded.manifest.layers.length;
    setStatus(`${projectDisplayName(loaded.path)} — ${loaded.manifest.width}×${loaded.manifest.height} px, `
      + `${count} layer${count === 1 ? "" : "s"}, format v${loaded.manifest.version}`);
  } catch (error) {
    setStatus(String(error), true);
  }
}
session.openProject = openProject;

// ---- Toolbar ----

async function save() {
  if (!doc()) return;
  try {
    const m = manifest();
    m.version = Math.max(m.version, Math.min(m.version, SAVE_VERSION));
    // The manifest and every touched asset go down together (ProjectStore parity).
    await projectIO.saveProject();
    rememberRecentProject(doc().path);
  } catch (error) {
    setStatus(String(error), true);
  }
}

// Save As: picks a fresh package path, then runs the ordinary save flow against
// it (the macOS app's save(asNew:)).
async function saveAs() {
  if (!doc()) return;
  try {
    const file = `${projectDisplayName(doc().path) || "Untitled"}.comp`;
    const destination = await invoke("pick_save_path", { fileName: file });
    if (!destination) return;
    doc().path = destination;
    await save();
    await refresh();
  } catch (error) {
    setStatus(String(error), true);
  }
}

async function exportImage(kind, quality = 0.9) {
  if (!doc()) return;
  try {
    let canvas = renderDocument();
    if (kind === "jpeg") {
      // JPEG has no alpha; the macOS exporter flattens onto white by default.
      const flattened = document.createElement("canvas");
      flattened.width = canvas.width;
      flattened.height = canvas.height;
      const context = flattened.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, flattened.width, flattened.height);
      context.drawImage(canvas, 0, 0);
      canvas = flattened;
    }
    const mime = kind === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, kind === "jpeg" ? quality : undefined));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    const file = `${projectDisplayName(doc().path)}.${kind}`;
    const destination = await invoke("export_file", { fileName: file, base64: btoa(binary), kind, quality, ppi: manifest().resolution ?? 72 });
    if (destination) setStatus(`Exported ${destination}`);
  } catch (error) {
    setStatus(String(error), true);
  }
}

async function importImages() {
  try {
    const files = await invoke("import_images", {});
    if (files && files.length) await projectIO.placeImages(files);
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
els.exportPng.addEventListener("click", () => exportImage("png"));
els.exportJpeg.addEventListener("click", () => exportImage("jpeg"));
els.importImages.addEventListener("click", importImages);
els.undo.addEventListener("click", () => { undo(); });
els.redo.addEventListener("click", () => { redo(); });
els.newProject.addEventListener("click", () => documentOps.newProject());
els.addLayer.addEventListener("click", () => documentOps.addLayer());
els.addGroup.addEventListener("click", () => documentOps.addGroup());
els.duplicateLayer.addEventListener("click", () => documentOps.duplicateLayer());
els.deleteLayer.addEventListener("click", () => documentOps.deleteLayer());
els.mergeDown.addEventListener("click", () => documentOps.mergeDown());
els.addMask.addEventListener("click", () => documentOps.addMask());
els.commandPalette.addEventListener("click", () => registerCommands.open());

// ---- Events ----

on("document", () => {
  renderDocument(els.canvas);
  panelBuilder.renderLayers(els.layerList);
  els.save.disabled = !session.dirty;
  els.undo.disabled = !canUndo();
  els.redo.disabled = !canRedo();
  const hasDoc = !!doc();
  els.exportPng.disabled = !hasDoc;
  els.exportJpeg.disabled = !hasDoc;
  emit("documentRendered", els.canvas);
});

on("history", () => {
  els.undo.disabled = !canUndo();
  els.redo.disabled = !canRedo();
  emit("document");
});

on("selection", () => panelBuilder.renderLayers(els.layerList));

session.markDirty = () => { session.dirty = true; emit("document"); };
session.beginEdit = beginEdit;
session.endEdit = endEdit;
session.cancelEdit = cancelEdit;

installShortcuts(session);
installMenus();
installTools(session, els);
panelBuilder.install(session, els);
documentOps.install(session, els);
projectIO.install(session, els);
registerCommands.install(session, els);

session.app = { els, setStatus, refresh, openProject, save, saveAs, exportImage };
// Exposed for E2E oracles and debugging: the full session (doc, images, history).
window.__session = session;
emit("document");
