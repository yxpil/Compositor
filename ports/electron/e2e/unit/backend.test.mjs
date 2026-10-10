// Backend unit tests, mirroring src-tauri/src/comp.rs's #[cfg(test)] module and
// its command-level behavior (manifest validation, safe asset names, project
// load/save, export metadata stamping).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm as rmPath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBackend,
  crc32,
  validateManifest,
  safeAssetName,
  setPngResolution,
  setJpegDensity,
} from "../../backend.cjs";

function minimalPng() {
  const png = [];
  const push = (...bytes) => png.push(...bytes);
  const u32 = (value) => push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  // Signature.
  push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // IHDR: length 13, type, 13 data bytes, CRC (not verified by the stamper).
  u32(13);
  push(0x49, 0x48, 0x44, 0x52); // IHDR
  for (let i = 0; i < 13; i += 1) push(0);
  u32(0);
  // An existing pHYs the stamper must replace.
  u32(9);
  push(0x70, 0x48, 0x59, 0x73); // pHYs
  for (let i = 0; i < 9; i += 1) push(0);
  u32(0);
  // IDAT (empty) + IEND, each with its length prefix.
  u32(0);
  push(0x49, 0x44, 0x41, 0x54); // IDAT
  u32(0);
  u32(0);
  push(0x49, 0x45, 0x4e, 0x44); // IEND
  u32(0);
  return Buffer.from(png);
}

function validManifest() {
  return {
    format: "com.compositor.project",
    version: 5,
    width: 640,
    height: 480,
    layers: [{ id: "l1", name: "Layer", imageFile: "a.png" }],
  };
}

test("png resolution stamps pHYs and replaces existing", () => {
  const out = setPngResolution(minimalPng(), 72.0);
  assert.equal(out.subarray(0, 8).toString("latin1"), "\x89PNG\r\n\x1a\n");
  assert.equal(out.subarray(12, 16).toString("latin1"), "IHDR");
  // The stamped pHYs lands right after IHDR: length, type, x, y, unit.
  assert.equal(out.readUInt32BE(33), 9);
  assert.equal(out.subarray(37, 41).toString("latin1"), "pHYs");
  const ppm = out.readUInt32BE(41);
  assert.equal(ppm, Math.round(72.0 / 0.0254));
  assert.equal(out[49], 1); // unit: metre
  let count = 0;
  for (let i = 0; i + 4 <= out.length; i += 1) {
    if (out.subarray(i, i + 4).toString("latin1") === "pHYs") count += 1;
  }
  assert.equal(count, 1);
  // IEND type sits before its trailing CRC.
  assert.equal(out.subarray(out.length - 8, out.length - 4).toString("latin1"), "IEND");
});

test("png resolution rejects non-PNG", () => {
  assert.throws(() => setPngResolution(Buffer.from("not a png"), 72.0), /Export is not a valid PNG/);
});

test("jpeg density patches JFIF fields", () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\x00"),
    Buffer.from([1, 1, 0, 0, 1, 0, 0, 0, 0]),
  ]);
  const out = setJpegDensity(jpeg, 144.0);
  assert.equal(out[13], 1); // units: dots per inch
  assert.equal(out.readUInt16BE(14), 144);
  assert.equal(out.readUInt16BE(16), 144);
});

test("crc32 matches the reference vectors", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("manifest validation enforces format, version, canvas and layers", () => {
  assert.throws(() => validateManifest({ ...validManifest(), format: "nope" }), /not a Compositor project manifest/);
  assert.throws(() => validateManifest({ ...validManifest(), version: 12 }), /Unsupported project version 12/);
  assert.throws(() => validateManifest({ ...validManifest(), version: 0 }), /Unsupported project version 0/);
  assert.throws(() => validateManifest({ ...validManifest(), width: 0 }), /outside the supported limits/);
  assert.throws(() => validateManifest({ ...validManifest(), height: 30001 }), /outside the supported limits/);
  assert.throws(
    () => validateManifest({ ...validManifest(), layers: Array.from({ length: 10_001 }, () => ({})) }),
    /10,000 layer limit/
  );
  assert.throws(() => validateManifest({ ...validManifest(), layers: undefined }), /no layers array/);
});

test("safe asset names reject traversal", () => {
  assert.equal(safeAssetName("a.png"), "a.png");
  for (const bad of ["", "a/b.png", "a\\b.png", "..", "../a.png", "a/../b.png"]) {
    assert.throws(() => safeAssetName(bad), /Unsafe asset path/, bad);
  }
});

test("list projects finds .comp folders sorted by name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comp-list-"));
  await mkdir(path.join(root, "Beta.comp"));
  await writeFile(path.join(root, "Beta.comp", "manifest.json"), "{}");
  await mkdir(path.join(root, "alpha.comp"));
  await writeFile(path.join(root, "alpha.comp", "manifest.json"), "{}");
  await mkdir(path.join(root, "NotProject.comp")); // no manifest
  await writeFile(path.join(root, "loose.comp"), "not a folder");

  const backend = createBackend({});
  const projects = await backend.invoke("list_projects", { root });
  assert.deepEqual(
    projects.map((project) => project.name),
    ["alpha", "Beta"]
  );
  await assert.rejects(backend.invoke("list_projects", { root: path.join(root, "missing") }), /Cannot read/);
});

test("load project validates, dedupes assets and rejects bad packages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comp-load-"));
  const packagePath = path.join(root, "demo.comp");
  await mkdir(path.join(packagePath, "images"), { recursive: true });
  await writeFile(path.join(packagePath, "manifest.json"), JSON.stringify(validManifest()));
  await writeFile(path.join(packagePath, "images", "a.png"), Buffer.from([1, 2, 3]));

  const backend = createBackend({});
  const loaded = await backend.invoke("load_project", { path: packagePath });
  assert.equal(loaded.path, packagePath);
  assert.equal(loaded.images.length, 1);
  assert.equal(loaded.images[0].file, "a.png");
  assert.equal(Buffer.from(loaded.images[0].base64, "base64").toString(), "\x01\x02\x03");

  await assert.rejects(backend.invoke("load_project", { path: root }), /Not a Compositor project/);
  await writeFile(path.join(packagePath, "manifest.json"), "{ broken");
  await assert.rejects(backend.invoke("load_project", { path: packagePath }), /Manifest is not valid JSON/);
  await writeFile(
    path.join(packagePath, "manifest.json"),
    JSON.stringify({ ...validManifest(), version: 99 })
  );
  await assert.rejects(backend.invoke("load_project", { path: packagePath }), /Unsupported project version 99/);
  const missing = { ...validManifest(), layers: [{ imageFile: "gone.png" }] };
  await writeFile(path.join(packagePath, "manifest.json"), JSON.stringify(missing));
  await assert.rejects(backend.invoke("load_project", { path: packagePath }), /Missing asset: gone\.png/);
  const unsafe = { ...validManifest(), layers: [{ imageFile: "../escape.png" }] };
  await writeFile(path.join(packagePath, "manifest.json"), JSON.stringify(unsafe));
  await assert.rejects(backend.invoke("load_project", { path: packagePath }), /Unsafe asset path/);
});

test("save project writes the manifest and assets atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comp-save-"));
  const packagePath = path.join(root, "new.comp");
  const manifest = validManifest();
  const backend = createBackend({});
  await backend.invoke("save_project", {
    path: packagePath,
    manifest,
    images: [{ file: "a.png", base64: Buffer.from([9, 8, 7]).toString("base64") }],
  });

  const saved = JSON.parse(await readFile(path.join(packagePath, "manifest.json"), "utf8"));
  assert.deepEqual(saved, manifest);
  const listing = await readdir(packagePath);
  assert.equal(listing.filter((name) => name.endsWith(".tmp")).length, 0);
  assert.equal(
    Buffer.from(await readFile(path.join(packagePath, "images", "a.png"))).toString(),
    "\x09\x08\x07"
  );

  // A second save with no images keeps the manifest fresh and leaves assets.
  await backend.invoke("save_project", { path: packagePath, manifest, images: [] });
  const again = JSON.parse(await readFile(path.join(packagePath, "manifest.json"), "utf8"));
  assert.deepEqual(again, manifest);

  await assert.rejects(
    backend.invoke("save_project", { path: packagePath, manifest: { ...manifest, version: 40 }, images: [] }),
    /Unsupported project version 40/
  );
});

test("export stamps metadata and reports the destination", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "comp-export-"));
  t.after(async () => {
    await rmPath(scratch, { recursive: true, force: true });
  });
  const destinationPath = path.join(scratch, "out.png");
  let savedTo = null;
  const backend = createBackend({
    async saveFile() {
      savedTo = destinationPath;
      return savedTo;
    },
  });
  const destination = await backend.invoke("export_file", {
    fileName: "out.png",
    base64: minimalPng().toString("base64"),
    kind: "png",
    quality: 1,
    ppi: 144,
  });
  assert.equal(destination, destinationPath);
  assert.ok(savedTo);
  // The written file carries the stamped pHYs chunk.
  const written = await readFile(destinationPath);
  assert.equal(written.subarray(37, 41).toString("latin1"), "pHYs");

  // Cancelled dialog yields null.
  const cancelled = createBackend({ async saveFile() { return null; } });
  assert.equal(
    await cancelled.invoke("export_file", {
      fileName: "out.png",
      base64: minimalPng().toString("base64"),
      kind: "png",
      quality: 1,
      ppi: 72,
    }),
    null
  );
});

test("invoke rejects unknown commands like the IPC mock does", async () => {
  const backend = createBackend({});
  await assert.rejects(backend.invoke("nope", {}), /Unhandled command: nope/);
});
