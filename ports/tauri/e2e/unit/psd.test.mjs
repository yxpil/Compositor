// Unit tests for the PSD importer ported from Compositor/IO/PSD (PSDReader,
// PSDChannelCoder, PSDDocumentBuilder, PSDTypes, PSDText, PSDVector).
// Every fixture is a hand-built minimal PSD byte stream, and expected pixels
// are computed from the bytes put in, not from the JS code.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePSD, matchesPSD, PSDError } from "../../src/js/psd.js";
import { validateManifest } from "../../src/js/format.js";

// ---- Fixture builders: minimal PSD byte streams ----

class Writer {
  constructor() { this.data = []; }
  u8(v) { this.data.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u8(v >>> 24).u8(v >> 16).u8(v >> 8).u8(v); }
  i32(v) { return this.u32(v < 0 ? v + 0x100000000 : v); }
  u64(v) { return this.u32(Math.floor(v / 0x100000000)).u32(v >>> 0); }
  ascii(text) { for (const ch of text) this.u8(ch.charCodeAt(0)); return this; }
  bytes(raw) { for (const b of raw) this.u8(b); return this; }
  f64(v) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    for (let i = 0; i < 8; i += 1) this.u8(view.getUint8(i));
    return this;
  }
  utf16(text) {
    this.u32(text.length);
    for (const unit of text) this.u16(unit.charCodeAt(0));
    return this;
  }
  build() { return Uint8Array.from(this.data); }
}

// PackBits encoder: runs of ≥3 become copies, everything else literal chunks.
function packBitsEncode(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (run < 128 && i + run < bytes.length && bytes[i + run] === bytes[i]) run += 1;
    if (run >= 3) {
      out.push((1 - run) & 0xff);
      out.push(bytes[i]);
      i += run;
      continue;
    }
    const literal = Math.min(128, bytes.length - i);
    out.push(literal - 1);
    for (let j = 0; j < literal; j += 1) out.push(bytes[i + j]);
    i += literal;
  }
  return Uint8Array.from(out);
}

// One channel's stored bytes: compression marker, row-count table, packed rows.
function channelBytes(planes, isPSB) {
  const writer = new Writer();
  for (const plane of planes) {
    const start = writer.data.length;
    writer.u16(plane.compression);
    if (plane.compression === 0) {
      writer.bytes(plane.rows);
    } else {
      const rows = plane.rows;
      const width = rows.length / plane.rowCount;
      const packed = [];
      for (let row = 0; row < plane.rowCount; row += 1) {
        const slice = packBitsEncode(rows.subarray(row * width, (row + 1) * width));
        packed.push(slice);
      }
      for (const slice of packed) {
        if (isPSB) writer.u32(slice.length); else writer.u16(slice.length);
      }
      for (const slice of packed) writer.bytes(slice);
    }
    plane.length = writer.data.length - start;
  }
  return writer;
}

// A layer record plus its channel data (records come first in the file, then
// every layer's channel bytes in record order).
function layerFixture(layer) {
  const isPSB = layer.isPSB;
  // The record declares each channel's byte length, so the channel data must be
  // assembled first (channelBytes stamps plane.length onto every channel).
  const data = channelBytes(layer.channels || [], isPSB);
  const record = new Writer();
  record.i32(layer.top ?? 0).i32(layer.left ?? 0).i32(layer.bottom ?? 0).i32(layer.right ?? 0);
  const channels = layer.channels || [];
  record.u16(channels.length);
  for (const channel of channels) {
    record.i16(channel.id);
    if (isPSB) record.u64(channel.length); else record.u32(channel.length);
  }
  record.ascii("8BIM").ascii(layer.blendKey || "norm");
  record.u8(layer.opacity ?? 255).u8(layer.clipping ? 1 : 0).u8(layer.flags ?? 0).u8(0);

  // Extra data: layer mask, blending ranges, Pascal name, additional info.
  const extra = new Writer();
  if (layer.mask) {
    extra.u32(20);
    extra.i32(layer.mask.top).i32(layer.mask.left).i32(layer.mask.bottom).i32(layer.mask.right);
    extra.u8(layer.mask.default ?? 255).u8(layer.mask.flags ?? 0).u8(0).u8(0);
  } else {
    extra.u32(0);
  }
  extra.u32(0); // Blending ranges.
  const name = layer.name || "";
  extra.u8(name.length).ascii(name);
  const pad = (4 - ((name.length + 1) % 4)) % 4;
  for (let i = 0; i < pad; i += 1) extra.u8(0);
  for (const block of layer.blocks || []) {
    extra.ascii("8BIM").ascii(block.key).u32(block.payload.length).bytes(block.payload);
    if (block.payload.length % 2 === 1) extra.u8(0);
  }
  record.u32(extra.data.length).bytes(extra.data);

  return { record: record.build(), channelData: data.build() };
}

function buildPSD({ width, height, version = 1, resolution = null, layers }) {
  const isPSB = version === 2;
  const file = new Writer();
  file.ascii("8BPS").u16(version);
  for (let i = 0; i < 6; i += 1) file.u8(0);
  file.u16(3).u32(height).u32(width).u16(8).u16(3);
  file.u32(0); // Color mode data.

  // Image resources: optional ResolutionInfo (id 1005).
  const resources = new Writer();
  if (resolution !== null) {
    resources.ascii("8BIM").u16(1005).u8(0).u8(0).u32(16);
    resources.u32(Math.round(resolution * 65536)).u16(1).u16(0);
    resources.u32(Math.round(resolution * 65536)).u16(1).u16(0);
  }
  file.u32(resources.data.length).bytes(resources.data);

  const fixtures = layers.map((layer) => layerFixture({ ...layer, isPSB }));
  const records = new Writer();
  for (const fixture of fixtures) records.bytes(fixture.record);
  const channelData = new Writer();
  for (const fixture of fixtures) channelData.bytes(fixture.channelData);
  const layerInfo = new Writer();
  layerInfo.i16(layers.length).bytes(records.build()).bytes(channelData.build());
  const layerSection = new Writer();
  if (isPSB) layerSection.u64(layerInfo.data.length); else layerSection.u32(layerInfo.data.length);
  layerSection.bytes(layerInfo.build()).u32(0); // Global mask info: none.
  if (isPSB) file.u64(layerSection.data.length); else file.u32(layerSection.data.length);
  file.bytes(layerSection.build());
  return file.build();
}

// RAW 8-bit planes for a rect, from an RGBA fill function.
function rawPlanes(top, left, bottom, right, fill, withMask) {
  const width = right - left, height = bottom - top;
  const red = new Uint8Array(width * height);
  const green = new Uint8Array(width * height);
  const blue = new Uint8Array(width * height);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(left + x, top + y);
      const i = y * width + x;
      red[i] = r; green[i] = g; blue[i] = b; alpha[i] = a;
    }
  }
  const channels = [
    { id: 0, compression: 0, rows: red },
    { id: 1, compression: 0, rows: green },
    { id: 2, compression: 0, rows: blue },
    { id: -1, compression: 0, rows: alpha },
  ];
  if (withMask) {
    channels.push({
      id: -2, compression: 0,
      rows: withMask.gray,
      // The record declares the mask patch separately; width/height come from the mask rect.
      rowCount: withMask.height,
    });
  }
  return channels;
}

// ---- Minimal PNG decoder for the encoder's output (stored deflate, filter 0) ----

function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) assert.equal(bytes[i], signature[i], "PNG signature");
  let position = 8;
  let header = null;
  const idat = [];
  while (position < bytes.length) {
    const length = view.getUint32(position);
    let type = "";
    for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[position + 4 + i]);
    const data = bytes.subarray(position + 8, position + 8 + length);
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    position += 12 + length;
  }
  assert.ok(header, "IHDR present");
  const width = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
  const height = (header[4] << 24) | (header[5] << 16) | (header[6] << 8) | header[7];
  const colorType = header[9];
  const channels = colorType === 6 ? 4 : 1;

  // Inflate the stored-deflate stream written by the module's encoder.
  const stream = idat.length === 1 ? idat[0] : (() => {
    const out = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of idat) { out.set(part, at); at += part.length; }
    return out;
  })();
  assert.equal(stream[0], 0x78, "zlib CMF");
  assert.equal(stream[1] & 0x20, 0, "no preset dictionary");
  let offset = 2;
  const out = [];
  for (;;) {
    const isLast = stream[offset] & 1;
    const blockType = (stream[offset] >> 1) & 3;
    assert.equal(blockType, 0, "stored deflate block");
    const len = stream[offset + 1] | (stream[offset + 2] << 8);
    const nlen = stream[offset + 3] | (stream[offset + 4] << 8);
    assert.equal((len ^ 0xffff) & 0xffff, nlen, "stored block NLEN");
    for (let i = 0; i < len; i += 1) out.push(stream[offset + 5 + i]);
    offset += 5 + len;
    if (isLast) break;
  }
  // Adler-32 trailer check (bytes after the final block).
  let a = 1, b = 0;
  for (const byte of out) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const checksum = ((b << 16) | a) >>> 0;
  assert.equal(stream[offset], (checksum >>> 24) & 0xff, "adler byte 1");
  assert.equal(stream[offset + 1], (checksum >>> 16) & 0xff, "adler byte 2");
  assert.equal(stream[offset + 2], (checksum >>> 8) & 0xff, "adler byte 3");
  assert.equal(stream[offset + 3], checksum & 0xff, "adler byte 4");

  const raw = Uint8Array.from(out);
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, "filter type None");
    pixels.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, colorType, channels, pixels };
}

function rgbaAt(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2], png.pixels[i + 3]];
}

// ---- Header and structure errors (same copy as the macOS app) ----

test("rejects bytes that are not a Photoshop file", () => {
  assert.throws(() => parsePSD(new Uint8Array([1, 2, 3, 4, 5])), (error) =>
    error instanceof PSDError
    && error.code === "unreadable"
    && error.message === "The image could not be read. It may be damaged or unavailable.");
  assert.equal(matchesPSD(buildPSD({ width: 1, height: 1, layers: [] })), true);
  assert.equal(matchesPSD(new Uint8Array([0, 1, 2, 3])), false);
});

test("rejects unsupported versions, depths and color modes with the original copy", () => {
  const base = { width: 2, height: 2, layers: [] };
  assert.throws(() => parsePSD(buildPSD({ ...base, version: 3 })), (error) =>
    error.code === "unsupportedVersion"
    && error.message === "This Photoshop file uses a format version Compositor can’t read.");
  const depth16 = buildPSD(base);
  depth16[0x16] = 16; // Depth field of the 26-byte header (depth sits at byte 22).
  assert.throws(() => parsePSD(depth16), (error) =>
    error.code === "unsupportedDepth"
    && error.message === "Only 8-bit RGB Photoshop files can be imported.");
  const indexed = buildPSD(base);
  indexed[0x18] = 2; // Color mode field (byte 24, right after depth).
  assert.throws(() => parsePSD(indexed), (error) =>
    error.code === "unsupportedColorMode"
    && error.message === "Only 8-bit RGB Photoshop files can be imported.");
  assert.throws(() => parsePSD(buildPSD({ ...base, width: 40000 })), (error) =>
    error.code === "tooLarge");
});

// ---- RAW layer with exact pixels ----

test("parses a minimal RAW layer with straight-alpha pixels", () => {
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [{
      name: "Red",
      top: 0, left: 0, bottom: 2, right: 2,
      channels: rawPlanes(0, 0, 2, 2, (x, y) => [250, 10, 20, x === 0 && y === 0 ? 128 : 255]),
    }],
  });
  const { manifest, images, notes } = parsePSD(bytes);
  assert.equal(manifest.format, "com.compositor.project");
  assert.equal(manifest.version, 11);
  assert.deepEqual([manifest.width, manifest.height, manifest.resolution], [2, 2, 72]);
  assert.deepEqual(notes, []);
  assert.equal(manifest.layers.length, 1);
  const layer = manifest.layers[0];
  assert.equal(layer.name, "Red");
  assert.equal(layer.blendMode, "Normal");
  assert.equal(layer.opacity, 1);
  assert.equal(layer.isVisible, true);
  assert.deepEqual(layer.transform, { origin: { x: 0, y: 0 }, size: { width: 2, height: 2 } });
  assert.ok(images.has(layer.imageFile));
  const png = decodePng(images.get(layer.imageFile));
  assert.equal(png.colorType, 6);
  assert.deepEqual([png.width, png.height], [2, 2]);
  // Straight alpha: the half-transparent pixel keeps its color channels.
  assert.deepEqual(rgbaAt(png, 0, 0), [250, 10, 20, 128]);
  assert.deepEqual(rgbaAt(png, 1, 1), [250, 10, 20, 255]);
  validateManifest(manifest); // The produced manifest must be a valid v11 project.
});

// ---- PackBits RLE, canvas cropping of the merged section, larger streams ----

test("unpacks PackBits RLE rows exactly", () => {
  const width = 4, height = 3;
  const red = Uint8Array.from([200, 200, 200, 200, 0, 1, 2, 3, 77, 77, 77, 77]);
  const bytes = buildPSD({
    width, height,
    layers: [{
      name: "RLE",
      top: 0, left: 0, bottom: height, right: width,
      channels: [
        { id: 0, compression: 1, rows: red, rowCount: height },
        { id: 1, compression: 0, rows: new Uint8Array(width * height).fill(9) },
        { id: 2, compression: 0, rows: new Uint8Array(width * height).fill(10) },
        { id: -1, compression: 0, rows: new Uint8Array(width * height).fill(255) },
      ],
    }],
  });
  const { manifest, images } = parsePSD(bytes);
  const png = decodePng(images.get(manifest.layers[0].imageFile));
  assert.deepEqual(rgbaAt(png, 0, 0), [200, 9, 10, 255]);
  assert.deepEqual(rgbaAt(png, 3, 1), [3, 9, 10, 255]); // Last pixel of the [0,1,2,3] row.
  assert.deepEqual(rgbaAt(png, 3, 2), [77, 9, 10, 255]);
  assert.deepEqual(rgbaAt(png, 0, 2), [77, 9, 10, 255]);
});

test("parses a PSB (version 2) layer with 64-bit lengths and 4-byte row counts", () => {
  const bytes = buildPSD({
    version: 2, width: 2, height: 1,
    layers: [{
      isPSB: true,
      name: "PSB",
      top: 0, left: 0, bottom: 1, right: 2,
      channels: [
        { id: 0, compression: 1, rows: Uint8Array.from([5, 6]), rowCount: 1 },
        { id: 1, compression: 0, rows: Uint8Array.from([7, 8]) },
        { id: 2, compression: 0, rows: Uint8Array.from([9, 10]) },
        { id: -1, compression: 0, rows: Uint8Array.from([255, 128]) },
      ],
    }],
  });
  const { manifest, images } = parsePSD(bytes);
  const png = decodePng(images.get(manifest.layers[0].imageFile));
  assert.deepEqual(rgbaAt(png, 0, 0), [5, 7, 9, 255]);
  assert.deepEqual(rgbaAt(png, 1, 0), [6, 8, 10, 128]);
});

test("encodes larger layers through multi-block deflate streams", () => {
  const size = 300;
  const bytes = buildPSD({
    width: size, height: size,
    layers: [{
      name: "Big",
      top: 0, left: 0, bottom: size, right: size,
      channels: rawPlanes(0, 0, size, size, (x, y) => [x % 256, y % 256, 128, 255]),
    }],
  });
  const { manifest, images } = parsePSD(bytes);
  const png = decodePng(images.get(manifest.layers[0].imageFile));
  assert.deepEqual([png.width, png.height], [size, size]);
  assert.deepEqual(rgbaAt(png, 299, 299), [299 % 256, 299 % 256, 128, 255]);
  assert.deepEqual(rgbaAt(png, 100, 0), [100, 0, 128, 255]);
});

// ---- Groups (section dividers) ----

test("assembles a group from its divider, children and folder record", () => {
  const bytes = buildPSD({
    width: 4, height: 4,
    layers: [
      { // "<Layer group>" divider: no pixels, never stored.
        name: "<Layer group>", flags: 2,
        blocks: [{ key: "lsct", payload: new Writer().u32(3).build() }],
      },
      {
        name: "Child", top: 1, left: 1, bottom: 3, right: 3, blendKey: "mul ",
        channels: rawPlanes(1, 1, 3, 3, () => [10, 20, 30, 255]),
      },
      { // Folder record closing the group.
        name: "Group", blendKey: "pass",
        blocks: [{ key: "lsct", payload: new Writer().u32(1).build() }],
      },
    ],
  });
  const { manifest, images } = parsePSD(bytes);
  const [child, folder] = manifest.layers;
  assert.equal(child.name, "Child");
  assert.equal(child.blendMode, "Multiply");
  assert.equal(child.isGroup, undefined);
  assert.equal(folder.name, "Group");
  assert.equal(folder.isGroup, true);
  assert.equal(folder.blendMode, "Normal"); // Folders are pass-through.
  assert.ok(!("imageFile" in folder));
  assert.deepEqual(folder.transform, { origin: { x: 0, y: 0 }, size: { width: 4, height: 4 } });
  assert.equal(child.parentID, folder.id);
  assert.notEqual(folder.id, child.id);
  assert.ok(images.has(child.imageFile));
  validateManifest(manifest);
});

test("rejects a group divider that is never closed", () => {
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [
      {
        name: "<Layer group>", flags: 2,
        blocks: [{ key: "lsct", payload: new Writer().u32(3).build() }],
      },
      {
        name: "Child", top: 0, left: 0, bottom: 2, right: 2,
        channels: rawPlanes(0, 0, 2, 2, () => [1, 2, 3, 255]),
      },
    ],
  });
  assert.throws(() => parsePSD(bytes), (error) =>
    error.code === "truncated"
    && error.message === "The Photoshop file could not be read. It may be damaged or incomplete.");
});

// ---- Layer masks ----

test("bakes a PSD layer mask onto the layer grid with the default filled outside", () => {
  const bytes = buildPSD({
    width: 4, height: 4,
    layers: [{
      name: "Masked", top: 0, left: 0, bottom: 2, right: 2,
      channels: [
        ...rawPlanes(0, 0, 2, 2, () => [80, 90, 100, 255]),
        { id: -2, compression: 0, rows: Uint8Array.from([0]) }, // 1×1 black patch.
      ],
      mask: { top: 1, left: 1, bottom: 2, right: 2, default: 255, flags: 0 },
    }],
  });
  const { manifest, images } = parsePSD(bytes);
  const layer = manifest.layers[0];
  assert.ok(layer.maskFile, "mask asset recorded");
  assert.equal(layer.maskEnabled, true);
  const png = decodePng(images.get(layer.maskFile));
  assert.equal(png.colorType, 0, "masks are 8-bit grayscale");
  assert.deepEqual([png.width, png.height], [2, 2]);
  assert.deepEqual(Array.from(png.pixels), [255, 255, 255, 0]); // Default 255, patch black.
  validateManifest(manifest);
});

test("keeps a disabled mask embedded but non-effecting", () => {
  const bytes = buildPSD({
    width: 4, height: 4,
    layers: [{
      name: "Masked off", top: 0, left: 0, bottom: 2, right: 2,
      channels: [
        ...rawPlanes(0, 0, 2, 2, () => [80, 90, 100, 255]),
        { id: -2, compression: 0, rows: Uint8Array.from([0, 128, 200, 255]) },
      ],
      mask: { top: 0, left: 0, bottom: 2, right: 2, default: 255, flags: 2 },
    }],
  });
  const { manifest, images } = parsePSD(bytes);
  const layer = manifest.layers[0];
  assert.equal(layer.maskEnabled, false);
  const png = decodePng(images.get(layer.maskFile));
  // The patch covers the whole grid, so it is used as-is.
  assert.deepEqual(Array.from(png.pixels), [0, 128, 200, 255]);
});

// ---- Blend modes (PSDTypes.LayerBlendMode.fromPSD) ----

test("maps blend mode keys and notes the ones the port lacks", () => {
  const solid = () => [10, 20, 30, 255];
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [
      {
        name: "Burn", top: 0, left: 0, bottom: 2, right: 2, blendKey: "idiv",
        channels: rawPlanes(0, 0, 2, 2, solid),
      },
      {
        name: "Dissolve", top: 0, left: 0, bottom: 2, right: 2, blendKey: "diss",
        channels: rawPlanes(0, 0, 2, 2, solid),
      },
    ],
  });
  const { manifest, notes } = parsePSD(bytes);
  assert.equal(manifest.layers[0].blendMode, "Color Burn");
  assert.equal(manifest.layers[1].blendMode, "Normal");
  assert.ok(notes.some((note) => note.startsWith("Dissolve: Blend mode “diss” isn’t supported and will be applied as Normal.")),
    `notes: ${notes.join(" | ")}`);
});

test("multiplies fill opacity into layers without effects", () => {
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [
      {
        name: "Fill", top: 0, left: 0, bottom: 2, right: 2, opacity: 255,
        channels: rawPlanes(0, 0, 2, 2, () => [1, 2, 3, 255]),
        blocks: [{ key: "iOpa", payload: Uint8Array.from([128]) }],
      },
      {
        name: "Effects", top: 0, left: 0, bottom: 2, right: 2, opacity: 128, blendKey: "norm",
        channels: rawPlanes(0, 0, 2, 2, () => [1, 2, 3, 255]),
        blocks: [{ key: "lrFX", payload: Uint8Array.from([0, 0, 0, 0]) }],
      },
    ],
  });
  const { manifest, notes } = parsePSD(bytes);
  const [fill, effects] = manifest.layers;
  // Fill 128/255 alone; the effects layer skips the fill multiplication.
  assert.ok(Math.abs(fill.opacity - 128 / 255) < 1e-9, `fill opacity ${fill.opacity}`);
  assert.ok(Math.abs(effects.opacity - 128 / 255) < 1e-9, `effects opacity ${effects.opacity}`);
  assert.ok(notes.some((note) => note.startsWith("Effects: Layer effects were discarded")));
});

// ---- Clipping masks (version 5 maskSourceID) ----

test("links a clipped layer to its base below", () => {
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [
      {
        name: "Base", top: 0, left: 0, bottom: 2, right: 2,
        channels: rawPlanes(0, 0, 2, 2, () => [255, 0, 0, 255]),
      },
      {
        name: "Clip", top: 0, left: 0, bottom: 2, right: 2, clipping: true, blendKey: "mul ",
        channels: rawPlanes(0, 0, 2, 2, () => [0, 255, 0, 255]),
      },
    ],
  });
  const { manifest } = parsePSD(bytes);
  const [base, clip] = manifest.layers;
  assert.equal(clip.maskSourceID, base.id);
  assert.equal(base.maskSourceID, undefined);
  validateManifest(manifest);
});

// ---- Adjustment layers (PSDAdjustments) ----

test("parses a Levels adjustment and skips unknown adjustment kinds", () => {
  const levl = new Writer();
  levl.u16(0); // Leading field the reader skips over.
  const ranges = [
    [32, 224, 16, 240, 120], // RGB: black, white, output black, output white, gamma 1.2.
    [0, 255, 0, 255, 100],
    [0, 255, 0, 255, 100],
    [0, 255, 0, 255, 100],
  ];
  for (const range of ranges) for (const value of range) levl.u16(value);
  while (levl.data.length < 292) levl.u8(0);
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [
      {
        name: "Brightness", top: 0, left: 0, bottom: 2, right: 2,
        blocks: [{ key: "brit", payload: Uint8Array.from([0, 0, 0, 0]) }],
      },
      {
        name: "Levels", top: 0, left: 0, bottom: 2, right: 2,
        blocks: [{ key: "levl", payload: levl.build() }],
      },
    ],
  });
  const { manifest, notes } = parsePSD(bytes);
  // Unknown adjustment kinds are skipped entirely, with a note.
  assert.equal(manifest.layers.length, 1);
  assert.equal(manifest.layers[0].name, "Levels");
  assert.ok(notes.some((note) => note.startsWith("Brightness: This adjustment type isn’t supported and was skipped.")));
  assert.ok(notes.some((note) => note.startsWith("Levels: Adjustment parameters may not match Photoshop exactly.")));
  const adjustment = manifest.layers[0].adjustment;
  assert.equal(adjustment.kind, "Levels");
  assert.deepEqual(adjustment.levels.ranges[0], { black: 32, gamma: 1.2, white: 224, outputBlack: 16, outputWhite: 240 });
  assert.deepEqual(adjustment.levels.ranges[3], { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 });
  assert.ok(!("imageFile" in manifest.layers[0]));
  validateManifest(manifest);
});

// ---- Text layers (PSDText) ----

function tyshFixture() {
  const engine = [
    "<<",
    " /EngineDict <<",
    "  /Editor << /Text (Hi\\rThere) >>",
    "  /StyleRun << /RunArray [ << /StyleSheet << /StyleSheetData <<",
    "   /Font 0",
    "   /FontSize 48",
    "   /FillColor << /Type 1 /Values [ 0.0 0.5 1.0 ] >>",
    "   /Tracking 0",
    "   /AutoLeading false",
    "   /Leading 60",
    "  >> >> >> ] >>",
    "  /ParagraphRun << /RunArray [ << /ParagraphSheet << /Properties << /Justification 2 >> >> >> ] >>",
    " >>",
    " /ResourceDict << /FontSet [ << /Name (Helvetica) >> << /Name (Times) >> ] >>",
    ">>",
  ].join("\n");
  const payload = new Writer();
  payload.u16(1); // Version.
  payload.f64(1).f64(0).f64(0).f64(1).f64(10).f64(20); // Identity transform at (10, 20).
  payload.u16(50);
  payload.u32(16); // Descriptor version.
  payload.u32(0); // Name: empty Unicode string.
  payload.u32(0).ascii("TxLr"); // ClassID: zero length means the 4-char class follows.
  payload.u32(3); // Three keys.
  payload.u32(0).ascii("Txt ").ascii("TEXT").utf16("Hi\rThere");
  const engineBytes = [...engine].map((ch) => ch.charCodeAt(0));
  // Keys longer than four characters carry their real Pascal length; four-char
  // classIDs are written with a zero length instead.
  payload.u32("EngineData".length).ascii("EngineData").ascii("tdta").u32(engineBytes.length).bytes(engineBytes);
  payload.u32(0).ascii("Ornt").ascii("enum").u32(0).ascii("Ornt").u32(0).ascii("Hrzn");
  return payload.build();
}

test("extracts editable text metadata from a TySh type layer", () => {
  const bytes = buildPSD({
    width: 40, height: 40,
    layers: [{
      name: "Type", top: 5, left: 6, bottom: 9, right: 10,
      channels: rawPlanes(5, 6, 9, 10, () => [0, 0, 0, 255]),
      blocks: [{ key: "TySh", payload: tyshFixture() }],
    }],
  });
  const { manifest, notes } = parsePSD(bytes);
  const layer = manifest.layers[0];
  assert.deepEqual(notes, []);
  const text = layer.text;
  assert.ok(text, "text metadata present");
  assert.equal(text.content, "Hi\nThere"); // \r normalized, and the descriptor's Txt matches.
  assert.equal(text.fontName, "Helvetica");
  assert.equal(text.fontSize, 48);
  assert.equal(text.alignment, "Center"); // Justification 2.
  assert.equal(text.leading, 60); // AutoLeading false honors Leading.
  assert.equal(text.tracking, 0);
  assert.deepEqual([text.red, text.green, text.blue], [0, 0.5, 1]);
  // The stored raster stays the display source.
  assert.ok(layer.imageFile);
  assert.deepEqual(layer.transform, { origin: { x: 6, y: 5 }, size: { width: 4, height: 4 } });
  validateManifest(manifest);
});

// ---- Vector shapes (PSDVector) ----

test("maps a fill-only vector rectangle onto a live shape layer", () => {
  const vogk = new Writer();
  vogk.ascii("keyOriginType").ascii("long").i32(1);
  vogk.ascii("keyOriginShapeBBox");
  vogk.ascii("Left").ascii("UntF").ascii("#Pxl").f64(2);
  vogk.ascii("Top ").ascii("UntF").ascii("#Pxl").f64(3);
  vogk.ascii("Rght").ascii("UntF").ascii("#Pxl").f64(6);
  vogk.ascii("Btom").ascii("UntF").ascii("#Pxl").f64(7);
  const soco = new Writer();
  soco.ascii("Rd  ").ascii("doub").f64(51);
  soco.ascii("Grn ").ascii("doub").f64(102);
  soco.ascii("Bl  ").ascii("doub").f64(153);
  const bytes = buildPSD({
    width: 20, height: 20,
    layers: [{
      name: "Rect", top: 0, left: 0, bottom: 0, right: 0,
      blocks: [
        { key: "vogk", payload: vogk.build() },
        { key: "SoCo", payload: soco.build() },
      ],
    }],
  });
  const { manifest, notes } = parsePSD(bytes);
  const layer = manifest.layers[0];
  assert.deepEqual(layer.shape, { kind: "Rectangle", red: 0.2, green: 0.4, blue: 0.6, cornerRadius: 0 });
  assert.deepEqual(layer.transform, { origin: { x: 2, y: 3 }, size: { width: 4, height: 4 } });
  assert.ok(!("imageFile" in layer), "live shapes redraw from metadata");
  assert.deepEqual(notes, []);
  validateManifest(manifest);
});

test("rasterizes vector layers it cannot map, keeping the stored pixels", () => {
  const vmsk = new Writer();
  vmsk.u32(6).u32(0); // Version + top-level path count, then a curvy vertex below.
  vmsk.i16(0);
  for (let i = 0; i < 24; i += 1) vmsk.u8(0);
  vmsk.i16(1); // A bezier vertex with control points away from the anchor.
  vmsk.i32(0x01000000).i32(0x01000000); // Incoming control point.
  vmsk.i32(0x02000000).i32(0x02000000); // Anchor.
  vmsk.i32(0x03000000).i32(0x03000000); // Outgoing control point.
  const soco = new Writer();
  soco.ascii("Rd  ").ascii("doub").f64(1);
  soco.ascii("Grn ").ascii("doub").f64(0);
  soco.ascii("Bl  ").ascii("doub").f64(0);
  const bytes = buildPSD({
    width: 10, height: 10,
    layers: [{
      name: "Curve", top: 2, left: 2, bottom: 4, right: 4,
      channels: rawPlanes(2, 2, 4, 4, () => [255, 0, 0, 255]),
      blocks: [
        { key: "vmsk", payload: vmsk.build() },
        { key: "SoCo", payload: soco.build() },
      ],
    }],
  });
  const { manifest, notes } = parsePSD(bytes);
  const layer = manifest.layers[0];
  assert.ok(!layer.shape, "no live shape metadata"); // The curve can't be mapped.
  assert.ok(layer.imageFile, "stored raster stands in");
  assert.deepEqual(layer.transform, { origin: { x: 2, y: 2 }, size: { width: 2, height: 2 } });
  assert.ok(notes.some((note) => note.startsWith("Curve: Vector shape was rasterized to pixels.")));
});

// ---- Names and resolution ----

test("prefers the luni Unicode name over the Pascal name", () => {
  const bytes = buildPSD({
    width: 2, height: 2,
    layers: [{
      name: "Pascal",
      top: 0, left: 0, bottom: 2, right: 2,
      channels: rawPlanes(0, 0, 2, 2, () => [0, 0, 0, 255]),
      blocks: [{ key: "luni", payload: new Writer().u32(4).u16(0x56fd).u16(0x9645).u16(0x5316).u16(0x0021).build() }],
    }],
  });
  const { manifest } = parsePSD(bytes);
  assert.equal(manifest.layers[0].name, "国际化!");
});

test("reads the document resolution from image resource 1005", () => {
  const bytes = buildPSD({
    width: 2, height: 2, resolution: 144,
    layers: [{
      name: "L", top: 0, left: 0, bottom: 2, right: 2,
      channels: rawPlanes(0, 0, 2, 2, () => [0, 0, 0, 255]),
    }],
  });
  const { manifest } = parsePSD(bytes);
  assert.equal(manifest.resolution, 144);
});

test("returns an empty document when the layer section is absent", () => {
  const bytes = buildPSD({ width: 3, height: 3, layers: [] });
  const { manifest, images, notes } = parsePSD(bytes);
  assert.deepEqual([manifest.width, manifest.height], [3, 3]);
  assert.deepEqual(manifest.layers, []);
  assert.equal(images.size, 0);
  assert.deepEqual(notes, []);
  validateManifest(manifest);
});
