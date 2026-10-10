// PSD import: parses Photoshop .psd/.psb files (8-bit RGB, import only) into a
// Compositor manifest plus PNG-encoded assets, mirroring the macOS app's
// Compositor/IO/PSD readers (PSDReader, PSDChannelCoder, PSDDocumentBuilder,
// PSDTypes, PSDText, PSDVector). Pure JS with no DOM dependency so the module
// also runs under `node --test`; PNGs are written by a minimal stored-deflate
// encoder instead of OffscreenCanvas.

import {
  PROJECT_FORMAT, SAVE_VERSION, MAX_SIDE, MAX_SURFACE_PIXELS, MAX_LAYERS,
  TEXT_FONT_SIZE, TEXT_TRACKING, TEXT_LEADING, TEXT_MAX_UTF16, TEXT_PADDING,
  TEXT_BOX_MIN, defaultTextStyle, defaultAdjustment, normalizeLevelRange, clampRange,
} from "./format.js";

// ---- PSD format constants (Adobe "Photoshop File Formats Specification", 2019) ----

export const PSD_SIGNATURE = "8BPS"; // File signature and every section signature.
export const PSD_VERSION = 1;        // Classic PSD.
export const PSB_VERSION = 2;        // Large-document PSB (64-bit lengths).
export const BIT_DEPTH_8 = 8;
export const COLOR_MODE_RGB = 3;

export const RESOURCE_ID_RESOLUTION = 1005; // ResolutionInfo; first fixed-point 16.16 value.
export const RESOLUTION_FIXED_SCALE = 65536;

export const CHANNEL_TRANSPARENCY = -1; // Layer alpha plane.
export const CHANNEL_USER_MASK = -2;    // Layer mask plane.
// Only these channel ids are decoded; spot and other extra ids are skipped before decode.
export const UNPACKED_CHANNEL_IDS = new Set([CHANNEL_TRANSPARENCY, 0, 1, 2, CHANNEL_USER_MASK]);

export const COMPRESSION_RAW = 0;     // Plane stored as raw bytes.
export const COMPRESSION_RLE = 1;     // PackBits, with per-row byte counts.

export const MAX_CHANNELS_PER_LAYER = 56;

// 'lsct'/'lsdk' section-divider types. Photoshop stores groups bottom-to-top:
// type 3 opens ("<Layer group>"), then the children, then the folder itself (type 1
// open / 2 collapsed) closes it.
export const SECTION_DIVIDER_OPEN = 3;
export const SECTION_DIVIDER_FOLDER = 1; // Type 2 (collapsed) assembles the same way.

// In PSB files these additional-info keys carry 8-byte lengths.
export const PSB_LARGE_INFO_KEYS = new Set([
  "LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD",
]);

// Total imported raster budget, DocumentLimits.documentPixelBudget at its
// 16 GB ceiling (the Swift value scales with physical memory; the port pins it).
export const PSD_PIXEL_BUDGET = 800_000_000;

// Layer blend-mode signature keys → the port's BLEND_MODES (PSDTypes.swift,
// LayerBlendMode.fromPSD). Keys without a port equivalent — Dissolve, Darker
// Color, Lighter Color and every extended mode — are deliberately absent: they
// fall back to Normal and produce a conversion note, exactly as on macOS.
export const PSD_BLEND_KEYS = {
  "norm": "Normal",
  "mul ": "Multiply",
  "scrn": "Screen",
  "over": "Overlay",
  "dark": "Darken",
  "lite": "Lighten",
  "diff": "Difference",
  "div ": "Color Dodge",
  "idiv": "Color Burn",
};

// ---- Errors: copy mirrors PSDError / ImageImportError verbatim ----

export class PSDError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PSDError";
    this.code = code;
  }
}

const PSD_ERROR_MESSAGES = {
  truncated: "The Photoshop file could not be read. It may be damaged or incomplete.",
  unsupportedVersion: "This Photoshop file uses a format version Compositor can’t read.",
  unsupportedDepth: "Only 8-bit RGB Photoshop files can be imported.",
  unsupportedColorMode: "Only 8-bit RGB Photoshop files can be imported.",
  unsupportedCompression: "This Photoshop file uses a layer compression method that isn’t supported.",
  unreadable: "The image could not be read. It may be damaged or unavailable.",
  tooLarge: "This import exceeds the current 800-megapixel document budget or 30,000-pixel side limit.",
};

const psdError = (code) => new PSDError(code, PSD_ERROR_MESSAGES[code]);

// ---- Conversion notes: copy mirrors PSDDocumentBuilder.makeImport / PSDText verbatim ----

const NOTE_CROPPED = "Cropped to the canvas so the file fits in memory. Pixels outside the canvas weren’t imported.";
const NOTE_SMART_OBJECT = "The smart object was rasterized. Linked contents can’t be edited.";
const NOTE_EFFECTS = "Layer effects were discarded, so the appearance may differ.";
const NOTE_VECTOR_RASTERIZED = "Vector shape was rasterized to pixels.";
const NOTE_OTHER_KIND = "This Photoshop layer type isn’t supported and was imported as pixels.";
const NOTE_ADJUSTMENT_SKIPPED = "This adjustment type isn’t supported and was skipped.";
const NOTE_ADJUSTMENT_APPROX = "Adjustment parameters may not match Photoshop exactly.";
const NOTE_CLIPPING_SKIPPED = "This clipping mask’s base isn’t supported, so clipping was skipped.";
const NOTE_TEXT_RASTERIZED = "Editable Photoshop text becomes pixels and can’t be retyped.";
const NOTE_WARP = "The Photoshop text warp was omitted.";
const NOTE_FAUX = "Faux bold or faux italic was omitted.";
const NOTE_JUSTIFY = "Full justification was imported as left alignment.";
const NOTE_FIRST_STYLE = "Only the first text style was kept.";
const NOTE_STROKE = "The Photoshop stroke isn’t supported on shape layers and was omitted.";

const ADJUSTMENT_INFO_KEYS = new Set([
  "levl", "curv", "hue2", "hue ", "expA", "grdm", "brit", "blnc", "nvrt",
  "thrs", "post", "mixr", "selc", "blwh", "phfl", "vibA",
]);

// ---- Public API ----

// parsePSD(arrayBuffer) → { manifest, images: Map(file → Uint8Array PNG), notes }
// The manifest is a fresh version-11 document (not persisted; the user saves it
// as .comp). Layers are bottom-to-top; assets are named <layer id>.png with
// masks as <layer id>.mask.png per docs/project-format.md.
export function parsePSD(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  return buildImport(readPSD(bytes));
}

// File-type detection, mirroring PSDReader.matches.
export function matchesPSD(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes.length >= 4
    && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53;
}

// ---- Cursor (PSDReader.PSDCursor) ----

class PSDCursor {
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = 0;
  }

  get remaining() { return this.data.length - this.offset; }

  need(count) {
    if (count < 0 || this.offset + count > this.data.length) throw psdError("truncated");
  }

  skip(count) {
    if (count < 0) throw psdError("truncated");
    this.need(count);
    this.offset += count;
  }

  u8() { this.need(1); return this.data[this.offset++]; }
  u16() { this.need(2); const v = this.view.getUint16(this.offset); this.offset += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.offset); this.offset += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.offset); this.offset += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.offset); this.offset += 8; return v; }

  u64() {
    this.need(8);
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw psdError("tooLarge");
    return Number(value);
  }

  bytes(count) {
    this.need(count);
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  string(count) {
    let text = "";
    const raw = this.bytes(count);
    for (let i = 0; i < raw.length; i += 1) text += String.fromCharCode(raw[i]);
    return text;
  }
}

function checkedLength(value) {
  if (value > Number.MAX_SAFE_INTEGER) throw psdError("tooLarge");
  return value;
}

function u32of(data, offset) {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function i32of(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

// ---- Reader (PSDReader.read) ----

function readPSD(data) {
  const cursor = new PSDCursor(data);
  if (cursor.string(4) !== PSD_SIGNATURE) throw psdError("unreadable");
  const version = cursor.u16();
  if (version !== PSD_VERSION && version !== PSB_VERSION) throw psdError("unsupportedVersion");
  const isPSB = version === PSB_VERSION;
  cursor.skip(6);
  cursor.u16(); // Channel count of the merged image; layer planes are picked by id instead.
  const canvasHeight = cursor.u32();
  const canvasWidth = cursor.u32();
  const depth = cursor.u16();
  const mode = cursor.u16();
  if (!(canvasWidth >= 1 && canvasWidth <= MAX_SIDE) || !(canvasHeight >= 1 && canvasHeight <= MAX_SIDE)
    || canvasWidth * canvasHeight > MAX_SURFACE_PIXELS) {
    throw psdError("tooLarge");
  }
  if (depth !== BIT_DEPTH_8) throw psdError("unsupportedDepth");
  if (mode !== COLOR_MODE_RGB) throw psdError("unsupportedColorMode");
  cursor.skip(cursor.u32()); // Color Mode Data: none for RGB.

  // Image Resources: only ResolutionInfo (1005) is interpreted.
  const resourcesLength = cursor.u32();
  const resourcesEnd = cursor.offset + resourcesLength;
  let resolution = 72;
  while (cursor.offset + 12 <= resourcesEnd) {
    if (cursor.string(4) !== "8BIM") break;
    const id = cursor.u16();
    const nameLength = cursor.u8();
    cursor.skip(nameLength);
    if ((nameLength + 1) % 2 === 1) cursor.skip(1);
    const length = cursor.u32();
    const dataStart = cursor.offset;
    if (id === RESOURCE_ID_RESOLUTION && length >= 4) {
      resolution = cursor.u32() / RESOLUTION_FIXED_SCALE;
      if (!Number.isFinite(resolution) || resolution < 1) resolution = 72;
      resolution = Math.min(9600, Math.max(1, resolution));
    }
    cursor.offset = dataStart + length;
    if (length % 2 === 1) cursor.skip(1);
  }
  cursor.offset = resourcesEnd;

  const layerSection = checkedLength(isPSB ? cursor.u64() : cursor.u32());
  const layerSectionEnd = cursor.offset + layerSection;
  if (layerSection < 4) {
    return { width: canvasWidth, height: canvasHeight, resolution, records: [] };
  }
  checkedLength(isPSB ? cursor.u64() : cursor.u32()); // Layer info length; the records self-describe.
  const rawCount = cursor.i16();
  const count = Math.abs(rawCount);
  if (count > MAX_LAYERS) throw psdError("tooLarge");
  const raw = [];
  for (let i = 0; i < count; i += 1) raw.push(readRecord(cursor, isPSB));
  if (!fitsBudget(raw, PSD_PIXEL_BUDGET)) {
    for (const layer of raw) cropToCanvas(layer, canvasWidth, canvasHeight);
    if (!fitsBudget(raw, PSD_PIXEL_BUDGET)) throw psdError("tooLarge");
  }
  let usedPixels = 0;
  for (const layer of raw) {
    decodeChannels(cursor, layer, PSD_PIXEL_BUDGET - usedPixels, isPSB);
    if (layer.image) usedPixels += layer.image.width * layer.image.height;
  }
  cursor.offset = layerSectionEnd; // The merged-image section is skipped: layers carry pixels.
  const records = assemble(raw, canvasWidth, canvasHeight, PSD_PIXEL_BUDGET - usedPixels);
  return { width: canvasWidth, height: canvasHeight, resolution, records };
}

function readRecord(cursor, isPSB) {
  const layer = {
    name: "",
    top: 0, left: 0, bottom: 0, right: 0,
    sourceTop: 0, sourceLeft: 0, sourceBottom: 0, sourceRight: 0,
    opacity: 255, fill: 255,
    clipping: false, hidden: false,
    blendKey: "norm",
    channels: [],
    extra: {},
    maskTop: 0, maskLeft: 0, maskBottom: 0, maskRight: 0,
    sourceMaskTop: 0, sourceMaskLeft: 0, sourceMaskBottom: 0, sourceMaskRight: 0,
    maskDefault: 255, maskDisabled: false, maskLinked: true, maskFromRender: false,
    hasMask: false,
    section: null,
    image: null, maskImage: null,
    imageCrop: null, maskCrop: null,
    cropped: false,
  };
  layer.top = cursor.i32();
  layer.left = cursor.i32();
  layer.bottom = cursor.i32();
  layer.right = cursor.i32();
  layer.sourceTop = layer.top;
  layer.sourceLeft = layer.left;
  layer.sourceBottom = layer.bottom;
  layer.sourceRight = layer.right;
  const channelCount = cursor.u16();
  if (channelCount > MAX_CHANNELS_PER_LAYER) throw psdError("tooLarge");
  for (let i = 0; i < channelCount; i += 1) {
    const id = cursor.i16();
    const length = checkedLength(isPSB ? cursor.u64() : cursor.u32());
    layer.channels.push({ id, length });
  }
  if (cursor.string(4) !== "8BIM") throw psdError("truncated");
  layer.blendKey = cursor.string(4);
  layer.opacity = cursor.u8();
  layer.clipping = cursor.u8() !== 0;
  const flags = cursor.u8();
  layer.hidden = (flags & 2) !== 0;
  cursor.skip(1);
  const extraLength = cursor.u32();
  const extraEnd = cursor.offset + extraLength;

  const maskLength = cursor.u32();
  const maskEnd = cursor.offset + maskLength;
  if (maskEnd - cursor.offset >= 20) {
    layer.hasMask = true;
    layer.maskTop = cursor.i32();
    layer.maskLeft = cursor.i32();
    layer.maskBottom = cursor.i32();
    layer.maskRight = cursor.i32();
    layer.sourceMaskTop = layer.maskTop;
    layer.sourceMaskLeft = layer.maskLeft;
    layer.sourceMaskBottom = layer.maskBottom;
    layer.sourceMaskRight = layer.maskRight;
    layer.maskDefault = cursor.u8();
    const maskFlags = cursor.u8();
    layer.maskDisabled = (maskFlags & 2) !== 0;
    layer.maskLinked = (maskFlags & 1) === 0;
    layer.maskFromRender = (maskFlags & 8) !== 0;
  }
  cursor.offset = maskEnd;
  cursor.skip(cursor.u32()); // Layer blending ranges.
  const nameCount = cursor.u8();
  layer.name = decodeLayerName(cursor.bytes(nameCount));
  cursor.skip((4 - ((nameCount + 1) % 4)) % 4);

  while (cursor.offset + 12 <= extraEnd) {
    const signature = cursor.string(4);
    if (signature !== "8BIM" && signature !== "8B64") break;
    const key = cursor.string(4);
    let length;
    if (signature === "8B64" || (isPSB && PSB_LARGE_INFO_KEYS.has(key))) {
      if (cursor.offset + 8 > extraEnd) break;
      length = checkedLength(cursor.u64());
    } else {
      length = cursor.u32();
    }
    const payload = cursor.bytes(length);
    if (length % 2 === 1) cursor.skip(1);
    layer.extra[key] = payload;
    if (key === "luni") {
      const unicode = unicodeName(payload);
      if (unicode !== null) layer.name = unicode;
    }
    if (key === "iOpa" && payload.length > 0) layer.fill = payload[0];
    if ((key === "lsct" || key === "lsdk") && payload.length >= 4) layer.section = u32of(payload, 0);
  }
  cursor.offset = extraEnd;
  return layer;
}

// Pascal names are MacRoman (TextDecoder's "macintosh"); Latin-1 is the fallback.
function decodeLayerName(bytes) {
  try {
    return new TextDecoder("macintosh").decode(bytes);
  } catch {
    let text = "";
    for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return text;
  }
}

function unicodeName(data) {
  if (data.length < 4) return null;
  const count = u32of(data, 0);
  if (count === 0 || data.length < 4 + count * 2) return null;
  const units = new Array(count);
  for (let i = 0; i < count; i += 1) units[i] = (data[4 + i * 2] << 8) | data[5 + i * 2];
  let start = 0, end = units.length;
  while (start < end && units[start] === 0) start += 1;
  while (end > start && units[end - 1] === 0) end -= 1;
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(units[i]);
  return text;
}

// ---- Pixel budget and canvas cropping (PSDReader.fitsBudget / cropToCanvas) ----

function fitsBudget(layers, remainingPixels) {
  let usedPixels = 0;
  for (const layer of layers) {
    const width = Math.max(0, layer.right - layer.left);
    const height = Math.max(0, layer.bottom - layer.top);
    const maskWidth = Math.max(0, layer.maskRight - layer.maskLeft);
    const maskHeight = Math.max(0, layer.maskBottom - layer.maskTop);
    if (!fitsWithin(width, height, maskWidth, maskHeight, layer.hasMask, remainingPixels - usedPixels)) return false;
    if (width > 0 && height > 0) usedPixels += width * height;
  }
  return true;
}

function fitsWithin(width, height, maskWidth, maskHeight, hasMask, remainingPixels) {
  const budget = Math.max(0, remainingPixels);
  if (width > 0 && height > 0
    && !(width <= MAX_SIDE && height <= MAX_SIDE && width * height <= budget)) return false;
  if (hasMask && maskWidth > 0 && maskHeight > 0
    && !(maskWidth <= MAX_SIDE && maskHeight <= MAX_SIDE && maskWidth * maskHeight <= budget)) return false;
  return true;
}

function cropToCanvas(layer, canvasWidth, canvasHeight) {
  const imageCrop = cropRect(layer.left, layer.top, layer.right, layer.bottom, canvasWidth, canvasHeight);
  if (imageCrop.x !== 0 || imageCrop.y !== 0
    || imageCrop.width !== layer.right - layer.left || imageCrop.height !== layer.bottom - layer.top) {
    layer.left += imageCrop.x;
    layer.top += imageCrop.y;
    layer.right = layer.left + imageCrop.width;
    layer.bottom = layer.top + imageCrop.height;
    layer.imageCrop = imageCrop;
    layer.cropped = true;
  }
  if (!layer.hasMask) return;
  const maskCrop = cropRect(layer.maskLeft, layer.maskTop, layer.maskRight, layer.maskBottom, canvasWidth, canvasHeight);
  if (maskCrop.x !== 0 || maskCrop.y !== 0
    || maskCrop.width !== layer.maskRight - layer.maskLeft || maskCrop.height !== layer.maskBottom - layer.maskTop) {
    layer.maskLeft += maskCrop.x;
    layer.maskTop += maskCrop.y;
    layer.maskRight = layer.maskLeft + maskCrop.width;
    layer.maskBottom = layer.maskTop + maskCrop.height;
    layer.maskCrop = maskCrop;
    layer.cropped = true;
  }
}

function cropRect(left, top, right, bottom, canvasWidth, canvasHeight) {
  const croppedLeft = Math.min(canvasWidth, Math.max(0, left));
  const croppedTop = Math.min(canvasHeight, Math.max(0, top));
  const croppedRight = Math.max(croppedLeft, Math.min(canvasWidth, right));
  const croppedBottom = Math.max(croppedTop, Math.min(canvasHeight, bottom));
  return {
    x: croppedLeft - left,
    y: croppedTop - top,
    width: croppedRight - croppedLeft,
    height: croppedBottom - croppedTop,
  };
}

// ---- Channel decoding (PSDChannelCoder) ----

function decodeChannels(cursor, layer, remainingPixels, isPSB) {
  const planes = new Map();
  const width = Math.max(0, layer.right - layer.left);
  const height = Math.max(0, layer.bottom - layer.top);
  const maskWidth = Math.max(0, layer.maskRight - layer.maskLeft);
  const maskHeight = Math.max(0, layer.maskBottom - layer.maskTop);
  if (!fitsWithin(width, height, maskWidth, maskHeight, layer.hasMask, remainingPixels)) throw psdError("tooLarge");
  const sourceWidth = Math.max(0, layer.sourceRight - layer.sourceLeft);
  const sourceHeight = Math.max(0, layer.sourceBottom - layer.sourceTop);
  const sourceMaskWidth = Math.max(0, layer.sourceMaskRight - layer.sourceMaskLeft);
  const sourceMaskHeight = Math.max(0, layer.sourceMaskBottom - layer.sourceMaskTop);
  for (const channel of layer.channels) {
    const start = cursor.offset;
    try {
      if (!UNPACKED_CHANNEL_IDS.has(channel.id) || channel.length < 2) continue;
      const compression = cursor.u16();
      const payload = cursor.bytes(channel.length - 2);
      const isMask = channel.id === CHANNEL_USER_MASK;
      const sourceW = isMask ? sourceMaskWidth : sourceWidth;
      const sourceH = isMask ? sourceMaskHeight : sourceHeight;
      const targetW = isMask ? maskWidth : width;
      const targetH = isMask ? maskHeight : height;
      const crop = isMask ? layer.maskCrop : layer.imageCrop;
      if (targetW > 0 && targetH > 0) {
        planes.set(channel.id, decodeChannel(compression, sourceW, sourceH, payload, isPSB, crop));
      }
    } finally {
      cursor.offset = start + Math.max(0, channel.length);
    }
  }
  if (layer.hasMask && maskWidth > 0 && maskHeight > 0) {
    const gray = planes.get(CHANNEL_USER_MASK);
    if (gray && gray.length >= maskWidth * maskHeight) {
      layer.maskImage = { width: maskWidth, height: maskHeight, data: gray };
    }
  }
  if (width <= 0 || height <= 0) return;
  const black = new Uint8Array(width * height);
  const opaque = new Uint8Array(width * height).fill(255);
  const red = planes.get(0) || black;
  const green = planes.get(1) || black;
  const blue = planes.get(2) || black;
  const alpha = planes.get(CHANNEL_TRANSPARENCY) || opaque;
  if (red.length < width * height || green.length < width * height
    || blue.length < width * height || alpha.length < width * height) {
    throw psdError("truncated");
  }
  layer.image = rgbaImage(width, height, red, green, blue, alpha);
}

function decodeChannel(compression, width, height, data, largeDocument, crop) {
  if (width <= 0 || height <= 0) return new Uint8Array(0);
  if (!crop) {
    const expected = width * height;
    if (compression === COMPRESSION_RAW) {
      if (data.length < expected) throw psdError("truncated");
      return data.slice(0, expected);
    }
    if (compression === COMPRESSION_RLE) return unpackRLE(width, height, data, largeDocument, null);
    throw psdError("unsupportedCompression");
  }
  if (crop.x < 0 || crop.y < 0 || crop.width < 0 || crop.height < 0
    || crop.x + crop.width > width || crop.y + crop.height > height) throw psdError("truncated");
  if (crop.width === 0 || crop.height === 0) return new Uint8Array(0);
  if (compression === COMPRESSION_RAW) return cropRaw(width, height, data, crop);
  if (compression === COMPRESSION_RLE) return unpackRLE(width, height, data, largeDocument, crop);
  throw psdError("unsupportedCompression");
}

function cropRaw(width, height, data, crop) {
  if (data.length < width * height) throw psdError("truncated");
  const plane = new Uint8Array(crop.width * crop.height);
  for (let row = 0; row < crop.height; row += 1) {
    const sourceStart = (crop.y + row) * width + crop.x;
    plane.set(data.subarray(sourceStart, sourceStart + crop.width), row * crop.width);
  }
  return plane;
}

// PackBits: n ≥ 0 copies n+1 literal bytes, n = -128 does nothing, otherwise
// 1 - n copies of the next byte. PSB row counts are 4 bytes wide.
function unpackRLE(width, height, data, largeDocument, crop) {
  let offset = 0;
  const next = () => {
    if (offset >= data.length) throw psdError("truncated");
    return data[offset++];
  };
  const counts = new Array(height);
  for (let row = 0; row < height; row += 1) {
    if (largeDocument) {
      counts[row] = ((next() << 24) | (next() << 16) | (next() << 8) | next()) >>> 0;
    } else {
      counts[row] = (next() << 8) | next();
    }
  }
  const plane = new Uint8Array((crop ? crop.width : width) * (crop ? crop.height : height));
  const rowBuffer = crop ? new Uint8Array(width) : null;
  for (let row = 0; row < height; row += 1) {
    const end = offset + counts[row];
    if (end > data.length) throw psdError("truncated");
    if (crop && (row < crop.y || row >= crop.y + crop.height)) {
      offset = end;
      continue;
    }
    let written = 0;
    while (written < width) {
      if (offset >= end) throw psdError("truncated");
      const n = data[offset] << 24 >> 24; // Int8
      offset += 1;
      if (n >= 0) {
        const count = n + 1;
        if (written + count > width || offset + count > end) throw psdError("truncated");
        const target = crop ? rowBuffer : plane;
        const base = crop ? written : row * width + written;
        for (let i = 0; i < count; i += 1) target[base + i] = data[offset + i];
        offset += count;
        written += count;
      } else if (n !== -128) {
        const count = 1 - n;
        if (written + count > width || offset >= end) throw psdError("truncated");
        const value = data[offset];
        offset += 1;
        const target = crop ? rowBuffer : plane;
        const base = crop ? written : row * width + written;
        for (let i = 0; i < count; i += 1) target[base + i] = value;
        written += count;
      }
    }
    if (crop) {
      plane.set(rowBuffer.subarray(crop.x, crop.x + crop.width), (row - crop.y) * crop.width);
    }
    offset = end;
  }
  return plane;
}

// Straight-alpha RGBA: PNG assets must not be premultiplied (the Swift
// premultiplies only because CGImage demands it; canvas compositing is
// equivalent either way, but a premultiplied PNG would darken edges).
function rgbaImage(width, height, red, green, blue, alpha) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = red[i];
    pixels[i * 4 + 1] = green[i];
    pixels[i * 4 + 2] = blue[i];
    pixels[i * 4 + 3] = alpha[i];
  }
  return { width, height, data: pixels };
}

// ---- Assembly (PSDReader.assemble) ----

function assemble(raw, canvasWidth, canvasHeight, remainingPixels) {
  const records = [];
  const groups = [];
  let remaining = Math.max(0, remainingPixels);
  for (const layer of raw) {
    if (layer.section === SECTION_DIVIDER_OPEN) {
      groups.push(uuid());
      continue;
    }
    const isGroup = layer.section === SECTION_DIVIDER_FOLDER || layer.section === 2;
    const id = isGroup ? (groups.pop() ?? uuid()) : uuid();
    const record = {
      id,
      parentID: groups[groups.length - 1] ?? null,
      name: layer.name || "Layer",
      isGroup,
      isVisible: !layer.hidden,
      blendKey: layer.blendKey,
      clipping: layer.clipping,
      croppedToCanvas: layer.cropped,
      kind: layerKind(layer, isGroup),
      opacity: 1,
      bounds: isGroup
        ? { x: 0, y: 0, width: canvasWidth, height: canvasHeight }
        : {
          x: layer.left, y: layer.top,
          width: Math.max(0, layer.right - layer.left),
          height: Math.max(0, layer.bottom - layer.top),
        },
      image: isGroup ? null : layer.image,
      mask: layer.maskFromRender ? null : layer.maskImage,
      maskBounds: {
        x: layer.maskLeft, y: layer.maskTop,
        width: layer.maskRight - layer.maskLeft,
        height: layer.maskBottom - layer.maskTop,
      },
      maskDefault: layer.maskDefault,
      maskEnabled: !layer.maskDisabled,
      maskLinked: layer.maskLinked,
      adjustment: null,
      shape: null,
      shapeNotes: [],
      text: null,
    };
    // Effects already dim the composite, so their layers keep the raw opacity;
    // everything else multiplies the fill opacity in.
    const hasEffects = record.kind === "effects"
      || Object.keys(layer.extra).some((key) => key === "lfx2" || key === "lrFX" || key === "lmfx");
    record.opacity = hasEffects
      ? layer.opacity / 255
      : (layer.opacity / 255) * (layer.fill / 255);
    if (record.kind === "text") {
      record.text = parseTextExtra(layer.extra);
    }
    // A type layer whose TySh cannot be mapped, or any non-group layer, can
    // still be a live vector shape (PSDText falls through to PSDVector.live).
    if (!record.text && !isGroup) {
      const live = vectorLive(layer.extra, canvasWidth, canvasHeight, remaining);
      if (live) {
        record.bounds = live.bounds;
        record.shape = live.style;
        record.shapeNotes = live.notes;
        record.kind = "vector";
        record.image = null;
        // The port live-rasterizes shapes from metadata, so no pixel budget is spent here.
      }
      // PSDVector.raster would re-render arbitrary paths; without a canvas the
      // stored channel raster stands in and the builder notes the fallback.
    }
    if (!isGroup) record.adjustment = parseAdjustment(layer.extra);
    if (record.adjustment) record.kind = "adjustment";
    records.push(record);
  }
  if (groups.length > 0) throw psdError("truncated");
  return records;
}

function hasAnyKey(extra, keys) {
  return keys.some((key) => key in extra);
}

function layerKind(layer, isGroup) {
  if (isGroup) return "group";
  if (hasAnyKey(layer.extra, ["TySh", "tySh", "txt2"])) return "text";
  if (hasAnyKey(layer.extra, ["vmsk", "vsms", "vogk"])) return "vector";
  if (hasAnyKey(layer.extra, ["SoLd", "SoLE"])) return "smartObject";
  if (hasAnyKey(layer.extra, ["lfx2", "lrFX", "lmfx"])) return "effects";
  if (hasAnyKey(layer.extra, [...ADJUSTMENT_INFO_KEYS])) return "adjustment";
  return "raster";
}

function uuid() {
  const random = globalThis.crypto;
  const bytes = new Uint8Array(16);
  if (random?.getRandomValues) random.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- Document builder (PSDDocumentBuilder.makeImport) ----

function buildImport(document) {
  const notes = [];
  const images = new Map();
  const layers = [];
  const canvas = { width: document.width, height: document.height };
  for (const record of document.records) {
    const layerNotes = [];
    if (record.croppedToCanvas) layerNotes.push(NOTE_CROPPED);
    if (record.kind === "text") {
      if (record.text) {
        layerNotes.push(...record.text.notes);
        const missing = missingFontNote(record.text.style.fontName);
        if (missing) layerNotes.push(missing);
      } else {
        layerNotes.push(NOTE_TEXT_RASTERIZED);
      }
    }
    if (record.kind === "smartObject") layerNotes.push(NOTE_SMART_OBJECT);
    if (record.kind === "effects") layerNotes.push(NOTE_EFFECTS);
    if (record.kind === "vector") {
      if (record.shape) layerNotes.push(...record.shapeNotes);
      else layerNotes.push(NOTE_VECTOR_RASTERIZED);
    }
    if (record.kind === "other") layerNotes.push(NOTE_OTHER_KIND);

    let blendMode = "Normal";
    if (record.isGroup) {
      if (record.blendKey !== "pass" && record.blendKey !== "norm") {
        layerNotes.push(`Folder blend mode “${record.blendKey.trim()}” isn’t supported. The folder will be pass-through.`);
      }
    } else {
      const mapped = PSD_BLEND_KEYS[record.blendKey];
      if (mapped) blendMode = mapped;
      else if (record.blendKey !== "pass") {
        layerNotes.push(`Blend mode “${record.blendKey.trim()}” isn’t supported and will be applied as Normal.`);
      }
    }
    if (record.kind === "adjustment") {
      if (!record.adjustment) layerNotes.push(NOTE_ADJUSTMENT_SKIPPED);
      else layerNotes.push(NOTE_ADJUSTMENT_APPROX);
    }
    for (const message of layerNotes) notes.push(`${record.name}: ${message}`);
    if (record.kind === "adjustment" && !record.adjustment) continue;

    const opacity = Math.min(1, Math.max(0, record.opacity));
    let layer;
    if (record.isGroup) {
      // Folders carry their own opacity, which multiplies into what's inside them.
      layer = {
        id: record.id, name: record.name, isVisible: record.isVisible, opacity,
        blendMode: "Normal", isGroup: true,
        transform: { origin: { x: 0, y: 0 }, size: { width: canvas.width, height: canvas.height } },
      };
    } else if (record.adjustment) {
      layer = {
        id: record.id, name: record.name, isVisible: record.isVisible, opacity, blendMode,
        transform: { origin: { x: 0, y: 0 }, size: { width: canvas.width, height: canvas.height } },
        adjustment: record.adjustment,
      };
    } else if (record.image) {
      const imageFile = `${record.id}.png`;
      images.set(imageFile, encodePngRGBA(record.image));
      layer = {
        id: record.id, name: record.name, isVisible: record.isVisible, opacity, blendMode,
        imageFile,
        transform: {
          origin: { x: record.bounds.x, y: record.bounds.y },
          size: { width: record.bounds.width, height: record.bounds.height },
        },
      };
    } else if (record.shape) {
      // Live shape: rasterized from its metadata by the renderer, like the
      // port's own Shape-tool layers.
      layer = {
        id: record.id, name: record.name, isVisible: record.isVisible, opacity, blendMode,
        transform: {
          origin: { x: record.bounds.x, y: record.bounds.y },
          size: { width: record.bounds.width, height: record.bounds.height },
        },
        shape: record.shape,
      };
    } else {
      layer = {
        id: record.id, name: record.name, isVisible: record.isVisible, opacity, blendMode,
        transform: { origin: { x: 0, y: 0 }, size: { width: canvas.width, height: canvas.height } },
      };
    }
    if (record.parentID) layer.parentID = record.parentID;
    // Text metadata rides on the layer whose raster already shows the type;
    // editing re-renders through the port's text engine.
    if (record.text && !record.adjustment) {
      layer.text = record.text.style;
      if (!record.image) layer.transform = textTransform(record.text);
    }
    if (record.mask) {
      const grid = record.image
        ? { width: record.image.width, height: record.image.height }
        : layer.transform.size;
      const plane = bakeMaskPlane(record, layer.transform, grid);
      const maskFile = `${record.id}.mask.png`;
      images.set(maskFile, encodePngGray(plane.width, plane.height, plane.data));
      layer.maskFile = maskFile;
      layer.maskEnabled = record.maskEnabled;
      // Linked masks stretch over the layer's own grid, which is what the bake produces.
    }
    layers.push(layer);
  }

  // Clipping masks (version 5 maskSourceID): a clipped layer multiplies the
  // alpha of the nearest supported layer below it in the same parent.
  const idToLayer = new Map(layers.map((layer) => [layer.id, layer]));
  const baseForParent = new Map();
  for (const record of document.records) {
    const layer = idToLayer.get(record.id);
    if (!layer) continue;
    if (record.clipping) {
      const baseID = baseForParent.get(record.parentID ?? null);
      const base = baseID ? idToLayer.get(baseID) : null;
      if (base && !base.isGroup && !base.adjustment && !layer.isGroup) {
        layer.maskSourceID = base.id;
      } else {
        notes.push(`${record.name}: ${NOTE_CLIPPING_SKIPPED}`);
      }
    } else if (!layer.isGroup && !layer.adjustment) {
      baseForParent.set(record.parentID ?? null, record.id);
    } else {
      baseForParent.set(record.parentID ?? null, null);
    }
  }

  return {
    manifest: {
      format: PROJECT_FORMAT,
      version: SAVE_VERSION,
      width: document.width,
      height: document.height,
      resolution: document.resolution,
      layers,
    },
    images,
    notes,
  };
}

function missingFontNote(name) {
  // Installed-font detection needs the browser's font list; in the WebView the
  // re-rendered text falls back to the system font exactly as the note says.
  try {
    if (typeof document === "undefined" || !document.fonts?.check) return null;
    if (document.fonts.check(`12px ${JSON.stringify(name)}`)) return null;
    return `The font “${name}” isn’t installed, so the text was drawn with the system font.`;
  } catch {
    return null;
  }
}

// A PSD mask stores only the patch that differs from the default. The port's
// linked masks stretch over the layer's own grid, so the patch is baked into
// that grid with the default filled everywhere else (PSDDocumentBuilder.
// maskOnLayerGrid). Adjustment layers and folders cover the canvas.
function bakeMaskPlane(record, placed, grid) {
  const patch = record.mask;
  const gridWidth = Math.max(1, Math.round(grid.width));
  const gridHeight = Math.max(1, Math.round(grid.height));
  const placedWidth = placed.size.width, placedHeight = placed.size.height;
  if (!(placedWidth > 0) || !(placedHeight > 0)
    || !(record.maskBounds.width > 0) || !(record.maskBounds.height > 0)) {
    return { width: gridWidth, height: gridHeight, data: patch.data };
  }
  const scaleX = gridWidth / placedWidth;
  const scaleY = gridHeight / placedHeight;
  const rect = {
    x: (record.maskBounds.x - placed.origin.x) * scaleX,
    y: (record.maskBounds.y - placed.origin.y) * scaleY,
    width: record.maskBounds.width * scaleX,
    height: record.maskBounds.height * scaleY,
  };
  const integral = {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x),
    height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y),
  };
  if (integral.x === 0 && integral.y === 0
    && integral.width === gridWidth && integral.height === gridHeight
    && patch.width === gridWidth && patch.height === gridHeight) {
    return { width: gridWidth, height: gridHeight, data: patch.data };
  }
  const plane = new Uint8Array(gridWidth * gridHeight).fill(record.maskDefault);
  if (rect.width >= 1 && rect.height >= 1) {
    const x0 = Math.max(0, integral.x), y0 = Math.max(0, integral.y);
    const x1 = Math.min(gridWidth, integral.x + integral.width);
    const y1 = Math.min(gridHeight, integral.y + integral.height);
    for (let y = y0; y < y1; y += 1) {
      const sy = Math.min(patch.height - 1, Math.max(0, Math.floor(((y - rect.y) / rect.height) * patch.height)));
      for (let x = x0; x < x1; x += 1) {
        const sx = Math.min(patch.width - 1, Math.max(0, Math.floor(((x - rect.x) / rect.width) * patch.width)));
        plane[y * gridWidth + x] = patch.data[sy * patch.width + sx];
      }
    }
  }
  return { width: gridWidth, height: gridHeight, data: plane };
}

// ---- Adjustment parsing (PSDAdjustments) ----

function parseAdjustment(extra) {
  if (extra.levl) return levelsAdjustment(extra.levl);
  if (extra.curv) return curvesAdjustment(extra.curv);
  const hueData = extra.hue2 || extra["hue "];
  if (hueData) return hueAdjustment(hueData);
  return null;
}

// 'levl': for RGB then red, green, blue — input black, input white, output
// black, output white and gamma, the last in hundredths.
function levelsAdjustment(data) {
  if (data.length < 292) return null;
  const adjustment = defaultAdjustment("Levels");
  adjustment.levels.ranges = [0, 1, 2, 3].map((channel) => {
    const base = 2 + channel * 10;
    return normalizeLevelRange({
      black: u16of(data, base),
      white: u16of(data, base + 2),
      outputBlack: u16of(data, base + 4),
      outputWhite: u16of(data, base + 6),
      gamma: u16of(data, base + 8) / 100,
    });
  });
  return adjustment;
}

// 'curv': an optional component count, a version (1 or 4), then per channel a
// point count and (output, input) pairs, clamped to 0–255.
function curvesAdjustment(data) {
  if (data.length < 5) return null;
  let offset = 0;
  if (data[offset] === 0) offset += 1;
  if (offset + 2 > data.length) return null;
  const version = u16of(data, offset);
  offset += 2;
  if (version !== 1 && version !== 4) return null;
  if (offset + 2 > data.length) return null;
  const count = u16of(data, offset);
  offset += 2;
  const adjustment = defaultAdjustment("Curves");
  for (let channel = 0; channel < Math.min(4, count); channel += 1) {
    if (offset + 2 > data.length) return null;
    const points = u16of(data, offset);
    offset += 2;
    const curve = [];
    for (let i = 0; i < points; i += 1) {
      if (offset + 4 > data.length) return null;
      const output = u16of(data, offset);
      const input = u16of(data, offset + 2);
      offset += 4;
      curve.push({ x: Math.min(255, Math.max(0, input)), y: Math.min(255, Math.max(0, output)) });
    }
    if (curve.length < 2) continue;
    curve.sort((a, b) => a.x - b.x);
    if (curve[0].x !== 0) curve.unshift({ x: 0, y: curve[0].y });
    if (curve[curve.length - 1].x !== 255) curve.push({ x: 255, y: curve[curve.length - 1].y });
    for (let i = 1; i < curve.length; i += 1) {
      if (curve[i].x <= curve[i - 1].x) return null; // Not a valid monotone curve.
    }
    adjustment.curves.channels[channel] = curve;
  }
  return adjustment;
}

// 'hue2': a version, the Colorize switch and a pad byte, the Colorize
// hue/saturation/lightness, the Master's, then for each band its four degrees
// and hue/saturation/lightness.
const COLOR_RANGES = ["Reds", "Yellows", "Greens", "Cyans", "Blues", "Magentas"];

function hueAdjustment(data) {
  if (data.length < 16) return null;
  const colorize = data[2] !== 0;
  const adjustment = defaultAdjustment("Hue/Saturation");
  const valuesAt = (offset) => ({
    hue: i16of(data, offset),
    saturation: i16of(data, offset + 2),
    lightness: i16of(data, offset + 4),
  });
  const master = valuesAt(colorize ? 4 : 10);
  adjustment.colorize = colorize;
  adjustment.hue = clampRange(master.hue, [-360, 360], 0);
  adjustment.saturation = clampRange(master.saturation, [-100, 100], 0);
  adjustment.lightness = clampRange(master.lightness, [-100, 100], 0);
  const settings = adjustment.hsvSettings;
  settings.colorize = colorize;
  settings.adjustments.Master = master;
  if (colorize) return adjustment;
  let offset = 16;
  for (const range of COLOR_RANGES) {
    if (offset + 14 > data.length) break;
    const degrees = (at) => {
      const value = i16of(data, at) % 360;
      return value < 0 ? value + 360 : value;
    };
    settings.bands[range] = {
      falloffStart: degrees(offset),
      rangeStart: degrees(offset + 2),
      rangeEnd: degrees(offset + 4),
      falloffEnd: degrees(offset + 6),
    };
    settings.adjustments[range] = valuesAt(offset + 8);
    offset += 14;
  }
  return adjustment;
}

function u16of(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function i16of(data, offset) {
  return (data[offset] << 8 | data[offset + 1]) << 16 >> 16;
}

// ---- Text layers (PSDText) ----

// Reads a Photoshop 6 type layer (`TySh`): version, a 2×3 transform, a text
// descriptor and an optional warp descriptor. The engine dictionary inside
// EngineData supplies font, size, color, tracking, leading and alignment.
function parseTextExtra(extra) {
  const data = extra.TySh || extra.tySh;
  if (!data || data.length > 8_000_000) return null;
  const reader = new DescriptorReader(data);
  if (reader.u16() !== 1) return null;
  const xx = reader.f64(), xy = reader.f64(), yx = reader.f64();
  const yy = reader.f64(), tx = reader.f64(), ty = reader.f64();
  if (![xx, xy, yx, yy, tx, ty].every((value) => Number.isFinite(value))) return null;
  if (reader.u16() !== 50) return null;
  const text = reader.descriptor(true);
  if (!text) return null;
  if (text.enumeration("Ornt") === "Vrtc") return null; // Vertical text stays a raster.
  const placed = textPlacement(xx, xy, yx, yy, tx, ty);
  if (!placed) return null;

  const notes = [];
  if (reader.remaining >= 2 && reader.u16() === 1) {
    const warp = reader.descriptor(true);
    const style = warp?.enumeration("warpStyle");
    if (style && style !== "warpNone" && style !== "none") notes.push(NOTE_WARP);
  }

  const engine = text.data("EngineData") ? engineValue(text.data("EngineData")) : null;
  const content = cleanedText(text.string("Txt ") ?? text.string("Txt"))
    ?? (engine ? cleanedText(stringOf(walk(engine, "EngineDict", "Editor", "Text"))) : null);
  if (!content || !content.length || content.length > TEXT_MAX_UTF16) return null;

  const style = defaultTextStyle();
  style.content = content;
  if (engine) applyTextStyle(style, engine, placed.pixelScale, notes);
  else style.fontSize = Math.min(2000, Math.max(1, 12 * placed.pixelScale));
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0) return null;

  let anchor = { x: placed.tx, y: placed.ty };
  let anchorIsFrame = false;
  const bounds = text.rect("bounds");
  const glyphs = text.rect("boundingBox");
  if (bounds && glyphs && bounds.width > glyphs.width + 4 && bounds.height > glyphs.height + 4
    && bounds.width > 1 && bounds.height > 1) {
    const frame = { width: bounds.width * placed.pixelScale, height: bounds.height * placed.pixelScale };
    const boxed = { ...style };
    boxed.boxSize = {
      width: frame.width + TEXT_PADDING * 2,
      height: frame.height + TEXT_PADDING * 2,
    };
    // A paragraph frame the model cannot store is dropped entirely.
    if (!isValidTextStyle(boxed)) return null;
    Object.assign(style, boxed);
    anchor = placed.map(bounds.x, bounds.y);
    anchorIsFrame = true;
  }
  if (!isValidTextStyle(style)) return null;
  return { style, notes, anchor, rotation: placed.rotation, flipY: placed.flipY, anchorIsFrame };
}

// Uniform scale, rotation and an optional vertical flip; shear and uneven
// scale return null. Engine sizes are text-space units the matrix maps into
// document pixels.
function textPlacement(xx, xy, yx, yy, tx, ty) {
  const scaleX = Math.hypot(xx, yx);
  if (!(scaleX > 1e-6)) return null;
  const cosR = xx / scaleX;
  const sinR = yx / scaleX;
  const localX = cosR * xy + sinR * yy;
  const localY = -sinR * xy + cosR * yy;
  const scaleY = Math.abs(localY);
  if (!(scaleY > 1e-6)) return null;
  const largest = Math.max(scaleX, scaleY);
  if (Math.abs(localX) > 0.02 * largest || Math.abs(scaleX - scaleY) > 0.02 * largest) return null;
  const pixelScale = scaleX;
  if (!Number.isFinite(pixelScale) || pixelScale <= 0) return null;
  const ySign = localY < 0 ? -1 : 1;
  const exx = cosR * pixelScale;
  const eyx = sinR * pixelScale;
  const exy = -sinR * pixelScale * ySign;
  const eyy = cosR * pixelScale * ySign;
  return {
    pixelScale,
    rotation: Math.atan2(sinR, cosR) * 180 / Math.PI,
    flipY: localY < 0,
    tx, ty,
    map: (x, y) => ({ x: exx * x + exy * y + tx, y: eyx * x + eyy * y + ty }),
  };
}

function applyTextStyle(style, engine, pixelScale, notes) {
  const runs = arrayOf(walk(engine, "EngineDict", "StyleRun", "RunArray"));
  const first = runs[0] ?? engine;
  const sheet = walk(first, "StyleSheet", "StyleSheetData") ?? walk(engine, "EngineDict", "StyleRun", "RunArray");
  const data = sheet ?? first;
  const points = numberOr(walk(data, "FontSize"), 12);
  if (Number.isFinite(points) && points > 0) {
    style.fontSize = Math.min(TEXT_FONT_SIZE.max, Math.max(TEXT_FONT_SIZE.min, points * pixelScale));
  }
  const fonts = arrayOf(walk(engine, "ResourceDict", "FontSet"));
  const index = Math.round(numberOr(walk(data, "Font"), 0));
  const name = stringOf(walk(fonts[index], "Name"));
  if (name) style.fontName = name;
  const values = arrayOf(walk(data, "FillColor", "Values"));
  if (values.length > 0) {
    const channels = values.map(numberOf).filter((value) => value !== null);
    const [red, green, blue] = textColor(channels);
    style.red = red;
    style.green = green;
    style.blue = blue;
  }
  const tracking = numberOf(walk(data, "Tracking"));
  if (tracking !== null && Number.isFinite(tracking)) {
    style.tracking = Math.min(TEXT_TRACKING.max, Math.max(TEXT_TRACKING.min, tracking * style.fontSize / 1000));
  }
  const auto = boolOr(walk(data, "AutoLeading"), true);
  if (!auto) {
    const leading = numberOf(walk(data, "Leading"));
    if (leading !== null && Number.isFinite(leading) && leading > 0) {
      style.leading = Math.min(TEXT_LEADING.max, Math.max(TEXT_LEADING.min, leading * pixelScale));
    }
  }
  if (boolOr(walk(data, "FauxBold"), false) || boolOr(walk(data, "FauxItalic"), false)) notes.push(NOTE_FAUX);
  if (runs.length > 1 && runs.slice(1).some((run) => styleSignature(run) !== styleSignature(first))) {
    notes.push(NOTE_FIRST_STYLE);
  }
  const paragraphs = arrayOf(walk(engine, "EngineDict", "ParagraphRun", "RunArray"));
  const justification = numberOf(walk(paragraphs[0] ?? engine, "ParagraphSheet", "Properties", "Justification"));
  switch (Math.round(justification ?? 0)) {
    case 1: style.alignment = "Right"; break;
    case 2: style.alignment = "Center"; break;
    case 0: style.alignment = "Left"; break;
    default:
      style.alignment = "Left";
      notes.push(NOTE_JUSTIFY);
  }
}

function styleSignature(run) {
  const data = walk(run, "StyleSheet", "StyleSheetData") ?? run;
  const channels = arrayOf(walk(data, "FillColor", "Values")).map(numberOf).filter((value) => value !== null);
  const [red, green, blue] = textColor(channels);
  return JSON.stringify([
    numberOf(walk(data, "Font")) ?? 0,
    numberOf(walk(data, "FontSize")) ?? 0,
    numberOf(walk(data, "Tracking")) ?? 0,
    boolOr(walk(data, "AutoLeading"), true),
    numberOf(walk(data, "Leading")) ?? 0,
    numberOf(walk(data, "HorizontalScale")) ?? 1,
    numberOf(walk(data, "VerticalScale")) ?? 1,
    boolOr(walk(data, "FauxBold"), false),
    boolOr(walk(data, "FauxItalic"), false),
    red, green, blue,
  ]);
}

// FillColor Values are CMYK (4), RGB (3) or gray (1); values above 1 are 0–255.
function textColor(values) {
  const unit = (value) => (value > 1 ? Math.min(255, Math.max(0, value)) / 255 : Math.min(1, Math.max(0, value)));
  if (values.length >= 4) return [unit(values[1]), unit(values[2]), unit(values[3])];
  if (values.length === 3) return [unit(values[0]), unit(values[1]), unit(values[2])];
  if (values.length > 0) {
    const gray = unit(values[0]);
    return [gray, gray, gray];
  }
  return [0, 0, 0];
}

// Transform for a text layer without a stored raster: the port's text
// rasterizer draws inside the transform box, so size it from the content and
// anchor it on the Photoshop insertion point (PSDText.layerTransform).
function textTransform(source) {
  const style = source.style;
  const lines = style.content.split("\n");
  const lineHeight = style.leading > 0 ? style.leading : style.fontSize * 1.2;
  const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 1);
  const image = {
    width: Math.max(1, Math.ceil(longest * style.fontSize * 0.6 + TEXT_PADDING * 2)),
    height: Math.max(1, Math.ceil(lines.length * lineHeight + TEXT_PADDING * 2)),
  };
  const anchor = source.anchorIsFrame
    ? { x: TEXT_PADDING, y: TEXT_PADDING }
    : {
      x: style.alignment === "Center" ? image.width / 2
        : style.alignment === "Right" ? image.width - TEXT_PADDING : TEXT_PADDING,
      y: TEXT_PADDING + style.fontSize * 0.8,
    };
  let local = { x: anchor.x - image.width / 2, y: anchor.y - image.height / 2 };
  if (source.flipY) local = { ...local, y: -local.y };
  const radians = source.rotation * Math.PI / 180;
  const rotated = {
    x: local.x * Math.cos(radians) - local.y * Math.sin(radians),
    y: local.x * Math.sin(radians) + local.y * Math.cos(radians),
  };
  const center = { x: source.anchor.x - rotated.x, y: source.anchor.y - rotated.y };
  return {
    origin: { x: center.x - image.width / 2, y: center.y - image.height / 2 },
    size: { width: image.width, height: image.height },
    rotation: source.rotation,
    flipY: source.flipY,
  };
}

function cleanedText(text) {
  if (text === null || text === undefined) return null;
  let value = text;
  while (value.startsWith("\uFEFF") || value.startsWith("\0")) value = value.slice(1);
  while (value.endsWith("\0")) value = value.slice(0, -1);
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function isValidTextStyle(style) {
  const inRange = (value, range) => Number.isFinite(value) && value >= range[0] && value <= range[1];
  if (!inRange(style.fontSize, [TEXT_FONT_SIZE.min, TEXT_FONT_SIZE.max])) return false;
  if (!["red", "green", "blue"].every((key) => inRange(style[key], [0, 1]))) return false;
  if (!inRange(style.tracking, [TEXT_TRACKING.min, TEXT_TRACKING.max])) return false;
  if (!inRange(style.leading, [TEXT_LEADING.min, TEXT_LEADING.max])) return false;
  if (style.boxSize) {
    const { width, height } = style.boxSize;
    if (!(width >= TEXT_BOX_MIN) || !(height >= TEXT_BOX_MIN)
      || width > MAX_SIDE || height > MAX_SIDE
      || width * height > MAX_SURFACE_PIXELS) return false;
  }
  return true;
}

// ---- Photoshop descriptor reader (PSDText.Reader) ----

// Descriptor values, tagged: string → text/enum/name, number, string data tag,
// plain object → descriptor, array → list. Booleans surface as numbers, as in
// the Swift reader.
// Typed accessors over parsed descriptor values, mirroring PSDText.swift's
// descriptor-dictionary extension. JS representation: text/enumeration →
// string, number → number, data → Uint8Array, descriptor → object, list →
// array. Helpers are non-enumerable so serialization sees only the data.
function withDescriptorHelpers(items) {
  return Object.defineProperties({ ...items }, {
    string: { value: (key) => (typeof items[key] === "string" ? items[key] : null), enumerable: false },
    enumeration: { value: (key) => (typeof items[key] === "string" ? items[key] : null), enumerable: false },
    data: { value: (key) => (items[key] instanceof Uint8Array ? items[key] : null), enumerable: false },
    rect: {
      value: (key) => {
        const nested = items[key];
        if (!nested || typeof nested !== "object" || nested instanceof Uint8Array) return null;
        const side = (name) => {
          const value = nested[name] ?? nested[name.trimEnd()];
          return typeof value === "number" && Number.isFinite(value) ? value : null;
        };
        const left = side("Left"), top = side("Top "), right = side("Rght"), bottom = side("Btom");
        if (left === null || top === null || right === null || bottom === null) return null;
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
      enumerable: false,
    },
  });
}

class DescriptorReader {
  constructor(data) {
    this.data = data;
    this.offset = 0;
  }

  get remaining() { return this.data.length - this.offset; }

  bytes(count) {
    if (count < 0 || this.offset + count > this.data.length) return null;
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  u8() {
    const raw = this.bytes(1);
    return raw ? raw[0] : null;
  }

  u16() {
    const raw = this.bytes(2);
    return raw ? (raw[0] << 8) | raw[1] : null;
  }

  u32() {
    const raw = this.bytes(4);
    return raw ? u32of(raw, 0) : null;
  }

  i32() {
    const raw = this.bytes(4);
    return raw ? (u32of(raw, 0) | 0) : null;
  }

  f64() {
    const raw = this.bytes(8);
    if (!raw) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    return view.getFloat64(0);
  }

  descriptor(versioned) {
    if (versioned && this.u32() !== 16) return null;
    if (this.unicode() === null || this.identifier() === null) return null;
    const count = this.u32();
    if (count === null || count > 10_000) return null;
    const items = {};
    for (let i = 0; i < count; i += 1) {
      const key = this.identifier();
      const type = this.fourCC();
      if (key === null || type === null) return null;
      const value = this.value(type);
      if (value === null) return null;
      items[key] = value;
    }
    return withDescriptorHelpers(items);
  }

  value(type) {
    switch (type) {
      case "doub": {
        const number = this.f64();
        return number === null ? null : number;
      }
      case "UntF": {
        if (this.fourCC() === null) return null;
        const number = this.f64();
        return number === null ? null : number;
      }
      case "long": {
        const number = this.i32();
        return number === null ? null : number;
      }
      case "comp": {
        const raw = this.bytes(8);
        if (!raw) return null;
        let bits = 0n;
        for (const byte of raw) bits = (bits << 8n) | BigInt(byte);
        return Number(BigInt.asIntN(64, bits));
      }
      case "bool": {
        return this.u8() === null ? null : 0;
      }
      case "TEXT": {
        return this.unicode();
      }
      case "enum": {
        if (this.identifier() === null) return null;
        return this.identifier();
      }
      case "tdta": {
        const length = this.u32();
        if (length === null || length > 8_000_000) return null;
        const raw = this.bytes(length);
        return raw ? raw : null;
      }
      case "Objc":
      case "GlbO":
        return this.descriptor(false);
      case "VlLs": {
        const count = this.u32();
        if (count === null || count > 10_000) return null;
        const items = [];
        for (let i = 0; i < count; i += 1) {
          const itemType = this.fourCC();
          if (itemType === null) return null;
          const item = this.value(itemType);
          if (item === null) return null;
          items.push(item);
        }
        return items;
      }
      case "alis": {
        const length = this.u32();
        if (length === null || length > 8_000_000 || this.bytes(length) === null) return null;
        return 0;
      }
      case "obj ":
        return this.reference() ? 0 : null;
      case "type":
      case "GlbC": {
        if (this.unicode() === null || this.identifier() === null) return null;
        return 0;
      }
      default:
        return null;
    }
  }

  // Skips a descriptor reference so a later EngineData item can still be read.
  reference() {
    const count = this.u32();
    if (count === null || count > 10_000) return false;
    for (let i = 0; i < count; i += 1) {
      const form = this.fourCC();
      if (form === null) return false;
      switch (form) {
        case "prop":
          if (this.unicode() === null || this.identifier() === null || this.identifier() === null) return false;
          break;
        case "Clss":
          if (this.unicode() === null || this.identifier() === null) return false;
          break;
        case "Enmr":
          if (this.unicode() === null || this.identifier() === null
            || this.identifier() === null || this.identifier() === null) return false;
          break;
        case "rele":
          if (this.unicode() === null || this.identifier() === null || this.i32() === null) return false;
          break;
        case "Idnt":
        case "indx":
          if (this.i32() === null) return false;
          break;
        case "name":
          if (this.unicode() === null) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  unicode() {
    const count = this.u32();
    if (count === null || count > 1_000_000) return null;
    const raw = this.bytes(count * 2);
    if (!raw) return null;
    if (raw.length === 0) return "";
    let text = "";
    for (let i = 0; i < count; i += 1) text += String.fromCharCode((raw[i * 2] << 8) | raw[i * 2 + 1]);
    return text;
  }

  identifier() {
    const length = this.u32();
    if (length === null) return null;
    if (length === 0) return this.fourCC();
    if (length > 10_000) return null;
    const raw = this.bytes(length);
    if (!raw) return null;
    let text = "";
    for (const byte of raw) text += String.fromCharCode(byte);
    return text;
  }

  fourCC() {
    const raw = this.bytes(4);
    if (!raw) return null;
    let text = "";
    for (const byte of raw) text += String.fromCharCode(byte);
    return text;
  }
}

// ---- Text engine dictionary (PSDText.EngineCursor): a small PostScript-like
// subset of `<< >>` dictionaries, arrays, names, numbers and strings. ----

function engineValue(data) {
  const dict = engineDictionary(data, 0);
  if (dict) return dict;
  const start = findBytes(data, [0x3c, 0x3c]); // "<<"
  if (start === null || start === 0) return null;
  return engineDictionary(data, start);
}

function engineDictionary(data, start) {
  const cursor = new EngineCursor(data);
  cursor.index = start;
  const value = cursor.parseValue();
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (!isPlainObject(current) || !(key in current)) return null;
    current = current[key];
  }
  return current;
}

function numberOf(value) {
  return typeof value === "number" ? value : null;
}

function numberOr(value, fallback) {
  const number = numberOf(value);
  return number === null ? fallback : number;
}

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringOf(value) {
  return typeof value === "string" ? value : null;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

class EngineCursor {
  constructor(data) {
    this.bytes = data;
    this.index = 0;
  }

  get peek() { return this.index < this.bytes.length ? this.bytes[this.index] : null; }

  peekAhead(ahead) {
    const at = this.index + ahead;
    return at < this.bytes.length ? this.bytes[at] : null;
  }

  parseValue() {
    this.skipWhitespace();
    const byte = this.peek;
    if (byte === null) return null;
    if (byte === 0x3c) { // "<"
      if (this.peekAhead(1) === 0x3c) return this.parseDictionary();
      return this.parseHex();
    }
    if (byte === 0x5b) return this.parseArray(); // "["
    if (byte === 0x28) return this.parseString(); // "("
    if (byte === 0x2f) { // "/"
      this.index += 1;
      return this.readToken();
    }
    if (byte === 0x2d || byte === 0x2b || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
      return this.parseNumber();
    }
    if (this.takeWord("true")) return true;
    if (this.takeWord("false")) return false;
    if (this.takeWord("null")) return "";
    return null;
  }

  parseDictionary() {
    if (!this.take("<<")) return null;
    const items = {};
    for (;;) {
      this.skipWhitespace();
      if (this.peek === null || this.peek === 0x3e) break; // ">"
      if (this.peek !== 0x2f) return null; // "/"
      this.index += 1;
      const key = this.readToken();
      const value = this.parseValue();
      if (value === null) return null;
      items[key] = value;
    }
    if (!this.take(">>")) return null;
    return items;
  }

  parseArray() {
    if (!this.take("[")) return null;
    const items = [];
    for (;;) {
      this.skipWhitespace();
      if (this.peek === null || this.peek === 0x5d) break; // "]"
      const value = this.parseValue();
      if (value === null) return null;
      items.push(value);
    }
    if (!this.take("]")) return null;
    return items;
  }

  parseNumber() {
    const start = this.index;
    if (this.peek === 0x2b || this.peek === 0x2d) this.index += 1; // "+" "-"
    while (this.peek !== null && this.peek >= 0x30 && this.peek <= 0x39) this.index += 1;
    if (this.peek === 0x2e) { // "."
      this.index += 1;
      while (this.peek !== null && this.peek >= 0x30 && this.peek <= 0x39) this.index += 1;
    }
    if (this.peek === 0x65 || this.peek === 0x45) { // "e" "E"
      this.index += 1;
      if (this.peek === 0x2b || this.peek === 0x2d) this.index += 1;
      while (this.peek !== null && this.peek >= 0x30 && this.peek <= 0x39) this.index += 1;
    }
    if (this.index === start) return null;
    let text = "";
    for (let i = start; i < this.index; i += 1) text += String.fromCharCode(this.bytes[i]);
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  parseString() {
    if (!this.take("(")) return null;
    const raw = [];
    for (;;) {
      const byte = this.peek;
      if (byte === null) return null;
      this.index += 1;
      if (byte === 0x29) break; // ")"
      if (byte === 0x5c) { // "\"
        const escaped = this.peek;
        if (escaped === null) return null;
        this.index += 1;
        if (escaped === 0x6e) raw.push(0x0a);           // \n
        else if (escaped === 0x72) raw.push(0x0d);      // \r
        else if (escaped === 0x74) raw.push(0x09);      // \t
        else if (escaped >= 0x30 && escaped <= 0x37) {  // octal
          let value = escaped - 0x30;
          for (let i = 0; i < 2; i += 1) {
            const digit = this.peek;
            if (digit === null || digit < 0x30 || digit > 0x37) break;
            this.index += 1;
            value = value * 8 + (digit - 0x30);
          }
          raw.push(value & 0xff);
        } else if (escaped !== 0x0a && escaped !== 0x0d) raw.push(escaped);
      } else {
        raw.push(byte);
      }
    }
    return decodeEngine(raw);
  }

  parseHex() {
    if (!this.take("<")) return null;
    const nibbles = [];
    for (;;) {
      const byte = this.peek;
      if (byte === null || byte === 0x3e) break; // ">"
      this.index += 1;
      const nibble = hexValue(byte);
      if (nibble !== null) nibbles.push(nibble);
    }
    if (!this.take(">")) return null;
    const raw = [];
    let i = 0;
    while (i + 1 < nibbles.length) {
      raw.push((nibbles[i] << 4) | nibbles[i + 1]);
      i += 2;
    }
    return decodeEngine(raw);
  }

  readToken() {
    const start = this.index;
    while (this.peek !== null && !isDelimiter(this.peek)) this.index += 1;
    let text = "";
    for (let i = start; i < this.index; i += 1) text += String.fromCharCode(this.bytes[i]);
    return text;
  }

  takeWord(word) {
    const encoded = [...word].map((ch) => ch.charCodeAt(0));
    if (this.index + encoded.length > this.bytes.length) return false;
    for (let i = 0; i < encoded.length; i += 1) {
      if (this.bytes[this.index + i] !== encoded[i]) return false;
    }
    const after = this.index + encoded.length;
    if (after < this.bytes.length && !isDelimiter(this.bytes[after])) return false;
    this.index = after;
    return true;
  }

  take(token) {
    const encoded = [...token].map((ch) => ch.charCodeAt(0));
    if (this.index + encoded.length > this.bytes.length) return false;
    for (let i = 0; i < encoded.length; i += 1) {
      if (this.bytes[this.index + i] !== encoded[i]) return false;
    }
    this.index += encoded.length;
    return true;
  }

  skipWhitespace() {
    for (;;) {
      const byte = this.peek;
      if (byte === null || (byte > 0x20 && byte !== 0x25)) return; // "%"
      if (byte === 0x25) {
        while (this.peek !== null && this.peek !== 0x0a && this.peek !== 0x0d) this.index += 1;
      } else {
        this.index += 1;
      }
    }
  }
}

function isDelimiter(byte) {
  return byte <= 0x20 || byte === 0x2f || byte === 0x3c || byte === 0x3e
    || byte === 0x5b || byte === 0x5d || byte === 0x28 || byte === 0x29;
}

function hexValue(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return null;
}

function decodeEngine(raw) {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    return text;
  }
  let text = "";
  for (const byte of raw) text += String.fromCharCode(byte);
  return text;
}

// ---- Vector shapes (PSDVector) ----

// Maps a Photoshop shape origination onto a live shape layer when it is a
// plain fill-only rectangle/ellipse (`vogk`, or a sharp-cornered `vmsk` path);
// everything else keeps the stored channel raster with a conversion note.
function vectorLive(extra, canvasWidth, canvasHeight, remainingPixels) {
  const stroke = extra.vstk;
  const fillEnabled = stroke ? strokeBool(stroke, "fillEnabled") : extra.SoCo != null;
  const strokeEnabled = stroke ? strokeBool(stroke, "strokeEnabled") : false;
  if (!fillEnabled) return null;
  const fill = extra.SoCo ? rgbOf(extra.SoCo) : null;
  if (!fill) return null;
  const origin = shapeOrigination(extra.vogk) ?? sharpRect(extra.vmsk || extra.vsms, canvasWidth, canvasHeight);
  if (!origin) return null;
  let box = integralRect(origin.bounds);
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  const budget = Math.min(MAX_SURFACE_PIXELS, Math.max(0, remainingPixels));
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)
    || Math.abs(box.width) > MAX_SIDE || Math.abs(box.height) > MAX_SIDE) throw psdError("tooLarge");
  if (box.width * box.height > budget) throw psdError("tooLarge");
  box = {
    x: box.x, y: box.y,
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.floor(box.height)),
  };
  const notes = [];
  if (strokeEnabled) notes.push(NOTE_STROKE);
  return {
    bounds: box,
    style: {
      kind: origin.kind,
      red: fill.r, green: fill.g, blue: fill.b,
      cornerRadius: origin.cornerRadius ?? 0,
    },
    notes,
  };
}

// CGRect.integral: smallest integer rect containing the rect.
function integralRect(rect) {
  const x = Math.floor(rect.x), y = Math.floor(rect.y);
  return {
    x, y,
    width: Math.ceil(rect.x + rect.width) - x,
    height: Math.ceil(rect.y + rect.height) - y,
  };
}

// Photoshop `vogk` origination: type 1/2 = rectangle (2 rounded), 5 = ellipse.
function shapeOrigination(data) {
  if (!data) return null;
  const type = keyLong(data, "keyOriginType");
  let kind;
  if (type === 1 || type === 2) kind = "Rectangle";
  else if (type === 5) kind = "Ellipse";
  else return null;
  const from = findKey(data, "keyOriginShapeBBox") ?? 0;
  const left = keyUnit(data, "Left", from);
  const top = keyUnit(data, "Top ", from);
  const right = keyUnit(data, "Rght", from);
  const bottom = keyUnit(data, "Btom", from);
  if (left === null || top === null || right === null || bottom === null) return null;
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  if (!(bounds.width >= 1) || !(bounds.height >= 1)
    || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  const origin = { kind, bounds, cornerRadius: 0 };
  if (kind === "Rectangle") {
    const radiiAt = findKey(data, "keyOriginRRectRadii");
    if (radiiAt !== null) {
      const radii = ["topLeft", "topRight", "bottomRight", "bottomLeft"]
        .map((key) => keyUnit(data, key, radiiAt))
        .filter((value) => value !== null);
      if (radii.length === 4) {
        const low = Math.min(...radii), high = Math.max(...radii);
        if (high - low > 0.5) return null; // Uneven radii: not a live shape.
        origin.cornerRadius = high;
      }
    }
  }
  return origin;
}

// A `vmsk` path whose four anchors are their own control points is a sharp
// rectangle, so it can become a live shape without rasterizing the path.
function sharpRect(data, canvasWidth, canvasHeight) {
  if (!data || data.length < 8 || canvasWidth <= 0 || canvasHeight <= 0) return null;
  let offset = 8;
  let remaining = 0;
  let sharp = true;
  const anchors = [];
  while (offset + 26 <= data.length) {
    const type = i16of(data, offset);
    const body = data.subarray(offset + 2, offset + 26);
    offset += 26;
    if (type === 0 || type === 3) {
      if (anchors.length > 0) return null;
      remaining = i16of(body, 0);
    } else if (type === 1 || type === 2 || type === 4 || type === 5) {
      if (remaining <= 0 || body.length < 24) continue;
      remaining -= 1;
      const incoming = pathPoint(body, 0, canvasWidth, canvasHeight);
      const anchor = pathPoint(body, 8, canvasWidth, canvasHeight);
      const outgoing = pathPoint(body, 16, canvasWidth, canvasHeight);
      if (Math.hypot(incoming.x - anchor.x, incoming.y - anchor.y) > 0.5
        || Math.hypot(outgoing.x - anchor.x, outgoing.y - anchor.y) > 0.5) {
        sharp = false;
      }
      anchors.push(anchor);
    }
  }
  if (!sharp || anchors.length !== 4) return null;
  const minX = Math.min(...anchors.map((p) => p.x));
  const maxX = Math.max(...anchors.map((p) => p.x));
  const minY = Math.min(...anchors.map((p) => p.y));
  const maxY = Math.max(...anchors.map((p) => p.y));
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  if (!(bounds.width >= 1) || !(bounds.height >= 1)) return null;
  return { kind: "Rectangle", bounds, cornerRadius: 0 };
}

// Fixed 24.8-unit vertex coordinates scale to the canvas.
function pathPoint(bytes, at, canvasWidth, canvasHeight) {
  const y = i32of(bytes, at) / 0x1000000;
  const x = i32of(bytes, at + 4) / 0x1000000;
  return { x: x * canvasWidth, y: y * canvasHeight };
}

function rgbOf(data) {
  const r = keyDouble(data, "Rd  ");
  const g = keyDouble(data, "Grn ");
  const b = keyDouble(data, "Bl  ");
  if (r === null || g === null || b === null) return null;
  const channel = (value) => (value > 1 ? Math.min(255, Math.max(0, value)) / 255 : Math.min(1, Math.max(0, value)));
  return { r: channel(r), g: channel(g), b: channel(b) };
}

function strokeBool(data, key) {
  const start = findKey(data, key);
  if (start === null) return null;
  const type = start + key.length;
  if (type + 5 > data.length || asciiOf(data, type, 4) !== "bool") return null;
  return data[type + 4] !== 0;
}

function keyUnit(data, key, from) {
  const keyAt = findKey(data, key, from);
  if (keyAt === null) return null;
  const unit = findKey(data, "UntF", keyAt);
  if (unit === null) return null;
  return f64at(data, unit + 8);
}

function keyDouble(data, key) {
  const start = findKey(data, key);
  if (start === null) return null;
  const type = start + key.length;
  if (type + 12 > data.length || asciiOf(data, type, 4) !== "doub") return null;
  return f64at(data, type + 4);
}

function keyLong(data, key) {
  const start = findKey(data, key);
  if (start === null) return null;
  const type = start + key.length;
  if (type + 8 > data.length || asciiOf(data, type, 4) !== "long") return null;
  return i32of(data, type + 4);
}

function f64at(data, offset) {
  if (offset + 8 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getFloat64(offset);
}

function asciiOf(data, offset, count) {
  let text = "";
  for (let i = 0; i < count; i += 1) text += String.fromCharCode(data[offset + i]);
  return text;
}

function findKey(data, key, from = 0) {
  if (from >= data.length) return null;
  const needle = [...key].map((ch) => ch.charCodeAt(0));
  return findBytes(data, needle, from);
}

function findBytes(data, needle, from = 0) {
  outer:
  for (let i = Math.max(0, from); i + needle.length <= data.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return null;
}

// ---- Minimal PNG encoder ----
// Stored-deflate zlib (no compression) + filter-0 scanlines: valid PNGs with
// no dependency on a canvas or a deflate implementation.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

function zlibStored(bytes) {
  const parts = [new Uint8Array([0x78, 0x01])]; // zlib header: deflate, 32 KiB window, fastest.
  let offset = 0;
  do {
    const length = Math.min(65535, bytes.length - offset);
    const isLast = offset + length >= bytes.length ? 1 : 0;
    const block = new Uint8Array(5 + length);
    block[0] = isLast;
    block[1] = length & 0xff;
    block[2] = (length >>> 8) & 0xff;
    block[3] = ~length & 0xff;
    block[4] = (~length >>> 8) & 0xff;
    block.set(bytes.subarray(offset, offset + length), 5);
    parts.push(block);
    offset += length;
  } while (offset < bytes.length);
  if (bytes.length === 0) parts.push(new Uint8Array([1, 0, 0, 0xff, 0xff]));
  const checksum = adler32(bytes);
  parts.push(new Uint8Array([(checksum >>> 24) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 8) & 0xff, checksum & 0xff]));
  return concatBytes(parts);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

// Interleaved 8-bit pixels (RGBA colorType 6 or grayscale colorType 0).
function encodePng(width, height, colorType, bytesPerPixel, pixels) {
  const stride = width * bytesPerPixel;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // Filter type None.
    raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const headerView = new DataView(ihdr.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  ihdr[8] = 8;        // Bit depth.
  ihdr[9] = colorType;
  ihdr[10] = 0;       // Deflate.
  ihdr[11] = 0;       // Adaptive filtering.
  ihdr[12] = 0;       // No interlace.
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlibStored(raw);
  const iend = new Uint8Array(0);
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", iend)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

function encodePngRGBA(image) {
  return encodePng(image.width, image.height, 6, 4, image.data);
}

function encodePngGray(width, height, gray) {
  return encodePng(width, height, 0, 1, gray);
}
