// Pixel kernels ported from the macOS app's C routines (AdjustPixels.c, NoisePixels.c).
// Canvas ImageData is straight (non-premultiplied) RGBA, so the C premultiply/unpremultiply
// steps collapse into plain channel math; all formulas otherwise match the originals.

import { srgbToLinear, linearToSrgb, rec709, rgbToHSL, hslToRGB, clamp01 } from "./color.js";

export function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function hash32(x) {
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

// Uniform in [0, 1) from an integer key.
function noiseUnit(key) {
  return (hash32(key) >>> 8) * (1 / 16777216);
}

// ---- Levels / exposure LUTs ----

export function exposureTable(exposure, offset, gamma) {
  const scale = Math.pow(2, exposure);
  const table = new Float32Array(256);
  for (let index = 0; index <= 255; index += 1) {
    const encoded = index / 255;
    let linear = srgbToLinear(encoded);
    linear = Math.pow(Math.max(0, linear * scale + offset), 1 / gamma);
    table[index] = linearToSrgb(linear);
  }
  return table;
}

export function applyLut(image, lut) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = clampByte(lut[data[i]] * 255);
    data[i + 1] = clampByte(lut[data[i + 1]] * 255);
    data[i + 2] = clampByte(lut[data[i + 2]] * 255);
  }
  return image;
}

// ---- Gradient Map (AdjustPixels.c adjust_gradient_map) ----

export function gradientMapLut(shadows, highlights, reversed) {
  const dark = reversed ? highlights : shadows;
  const light = reversed ? shadows : highlights;
  const table = new Uint8Array(256 * 3);
  for (let index = 0; index <= 255; index += 1) {
    const t = index / 255;
    for (let c = 0; c < 3; c += 1) {
      const channel = [dark.red, dark.green, dark.blue][c] + ([light.red, light.green, light.blue][c] - [dark.red, dark.green, dark.blue][c]) * t;
      table[index * 3 + c] = Math.min(255, Math.max(0, Math.round(channel * 255)));
    }
  }
  return table;
}

export function applyGradientMap(image, lut) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const level = Math.min(255, Math.round((2126 * data[i] + 7152 * data[i + 1] + 722 * data[i + 2] + 5000) / 10000));
    data[i] = Math.round((lut[level * 3] * a + 127) / 255);
    data[i + 1] = Math.round((lut[level * 3 + 1] * a + 127) / 255);
    data[i + 2] = Math.round((lut[level * 3 + 2] * a + 127) / 255);
  }
  return image;
}

// ---- Grain (AdjustPixels.c adjust_grain) ----

function lattice(ix, iy, seed) {
  const h = hash32(Math.imul(ix, 0x9e3779b1) ^ hash32(Math.imul(iy, 0x85ebca77) ^ seed));
  return ((h & 0xffff) / 65535 + (h >>> 16) / 65535) - 1;
}

function grainField(u, v, scale, seed) {
  const cellX = Math.floor(u / scale), cellY = Math.floor(v / scale);
  let tx = u / scale - cellX, ty = v / scale - cellY;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const ix = Math.trunc(cellX), iy = Math.trunc(cellY);
  const n00 = lattice(ix, iy, seed), n10 = lattice(ix + 1, iy, seed);
  const n01 = lattice(ix, iy + 1, seed), n11 = lattice(ix + 1, iy + 1, seed);
  const top = n00 + (n10 - n00) * tx;
  const bottom = n01 + (n11 - n01) * tx;
  return (top + (bottom - top) * ty) * 1.6;
}

// `origin` and `unitsPerPixel` place the image's pixels in document space so the
// pattern stays fixed however the canvas splits its drawing.
export function applyGrain(image, amount, size, roughness, seed, originX = 0, originY = 0, unitsPerPixel = 1) {
  if (!(amount > 0) || !(unitsPerPixel > 0)) return image;
  const width = image.width, height = image.height;
  const data = image.data;
  const strength = (amount > 100 ? 1.0 : amount / 100.0) * 0.35 * 255;
  const rough = Math.min(1, Math.max(0, roughness / 100));
  const fineSeed = hash32(seed ^ 0xa511e9b3);
  const detailSize = Math.max(0.5, (size > 0 ? size : 1) * 0.35);
  for (let y = 0; y < height; y += 1) {
    const v = originY + (y + 0.5) * unitsPerPixel;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a === 0) continue;
      const u = originX + (x + 0.5) * unitsPerPixel;
      const smooth = grainField(u, v, size, seed);
      const fine = grainField(u, v, detailSize, fineSeed);
      const noise = smooth + (fine - smooth) * rough;
      const level = Math.min(1, (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
      // Film grain shows most in the midtones.
      const delta = noise * strength * (0.4 + 2.4 * level * (1 - level));
      data[i] = clampByte(data[i] + delta);
      data[i + 1] = clampByte(data[i + 1] + delta);
      data[i + 2] = clampByte(data[i + 2] + delta);
    }
  }
  return image;
}

// ---- Add Noise (NoisePixels.c noise_add_at) ----

export function applyNoise(image, amount, gaussian, monochromatic, seed, originX = 0, originY = 0) {
  const width = image.width, height = image.height;
  const data = image.data;
  const spread = (amount / 100) * 127.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const px = (originX + x) >>> 0;
      const py = (originY + y) >>> 0;
      const base = hash32(seed ^ hash32(Math.imul(px, 0x9e3779b9) ^ hash32(Math.imul(py, 0x85ebca6b))));
      for (let c = 0; c < 3; c += 1) {
        const key = monochromatic ? base : (base + Math.imul(c, 0x9e3779b9)) >>> 0;
        let n;
        if (gaussian) {
          // Box–Muller: two uniform values make one normally distributed one.
          const u1 = noiseUnit(key), u2 = noiseUnit(key ^ 0x68e31da4);
          n = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(6.2831853 * u2) * spread * (2 / 3);
        } else {
          n = (noiseUnit(key) * 2 - 1) * spread;
        }
        const value = data[i + c] + n;
        data[i + c] = clampByte(Math.round(value));
      }
    }
  }
  return image;
}

// ---- Black & White (AdjustPixels.c adjust_black_white) ----

export function applyBlackWhite(image, settings) {
  const weights = [settings.reds, settings.yellows, settings.greens, settings.cyans, settings.blues, settings.magentas]
    .map((w) => w / 100);
  const data = image.data;
  const width = image.width, height = image.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const md = r + g + b - mx - mn;
      // weights: 0 red, 1 yellow, 2 green, 3 cyan, 4 blue, 5 magenta
      let primary, secondary;
      if (mx === r) { primary = 0; secondary = g >= b ? 1 : 5; }
      else if (mx === g) { primary = 2; secondary = r >= b ? 1 : 3; }
      else { primary = 4; secondary = g >= r ? 3 : 5; }
      let gray = mn + (md - mn) * weights[secondary] + (mx - md) * weights[primary];
      gray = Math.min(1, Math.max(0, gray));
      let outR = gray, outG = gray, outB = gray;
      if (settings.tint && settings.tintSaturation > 0) {
        const tintSat = settings.tintSaturation / 100;
        const c = (1 - Math.abs(2 * gray - 1)) * tintSat;
        const hp = ((settings.tintHue % 360) + 360) % 360 / 60;
        const xx = c * (1 - Math.abs((hp % 2) - 1));
        let r1 = 0, g1 = 0, b1 = 0;
        if (hp < 1) { r1 = c; g1 = xx; }
        else if (hp < 2) { r1 = xx; g1 = c; }
        else if (hp < 3) { g1 = c; b1 = xx; }
        else if (hp < 4) { g1 = xx; b1 = c; }
        else if (hp < 5) { r1 = xx; b1 = c; }
        else { r1 = c; b1 = xx; }
        const m = gray - c / 2;
        outR = Math.min(1, Math.max(0, r1 + m));
        outG = Math.min(1, Math.max(0, g1 + m));
        outB = Math.min(1, Math.max(0, b1 + m));
      }
      data[i] = Math.min(255, Math.round(outR * 255));
      data[i + 1] = Math.min(255, Math.round(outG * 255));
      data[i + 2] = Math.min(255, Math.round(outB * 255));
    }
  }
  return image;
}

// ---- Color Balance (AdjustPixels.c adjust_color_balance) ----

function tonalWeights(v) {
  const a = 0.25, b = 0.333, scale = 0.7;
  let s = (v - b) / -a + 0.5;
  let h = (v + b - 1) / a + 0.5;
  s = Math.min(1, Math.max(0, s));
  h = Math.min(1, Math.max(0, h));
  const m1 = Math.min(1, Math.max(0, (v - b) / a + 0.5));
  const m2 = Math.min(1, Math.max(0, (v + b - 1) / -a + 0.5));
  return { shadow: s * scale, mid: m1 * m2 * scale, highlight: h * scale };
}

export function applyColorBalance(image, settings) {
  const shadows = [settings.shadowCyanRed, settings.shadowMagentaGreen, settings.shadowYellowBlue].map((v) => v / 100);
  const midtones = [settings.midCyanRed, settings.midMagentaGreen, settings.midYellowBlue].map((v) => v / 100);
  const highlights = [settings.highlightCyanRed, settings.highlightMagentaGreen, settings.highlightYellowBlue].map((v) => v / 100);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const c = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    const before = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    for (let k = 0; k < 3; k += 1) {
      const { shadow, mid, highlight } = tonalWeights(c[k]);
      c[k] = clamp01(c[k] + shadows[k] * shadow + midtones[k] * mid + highlights[k] * highlight);
    }
    if (settings.preserveLuminosity) {
      const after = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      if (after > 0.0001) {
        const ratio = before / after;
        for (let k = 0; k < 3; k += 1) c[k] = clamp01(c[k] * ratio);
      }
    }
    data[i] = Math.round(c[0] * 255);
    data[i + 1] = Math.round(c[1] * 255);
    data[i + 2] = Math.round(c[2] * 255);
  }
  return image;
}

// ---- Invert ----

export function applyInvert(image) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  return image;
}

// ---- Hue/Saturation (per-pixel HSL with range weighting) ----

export function hueResponse(settings) {
  const response = [];
  for (let degree = 0; degree <= 360; degree += 1) {
    let shift = 0, saturation = 0, lightness = 0;
    for (const [colorRange, adjustment] of Object.entries(settings.adjustments || {})) {
      if (adjustment.hue === 0 && adjustment.saturation === 0 && adjustment.lightness === 0) continue;
      let weight = 1;
      if (colorRange !== "Master") {
        const band = settings.bands?.[colorRange];
        const resolved = band || defaultBandFor(colorRange);
        weight = hueBandWeightOf(resolved, degree);
        if (settings.invertRange && colorRange === settings.range) weight = 1 - weight;
      }
      if (weight <= 0) continue;
      shift += adjustment.hue * weight;
      saturation += adjustment.saturation * weight;
      lightness += adjustment.lightness * weight;
    }
    response.push({ shift, saturation, lightness });
  }
  return response;
}

function defaultBandFor(range) {
  const bands = {
    Reds: [315, 345, 15, 45], Yellows: [15, 45, 75, 105], Greens: [75, 105, 135, 165],
    Cyans: [135, 165, 195, 225], Blues: [195, 225, 255, 285], Magentas: [255, 285, 315, 345],
  };
  const [falloffStart, rangeStart, rangeEnd, falloffEnd] = bands[range] || [0, 0, 360, 360];
  return { falloffStart, rangeStart, rangeEnd, falloffEnd };
}

function hueBandWeightOf(band, hue) {
  const forward = (from, to) => {
    const delta = (to - from) % 360;
    return delta < 0 ? delta + 360 : delta;
  };
  const span = forward(band.falloffStart, band.falloffEnd);
  if (span <= 0) return 1;
  const position = forward(band.falloffStart, hue);
  if (position > span) return 0;
  const rampIn = forward(band.falloffStart, band.rangeStart);
  const plateauEnd = forward(band.falloffStart, band.rangeEnd);
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
  if (position <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - position) / rampOut : 1;
}

export function applyHueSaturation(image, settings) {
  const response = hueResponse(settings);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const { h, s, l } = rgbToHSL(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    let hue = h, saturation = s, lightnessAmount = 0;
    if (settings.colorize) {
      hue = ((settings.hue ?? 0) % 360 + 360) % 360;
      saturation = Math.min(1, Math.max(0, (settings.saturation ?? 0) / 100));
      lightnessAmount = (settings.lightness ?? 0) / 100;
    } else {
      const sampled = response[Math.min(response.length - 1, Math.max(0, Math.round(hue)))];
      lightnessAmount = sampled.lightness / 100;
      hue = (hue + sampled.shift) % 360;
      if (hue < 0) hue += 360;
      const a = Math.min(1, Math.max(-1, sampled.saturation / 100));
      saturation = a > 0
        ? (a >= 1 ? (saturation > 0 ? 1 : 0) : Math.min(1, saturation / (1 - a)))
        : Math.max(0, saturation * (1 + a));
    }
    // Lightness pulls toward white above 0 and toward black below, reaching either at ±100.
    const amount = Math.min(1, Math.max(-1, lightnessAmount));
    const lightness = amount >= 0 ? l + (1 - l) * amount : l * (1 + amount);
    const rgb = hslToRGB(hue, saturation, Math.min(1, Math.max(0, lightness)));
    data[i] = Math.round(rgb.r * 255);
    data[i + 1] = Math.round(rgb.g * 255);
    data[i + 2] = Math.round(rgb.b * 255);
  }
  return image;
}

// ---- Gaussian blur (separable, edge-clamped; Canvas 2D filter is not bit-identical
// across engines, so the port uses its own kernel) ----

export function gaussianBlurPlane(src, width, height, sigma) {
  if (!(sigma > 0)) return src.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  return blurPlaneWithKernel(src, width, height, kernel, radius);
}

function blurPlaneWithKernel(src, width, height, kernel, radius) {
  const temp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += src[row + sx] * kernel[k + radius];
      }
      temp[row + x] = acc;
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += temp[sy * width + x] * kernel[k + radius];
      }
      dst[y * width + x] = acc;
    }
  }
  return dst;
}

export function boxBlurPlane(src, width, height, radius) {
  if (radius < 1) return src.slice();
  const temp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  const at = (index, limit) => Math.min(limit - 1, Math.max(0, index));
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += src[row + at(k, width)];
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / (radius * 2 + 1);
      sum += src[row + at(x + radius + 1, width)] - src[row + at(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += temp[at(k, height) * width + x];
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / (radius * 2 + 1);
      sum += temp[at(y + radius + 1, height) * width + x] - temp[at(y - radius, height) * width + x];
    }
  }
  return dst;
}

export function lumaPlane(image) {
  const data = image.data;
  const plane = new Float32Array(image.width * image.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    plane[p] = rec709(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
  }
  return plane;
}

// ---- Motion blur (directional box kernel, counterclockwise from horizontal) ----

// Directional box kernel: samples along the streak, premultiplied by coverage, so
// transparent edges do not smear color; output alpha is the average coverage.
export function applyMotionBlur(image, angleDegrees, distance) {
  const width = image.width, height = image.height;
  const data = image.data;
  const radians = (-angleDegrees * Math.PI) / 180;
  const dx = Math.cos(radians), dy = Math.sin(radians);
  const steps = Math.max(1, Math.round(distance));
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 0, samples = 0;
      for (let s = 0; s < steps; s += 1) {
        const t = s - (steps - 1) / 2;
        const sx = Math.round(x + dx * t), sy = Math.round(y + dy * t);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const i = (sy * width + sx) * 4;
        r += data[i] * data[i + 3];
        g += data[i + 1] * data[i + 3];
        b += data[i + 2] * data[i + 3];
        a += data[i + 3];
        samples += 1;
      }
      if (samples === 0 || a === 0) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / samples);
    }
  }
  image.data.set(out);
  return image;
}

// ---- Camera Raw (AdjustPixels.c) ----

function clampColor(c) {
  c.r = clamp01(c.r); c.g = clamp01(c.g); c.b = clamp01(c.b);
  return c;
}

function scaleLuminance(c, target) {
  target = clamp01(target);
  const y = rec709(c.r, c.g, c.b);
  if (Math.abs(target - y) < 1e-8) return c;
  if (y < 1e-8) {
    if (target > y) { c.r = c.g = c.b = target; }
    return c;
  }
  const scale = target / y;
  c.r = clamp01(c.r * scale);
  c.g = clamp01(c.g * scale);
  c.b = clamp01(c.b * scale);
  return c;
}

function toneHighlights(y, amount) {
  const t = clamp01((y - 0.5) / 0.5);
  const weight = t * t;
  return amount >= 0 ? clamp01(y + amount * weight * (1 - y)) : clamp01(y + amount * weight * (y - 0.5));
}

function toneShadows(y, amount) {
  const t = clamp01((0.5 - y) / 0.5);
  const weight = t * t;
  return amount >= 0 ? clamp01(y + amount * weight * (0.5 - y)) : clamp01(y + amount * weight * y);
}

function toneWhites(y, amount) {
  if (y <= 0.75) return y;
  return clamp01(0.75 + (y - 0.75) * (1 + amount));
}

function toneBlacks(y, amount) {
  if (y >= 0.25) return y;
  return clamp01(0.25 + (y - 0.25) * (1 - amount));
}

function vibranceAndSaturation(c, vibrance, saturation) {
  let lum = rec709(c.r, c.g, c.b);
  const maxc = Math.max(c.r, c.g, c.b), minc = Math.min(c.r, c.g, c.b);
  const chroma = maxc - minc;
  const sat = maxc <= 1e-8 ? 0 : chroma / maxc;
  let hue = 0;
  if (chroma > 1e-8) {
    if (c.r >= c.g && c.r >= c.b) hue = 60 * (((c.g - c.b) / chroma) % 6);
    else if (c.g >= c.r && c.g >= c.b) hue = 60 * ((c.b - c.r) / chroma + 2);
    else hue = 60 * ((c.r - c.g) / chroma + 4);
    if (hue < 0) hue += 360;
  }
  let skin = 0;
  if (hue >= 10 && hue <= 50) {
    skin = hue <= 30 ? (hue - 10) / 20 : (50 - hue) / 20;
    skin *= clamp01((sat - 0.15) / 0.35);
  }
  let amount = vibrance * (1 - sat);
  if (vibrance > 0) amount *= 1 - 0.7 * skin;
  let factor = 1 + amount;
  c.r = clamp01(lum + (c.r - lum) * factor);
  c.g = clamp01(lum + (c.g - lum) * factor);
  c.b = clamp01(lum + (c.b - lum) * factor);
  lum = rec709(c.r, c.g, c.b);
  factor = 1 + saturation;
  c.r = clamp01(lum + (c.r - lum) * factor);
  c.g = clamp01(lum + (c.g - lum) * factor);
  c.b = clamp01(lum + (c.b - lum) * factor);
  return c;
}

export function applyCameraRaw(image, s) {
  const data = image.data;
  const light = Math.pow(2, s.exposure);
  const contrastScale = 1 + s.contrast / 100;
  const highlightAmount = s.highlights / 100;
  const shadowAmount = s.shadows / 100;
  const whiteAmount = s.whites / 100;
  const blackAmount = s.blacks / 100;
  const vibranceAmount = s.vibrance / 100;
  const saturationAmount = s.saturation / 100;
  // White balance: temperature shifts blue↔yellow, tint shifts green↔magenta, as gains on the channels.
  const warm = Math.pow(2, s.temperature / 100 * 0.5);
  const greenGain = Math.pow(2, -s.tint / 100 * 0.5);
  const redGain = warm, blueGain = 1 / warm;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const c = {
      r: clamp01(srgbToLinear(data[i] / 255) * redGain * light),
      g: clamp01(srgbToLinear(data[i + 1] / 255) * greenGain * light),
      b: clamp01(srgbToLinear(data[i + 2] / 255) * blueGain * light),
    };
    c.r = clamp01(0.5 + (linearToSrgb(c.r) - 0.5) * contrastScale);
    c.g = clamp01(0.5 + (linearToSrgb(c.g) - 0.5) * contrastScale);
    c.b = clamp01(0.5 + (linearToSrgb(c.b) - 0.5) * contrastScale);
    scaleLuminance(c, toneHighlights(rec709(c.r, c.g, c.b), highlightAmount));
    scaleLuminance(c, toneShadows(rec709(c.r, c.g, c.b), shadowAmount));
    scaleLuminance(c, toneWhites(rec709(c.r, c.g, c.b), whiteAmount));
    scaleLuminance(c, toneBlacks(rec709(c.r, c.g, c.b), blackAmount));
    vibranceAndSaturation(c, vibranceAmount, saturationAmount);
    data[i] = Math.round(c.r * 255);
    data[i + 1] = Math.round(c.g * 255);
    data[i + 2] = Math.round(c.b * 255);
  }
  return image;
}

export function applyCameraRawEffects(image, s) {
  const width = image.width, height = image.height;
  if (width === 0 || height === 0) return image;
  if (s.texture === 0 && s.clarity === 0 && s.dehaze === 0 && !(s.glow > 0) && s.vignetteAmount === 0) return image;
  const data = image.data;
  const luma = lumaPlane(image);
  let fine = null, coarse = null, glowPlane = null;
  if (s.texture !== 0) fine = boxBlurPlane(luma, width, height, Math.max(1, Math.round(1)));
  if (s.clarity !== 0) coarse = boxBlurPlane(luma, width, height, Math.max(1, Math.round(4)));
  if (s.glow > 0) {
    const spread = s.glowSpread / 100;
    const base = s.glowStyle === 1 ? 2.0 : 5.0;
    const widened = Math.max(1, base * (1 + spread));
    const glowRadius = Math.min(64, Math.max(1, Math.round(widened)));
    const threshold = 0.55 + 0.4 * (s.glowRange / 100);
    const source = new Float32Array(luma.length);
    const denom = Math.max(0.05, 1 - threshold);
    for (let i = 0; i < luma.length; i += 1) {
      source[i] = Math.min(1, Math.max(0, (luma[i] - threshold) / denom));
    }
    glowPlane = boxBlurPlane(source, width, height, glowRadius);
  }
  const warmth = s.glowWarmth / 100;
  let glowRed, glowGreen, glowBlue, glowGain;
  if (s.glowStyle === 2) {
    glowRed = 1; glowGreen = 0.35 - 0.3 * warmth; glowBlue = 0.2 - 0.2 * warmth; glowGain = 1;
  } else {
    glowRed = 0.75 + 0.25 * warmth; glowGreen = 0.6 + 0.2 * warmth; glowBlue = 0.75 - 0.6 * warmth;
    glowGain = s.glowStyle === 1 ? 1.4 : 1;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const p = y * width + x;
      if (data[i + 3] === 0) continue;
      const c = { r: data[i] / 255, g: data[i + 1] / 255, b: data[i + 2] / 255 };
      if (fine || coarse) {
        const tone = rec709(c.r, c.g, c.b);
        let detail = 0;
        if (fine) detail += (s.texture / 100) * (tone - fine[p]);
        if (coarse) detail += (s.clarity / 100) * (tone - coarse[p]);
        if (detail !== 0) scaleLuminance(c, clamp01(tone + detail));
      }
      if (s.dehaze !== 0) dehaze(c, s.dehaze);
      if (glowPlane && s.glow > 0) {
        const add = glowPlane[p] * (s.glow / 100) * glowGain;
        c.r = clamp01(c.r + add * glowRed);
        c.g = clamp01(c.g + add * glowGreen);
        c.b = clamp01(c.b + add * glowBlue);
      }
      vignetteEffect(c, x, y, width, height, s.vignetteAmount, s.vignetteMidpoint, s.vignetteRoundness,
        s.vignetteFeather, s.vignetteHighlights, s.vignetteStyle || 0);
      data[i] = Math.round(c.r * 255);
      data[i + 1] = Math.round(c.g * 255);
      data[i + 2] = Math.round(c.b * 255);
    }
  }
  return image;
}

function dehaze(c, amount) {
  const d = amount / 100;
  const y = rec709(c.r, c.g, c.b);
  const contrast = 1 + 0.8 * d;
  const pivot = 0.45 - 0.1 * (d > 0 ? d : 0);
  let y2 = clamp01(pivot + (y - 0.45) * contrast);
  if (d < 0) y2 = clamp01(y2 + -d * (1 - y2) * 0.45);
  else y2 = clamp01(y2 - d * Math.max(0, 0.4 - y2));
  scaleLuminance(c, y2);
  const y3 = rec709(c.r, c.g, c.b);
  const sat = 1 + 0.7 * d;
  c.r = clamp01(y3 + (c.r - y3) * sat);
  c.g = clamp01(y3 + (c.g - y3) * sat);
  c.b = clamp01(y3 + (c.b - y3) * sat);
}

// ---- Vignette (AdjustPixels.c) ----

export function vignetteMaskAt(px, py, width, height, midpoint, roundness, feather) {
  const nx = (px / width) * 2 - 1;
  const ny = (py / height) * 2 - 1;
  const square = Math.max(Math.abs(nx), Math.abs(ny));
  const circle = Math.hypot(nx, ny) / Math.SQRT2;
  const shape = (1 - roundness / 100) * 0.5;
  const dist = circle + (square - circle) * shape;
  const start = (midpoint / 100) * 0.85;
  let soft = feather / 100;
  if (soft < 0.05) soft = 0.05;
  const t = Math.min(1, Math.max(0, (dist - start) / soft));
  return t * t * (3 - 2 * t);
}

function vignetteEffect(c, x, y, width, height, amount, midpoint, roundness, feather, highlights, style) {
  if (amount === 0) return;
  const mask = vignetteMaskAt(x + 0.5, y + 0.5, width, height, midpoint, roundness, feather);
  let effect = (amount / 100) * mask;
  if (effect < 0 && style === 0) {
    const bright = clamp01((rec709(c.r, c.g, c.b) - 0.45) / 0.55);
    effect *= 1 - (highlights / 100) * bright;
  }
  if (effect < 0) {
    const factor = 1 + effect;
    c.r *= factor; c.g *= factor; c.b *= factor;
  } else if (effect > 0) {
    c.r = c.r + (1 - c.r) * effect;
    c.g = c.g + (1 - c.g) * effect;
    c.b = c.b + (1 - c.b) * effect;
  }
  if (style === 1 && mask > 0) {
    const lum = rec709(c.r, c.g, c.b);
    const sat = 1 - 0.75 * mask * Math.abs(amount / 100);
    c.r = clamp01(lum + (c.r - lum) * sat);
    c.g = clamp01(lum + (c.g - lum) * sat);
    c.b = clamp01(lum + (c.b - lum) * sat);
  }
}

export function applyVignette(image, settings, frame, fillsClear) {
  const width = image.width, height = image.height;
  const data = image.data;
  const strength = clamp01(settings.vignetteAmount / 100);
  const red = clamp01(settings.vignetteColor.red), green = clamp01(settings.vignetteColor.green), blue = clamp01(settings.vignetteColor.blue);
  const fx = frame ? frame.x : 0, fy = frame ? frame.y : 0;
  const fw = frame ? frame.width : width, fh = frame ? frame.height : height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0 && !fillsClear) continue;
      const mask = vignetteMaskAt(x + 0.5 - fx, y + 0.5 - fy, fw, fh,
        settings.vignetteMidpoint, settings.vignetteRoundness, settings.vignetteFeather);
      if (mask <= 0) continue;
      const alpha = data[i + 3] / 255;
      let r = 0, g = 0, b = 0, bright = 0;
      if (data[i + 3]) {
        r = data[i] / 255; g = data[i + 1] / 255; b = data[i + 2] / 255;
        bright = clamp01((rec709(r, g, b) - 0.45) / 0.55);
      }
      const effect = strength * mask * (1 - (settings.vignetteHighlights / 100) * bright);
      if (!fillsClear) {
        data[i] = Math.round((r + (red - r) * effect) * 255);
        data[i + 1] = Math.round((g + (green - g) * effect) * 255);
        data[i + 2] = Math.round((b + (blue - b) * effect) * 255);
        continue;
      }
      const out = alpha + effect * (1 - alpha);
      if (out <= 0) continue;
      data[i] = Math.round(((red * effect + r * alpha * (1 - effect)) / out) * 255);
      data[i + 1] = Math.round(((green * effect + g * alpha * (1 - effect)) / out) * 255);
      data[i + 2] = Math.round(((blue * effect + b * alpha * (1 - effect)) / out) * 255);
      data[i + 3] = Math.round(Math.min(1, out) * 255);
    }
  }
  return image;
}

// ---- Tonal Contrast (AdjustPixels.c adjust_tonal_contrast) ----

function tonalSmooth(low, high, value) {
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

export function applyTonalContrast(image, settings) {
  const width = image.width, height = image.height;
  const blurred = boxBlurPlane(lumaPlane(image), width, height, Math.max(1, Math.round(settings.tonalRadius)));
  const data = image.data;
  if (settings.tonalAmount <= 0 || (settings.tonalShadows === 0 && settings.tonalMidtones === 0 && settings.tonalHighlights === 0)) return image;
  const strength = settings.tonalAmount / 50;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const p = y * width + x;
      if (data[i + 3] === 0) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const lum = rec709(r, g, b);
      const baseLum = blurred[p];
      const shadowWeight = 1 - tonalSmooth(0.15, 0.5, baseLum);
      const highlightWeight = tonalSmooth(0.5, 0.85, baseLum);
      const midtoneWeight = Math.max(0, 1 - shadowWeight - highlightWeight);
      const weight = (settings.tonalShadows * shadowWeight + settings.tonalMidtones * midtoneWeight
        + settings.tonalHighlights * highlightWeight) / 100;
      const detail = lum - baseLum;
      const delta = 0.18 * Math.tanh(detail * 6) * weight * strength * (4 * lum * (1 - lum));
      data[i] = Math.round(clamp01(r + delta) * 255);
      data[i + 1] = Math.round(clamp01(g + delta) * 255);
      data[i + 2] = Math.round(clamp01(b + delta) * 255);
    }
  }
  return image;
}

// ---- Lens Correction / Distortion (LensPixels.c lens_distort semantics) ----

export function applyLensDistortion(image, distortion) {
  if (distortion === 0) return image;
  const width = image.width, height = image.height;
  const src = new Uint8ClampedArray(image.data);
  const data = image.data;
  const cx = width / 2, cy = height / 2;
  const norm = Math.hypot(cx, cy);
  // distortion −100–100 maps to a radial barrel/pincushion k.
  const k = distortion / 100 * 0.4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (src[i + 3] === 0) continue;
      const dx = (x + 0.5 - cx) / norm, dy = (y + 0.5 - cy) / norm;
      const r2 = dx * dx + dy * dy;
      const factor = 1 + k * r2;
      const sx = Math.round((x + 0.5 - cx) * factor + cx - 0.5);
      const sy = Math.round((y + 0.5 - cy) * factor + cy - 0.5);
      const cxi = Math.min(width - 1, Math.max(0, sx));
      const cyi = Math.min(height - 1, Math.max(0, sy));
      const j = (cyi * width + cxi) * 4;
      data[i] = src[j]; data[i + 1] = src[j + 1]; data[i + 2] = src[j + 2];
    }
  }
  return image;
}
