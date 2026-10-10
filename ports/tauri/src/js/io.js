// Project IO: placing imported images, persisting the manifest together with the
// asset PNGs it references. Mirrors the macOS app's ProjectStore save flow: the
// manifest and every asset touched since the last save go down in one call.

import { session, doc, manifest, markDirty, beginEdit, endEdit, emit } from "./state.js";

const { invoke } = window.__TAURI__.core;

export function uniqueAssetName(base) {
  const clean = (base || "asset").replace(/[^A-Za-z0-9._-]/g, "_");
  const stem = clean.replace(/\.[^.]*$/, "") || "asset";
  const images = doc()?.images;
  if (!images || !images.has(`${stem}.png`)) return `${stem}.png`;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}.png`;
    if (!images.has(candidate)) return candidate;
  }
}

// A writable canvas holding any image source at its natural size.
export function canvasOf(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

async function base64Of(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Marks a runtime-created asset so the next save uploads it. `adoptAsset` (state.js)
// stores the pixels; this records the file for persistence.
export function trackAsset(file) {
  if (!session.doc) return;
  if (!session.doc.dirtyAssets) session.doc.dirtyAssets = new Set();
  session.doc.dirtyAssets.add(file);
}

// Data-URL mime for an imported file; decoders sniff the real bytes anyway,
// but declaring PNG for a JPEG breaks strict decoders.
const IMAGE_MIMES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  webp: "image/webp", bmp: "image/bmp", gif: "image/gif" };

export const projectIO = {
  install() {
    if (!session.doc) return;
    if (!session.doc.dirtyAssets) session.doc.dirtyAssets = new Set();
  },

  // files: [{ name, base64 }] from the import_images command.
  async placeImages(files) {
    if (!doc()) return;
    beginEdit("Place Image");
    try {
      for (const file of files) {
        const extension = (file.name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
        const mime = IMAGE_MIMES[extension] || "image/png";
        const bitmap = await createImageBitmap(
          await (await fetch(`data:${mime};base64,${file.base64}`)).blob()
        );
        const m = manifest();
        const imageFile = uniqueAssetName(file.name.replace(/\.[^.]+$/, ""));
        session.doc.images.set(imageFile, bitmap);
        trackAsset(imageFile);
        const layer = {
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/, "") || "Image",
          isVisible: true,
          opacity: 1,
          blendMode: "Normal",
          imageFile,
          transform: {
            origin: { x: (m.width - bitmap.width) / 2, y: (m.height - bitmap.height) / 2 },
            size: { width: bitmap.width, height: bitmap.height },
          },
        };
        m.layers.push(layer);
        session.activeLayerId = layer.id;
        session.selectedLayerIds = new Set([layer.id]);
      }
    } finally {
      endEdit();
      markDirty();
      emit("document");
    }
  },

  // Saves the manifest and every asset touched since the last save in one call.
  async saveProject() {
    if (!doc()) return;
    const m = manifest();
    const images = [];
    for (const file of session.doc.dirtyAssets || []) {
      const source = session.doc.images.get(file);
      if (!source) continue;
      images.push({ file, base64: await base64Of(source instanceof HTMLCanvasElement ? source : canvasOf(source)) });
    }
    let path = doc().path;
    if (!path) {
      // Unsaved projects get a name and live under the open folder (or the mock root).
      const name = (session.pendingProjectName || "Untitled").replace(/[^A-Za-z0-9._-]/g, "_");
      path = `${session.root ? session.root.replace(/\/$/, "") + "/" : ""}${name}.comp`;
      doc().path = path;
    }
    await invoke("save_project", { path, manifest: m, images });
    session.doc.dirtyAssets = new Set();
    session.dirty = false;
    if (session.setStatus) session.setStatus(`Saved ${session.projectDisplayName(path)}`);
    emit("document");
  },
};
