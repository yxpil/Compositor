// Backend: the Node port of src-tauri/src/comp.rs. Every command the frontend
// invokes lives here with the same validation, limits, error strings and
// metadata stamping as the Rust backend, so both ports behave identically.
// Deliberately Electron-free: dialogs are injected, which keeps the logic
// runnable under `node --test`.

const fs = require("node:fs").promises;
const path = require("node:path");

// Format constants from docs/project-format.md, matching comp.rs.
const PROJECT_FORMAT = "com.compositor.project";
const MIN_VERSION = 1;
const MAX_VERSION = 11;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_LAYERS = 10_000;
const MAX_CANVAS_SIDE = 30_000.0;

function validateManifest(manifest) {
  if (manifest?.format !== PROJECT_FORMAT) {
    throw new Error("This is not a Compositor project manifest");
  }
  const version = manifest.version;
  if (typeof version !== "number" || !Number.isFinite(version) || !Number.isInteger(version)) {
    throw new Error("Manifest has no version");
  }
  if (version < MIN_VERSION || version > MAX_VERSION) {
    throw new Error(
      `Unsupported project version ${version} (this port reads ${MIN_VERSION}-${MAX_VERSION})`
    );
  }
  const width = typeof manifest.width === "number" ? manifest.width : 0;
  const height = typeof manifest.height === "number" ? manifest.height : 0;
  if (width < 1.0 || height < 1.0 || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error("Canvas dimensions are outside the supported limits");
  }
  if (!Array.isArray(manifest.layers)) {
    throw new Error("Manifest has no layers array");
  }
  if (manifest.layers.length > MAX_LAYERS) {
    throw new Error("Project exceeds the 10,000 layer limit");
  }
}

// Asset names must stay inside images/: a bare file name, no separators or traversal.
function safeAssetName(file) {
  const base = path.basename(file);
  const rejected =
    !file ||
    file.includes("/") ||
    file.includes("\\") ||
    file.includes("..") ||
    base !== file ||
    (path.sep === "\\" ? /^[\w.:-]+$/.test(file) === false : false);
  if (rejected) {
    throw new Error(`Unsafe asset path: ${file}`);
  }
  return file;
}

function referencedFiles(manifest) {
  const files = [];
  if (Array.isArray(manifest.layers)) {
    for (const layer of manifest.layers) {
      if (typeof layer?.imageFile === "string") files.push(layer.imageFile);
      if (typeof layer?.maskFile === "string") files.push(layer.maskFile);
    }
  }
  return [...new Set(files)].sort();
}

async function listProjects(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read ${root}: ${error.code ?? error.message}`);
  }
  const projects = [];
  for (const entry of entries) {
    const packagePath = path.join(root, entry.name);
    if (!entry.name.toLowerCase().endsWith(".comp")) continue;
    try {
      const stat = await fs.stat(path.join(packagePath, "manifest.json"));
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    projects.push({
      name: entry.name.replace(/\.comp$/i, ""),
      path: packagePath,
    });
  }
  projects.sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0
  );
  return projects;
}

async function loadProject(projectPath) {
  const manifestPath = path.join(projectPath, "manifest.json");
  let stat;
  try {
    stat = await fs.stat(manifestPath);
  } catch {
    throw new Error(`Not a Compositor project: ${projectPath}`);
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Manifest exceeds the 4 MiB limit");
  }

  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read manifest: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error.message}`);
  }
  validateManifest(manifest);

  const images = [];
  for (const file of referencedFiles(manifest)) {
    const asset = path.join(projectPath, "images", safeAssetName(file));
    let assetStat;
    try {
      assetStat = await fs.stat(asset);
    } catch {
      throw new Error(`Missing asset: ${file}`);
    }
    if (assetStat.size > MAX_ASSET_BYTES) {
      throw new Error(`Asset exceeds the 512 MiB limit: ${file}`);
    }
    let bytes;
    try {
      bytes = await fs.readFile(asset);
    } catch (error) {
      throw new Error(`Cannot read asset ${file}: ${error.message}`);
    }
    images.push({ file, base64: bytes.toString("base64") });
  }

  return { path: projectPath, manifest, images };
}

// Saves the manifest plus every asset touched since the last save in one call,
// mirroring the macOS ProjectStore's atomic save flow. Unsaved projects may pass
// a package path that does not exist yet.
async function saveProject(projectPath, manifest, images) {
  validateManifest(manifest);

  try {
    await fs.mkdir(projectPath, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot create ${projectPath}: ${error.message}`);
  }
  const imagesDir = path.join(projectPath, "images");
  try {
    await fs.mkdir(imagesDir, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot create ${imagesDir}: ${error.message}`);
  }

  let bytes;
  try {
    bytes = Buffer.concat([Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")]);
  } catch (error) {
    throw new Error(error.message);
  }
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Manifest exceeds the 4 MiB limit");
  }
  // Write beside the target and rename, mirroring the app's atomic save.
  const temp = path.join(projectPath, "manifest.json.tmp");
  try {
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, path.join(projectPath, "manifest.json"));
  } catch (error) {
    throw new Error(`Cannot write manifest: ${error.message}`);
  }

  for (const asset of images ?? []) {
    const name = safeAssetName(asset.file);
    const bytes = Buffer.from(asset.base64, "base64");
    if (bytes.length > MAX_ASSET_BYTES) {
      throw new Error(`Asset exceeds the 512 MiB limit: ${name}`);
    }
    const temp = path.join(imagesDir, `${name}.tmp`);
    try {
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, path.join(imagesDir, name));
    } catch (error) {
      throw new Error(`Cannot replace asset ${name}: ${error.message}`);
    }
  }
}

function crc32(data) {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Signature + IHDR chunk: 8 + (4 length + 4 type + 13 data + 4 CRC).
const PNG_IHDR_END = 33;

// Embeds the resolution as a pHYs chunk (pixels per metre) right after IHDR,
// replacing any existing one. Equivalent to ImageIO's kCGImagePropertyDPIWidth.
function setPngResolution(png, ppi) {
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(png);
  if (
    bytes.length < PNG_IHDR_END ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.subarray(12, 16).toString("latin1") !== "IHDR"
  ) {
    throw new Error("Export is not a valid PNG");
  }
  const metres = Math.max(1, Math.round(ppi / 0.0254));
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  chunk.write("pHYs", 4, "latin1");
  chunk.writeUInt32BE(metres, 8);
  chunk.writeUInt32BE(metres, 12);
  chunk[16] = 1; // unit: metre
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);

  const out = Buffer.concat([bytes.subarray(0, PNG_IHDR_END), chunk]);
  const chunks = [];
  let offset = PNG_IHDR_END;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length + 4;
    if (end > bytes.length) {
      throw new Error("Export is not a valid PNG");
    }
    if (bytes.subarray(offset + 4, offset + 8).toString("latin1") !== "pHYs") {
      chunks.push(Buffer.from(bytes.subarray(offset, end)));
    }
    offset = end;
  }
  return Buffer.concat([out, ...chunks]);
}

// Patches the JFIF APP0 density fields to the document resolution in DPI.
// If the encoder wrote no JFIF segment the data passes through unchanged.
function setJpegDensity(jpeg, ppi) {
  const bytes = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg);
  if (
    bytes.length >= 18 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes[3] === 0xe0 &&
    bytes.subarray(6, 11).toString("latin1") === "JFIF\x00"
  ) {
    bytes[13] = 1; // density unit: dots per inch
    const density = Math.min(65535, Math.max(1, Math.round(ppi)));
    bytes.writeUInt16BE(density, 14);
    bytes.writeUInt16BE(density, 16);
  }
  return bytes;
}

// Backend factory: dialogs come from the host (Electron main process or the
// test harness) so the command surface stays identical in both.
function createBackend(dialogs) {
  async function pickFolder({ start } = {}) {
    return dialogs.pickFolder(start ?? null);
  }

  async function exportFile({ fileName, base64, kind, quality, ppi }) {
    const bytes = Buffer.from(base64, "base64");
    // Quality is baked into the frontend's encode; kept in the signature for
    // call-site parity with the macOS exporter's JPEGOptions.
    void quality;
    const stamped = kind === "jpeg" ? setJpegDensity(bytes, ppi) : setPngResolution(bytes, ppi);
    const destination = await dialogs.saveFile(fileName, kind === "jpeg" ? "jpeg" : "png");
    if (!destination) return null;
    try {
      await fs.writeFile(destination, stamped);
    } catch (error) {
      throw new Error(`Cannot write ${kind}: ${error.message}`);
    }
    return destination;
  }

  async function importImages() {
    const paths = await dialogs.pickFiles();
    const images = [];
    for (const filePath of paths ?? []) {
      let bytes;
      try {
        bytes = await fs.readFile(filePath);
      } catch (error) {
        throw new Error(`Cannot read ${filePath}: ${error.message}`);
      }
      if (bytes.length > MAX_ASSET_BYTES) {
        throw new Error(`Asset exceeds the 512 MiB limit: ${filePath}`);
      }
      images.push({
        name: path.basename(filePath) || "image",
        base64: bytes.toString("base64"),
      });
    }
    return images;
  }

  const commands = {
    pick_folder: pickFolder,
    list_projects: ({ root }) => listProjects(root),
    load_project: ({ path }) => loadProject(path),
    save_project: ({ path, manifest, images }) => saveProject(path, manifest, images),
    export_file: exportFile,
    import_images: importImages,
    // Save As: only picks the destination; the frontend saves to it through
    // save_project. Mirrors the mock's pick_save_path.
    pick_save_path: ({ fileName } = {}) => dialogs.savePackage(fileName ?? "Untitled.comp"),
  };

  return {
    async invoke(command, args = {}) {
      const handler = commands[command];
      if (!handler) throw new Error(`Unhandled command: ${command}`);
      return handler(args);
    },
  };
}

module.exports = { validateManifest, safeAssetName, listProjects, loadProject, saveProject, crc32, setPngResolution, setJpegDensity, createBackend };

