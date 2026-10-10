// The Dither filter, ported from DitherPixels.c: error diffusion (Floyd-Steinberg,
// Atkinson), ordered Bayer screens, CRT scanlines, halftone marks and the old Mac
// fill patterns. Tone adjustment (density as a gamma, contrast on mid gray) runs
// first, then each plane is quantized to `levels` tones and mapped to the colors.

export const DITHER_STYLES = [
  "Floyd-Steinberg", "Atkinson", "Bayer 2", "Bayer 4", "Bayer 8",
  "Scanlines", "Halftone Dots", "Halftone Lines", "Halftone Diamond", "Patterns",
];

const STYLE_INDEX = Object.fromEntries(DITHER_STYLES.map((name, index) => [name, index]));
const DITHER_DIFFUSION = 0, DITHER_ATKINSON = 1, DITHER_BAYER_2 = 2, DITHER_BAYER_4 = 3,
  DITHER_BAYER_8 = 4, DITHER_SCANLINES = 5, DITHER_DOTS = 6, DITHER_LINES = 7,
  DITHER_DIAMOND = 8, DITHER_PATTERNS = 9;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Density darkens (positive) or lightens as a gamma, so black and white stay put;
// contrast pivots on mid gray.
function adjustTone(v, gamma, contrast) {
  v = Math.pow(clamp01(v), gamma);
  return clamp01((v - 0.5) * contrast + 0.5);
}

const ATKINSON = [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]];
const FLOYD = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];

// Atkinson passes on only six eighths of the error, which is what gives the Mac's
// crisp, contrasty look.
function kernelFor(style) {
  return style === DITHER_ATKINSON
    ? { taps: ATKINSON, divisor: 8 }
    : { taps: FLOYD, divisor: 16 };
}

function quantize(v, levels) {
  const steps = levels - 1;
  return Math.round(clamp01(v) * steps) / steps;
}

// Diffuses each plane in serpentine order, so the error's drift doesn't streak.
function diffuse(plane, alpha, width, height, style, levels, diffusion) {
  const k = kernelFor(style);
  for (let y = 0; y < height; y += 1) {
    const reverse = (y & 1) === 1;
    for (let i = 0; i < width; i += 1) {
      const x = reverse ? width - 1 - i : i;
      const at = y * width + x;
      if (!alpha[at]) continue;
      const old = plane[at], q = quantize(old, levels);
      plane[at] = q;
      const error = (old - q) * diffusion / k.divisor;
      for (const [dx, dy, weight] of k.taps) {
        const nx = x + (reverse ? -dx : dx), ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        plane[ny * width + nx] += error * weight;
      }
    }
  }
}

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// Smaller Bayer matrices are the top-left corners of the 8×8 one, rescaled.
function orderedThreshold(style, x, y) {
  if (style === DITHER_BAYER_2) {
    const m = [0, 2, 3, 1];
    return (m[(y & 1) * 2 + (x & 1)] + 0.5) / 4;
  }
  if (style === DITHER_BAYER_4) {
    const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    return (m[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  }
  return (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
}

function ordered(v, threshold, levels) {
  const steps = levels - 1;
  const q = Math.floor(clamp01(v) * steps + threshold);
  return Math.min(steps, q) / steps;
}

// How much of a halftone cell a point must be covered by before it's marked.
function spot(style, u, v) {
  const au = Math.abs(u), av = Math.abs(v);
  if (style === DITHER_DOTS) return Math.PI * (u * u + v * v);
  if (style === DITHER_LINES) return av * 2;
  return au + av;
}

// Old Mac fill patterns, 8×8, one byte per row with the leftmost pixel in the top
// bit, from sparsest to fullest.
const PATTERNS = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x80, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x88, 0x00, 0x22, 0x00, 0x88, 0x00, 0x22, 0x00,
  0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01,
  0x88, 0x22, 0x88, 0x22, 0x88, 0x22, 0x88, 0x22,
  0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00,
  0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44, 0x88,
  0xAA, 0x00, 0xAA, 0x00, 0xAA, 0x00, 0xAA, 0x00,
  0x88, 0x55, 0x22, 0x55, 0x88, 0x55, 0x22, 0x55,
  0xFF, 0x80, 0x80, 0x80, 0xFF, 0x08, 0x08, 0x08,
  0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55,
  0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81,
  0x77, 0xAA, 0xDD, 0xAA, 0x77, 0xAA, 0xDD, 0xAA,
  0xEE, 0xDD, 0xBB, 0x77, 0xEE, 0xDD, 0xBB, 0x77,
  0x77, 0xFF, 0xDD, 0xFF, 0x77, 0xFF, 0xDD, 0xFF,
  0x7F, 0xFF, 0xFF, 0xFF, 0xF7, 0xFF, 0xFF, 0xFF,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
];
const PATTERN_COUNT = PATTERNS.length / 8;

// Writes straight-alpha RGB back over the pixel's alpha (write_pixel).
function writePixel(data, p, r, g, b) {
  const a = data[p + 3] / 255;
  data[p] = Math.round(clamp01(r) * a * 255);
  data[p + 1] = Math.round(clamp01(g) * a * 255);
  data[p + 2] = Math.round(clamp01(b) * a * 255);
}

// `params`: { style, levels, density, contrast, monochrome, dark: [r,g,b], light: [r,g,b] }.
// Density/contrast follow the C's ranges (−1..1); dark/light are 0..255 triples.
export function applyDither(image, params) {
  const width = image.width, height = image.height;
  const count = width * height;
  if (!count) return image;
  const data = image.data;
  // The style names map 1:1 onto the C's DITHER_* enum order.
  const style = STYLE_INDEX[params.style] ?? DITHER_ATKINSON;
  const monochrome = params.monochrome !== false;
  const planes = monochrome ? 1 : 3;
  const tone = new Float32Array(count * planes);
  const alpha = new Uint8Array(count);
  const source = monochrome ? null : new Float32Array(count * 3);

  const gamma = Math.pow(2, (params.density || 0) * 1.5);
  const contrastInput = params.contrast || 0;
  const contrast = contrastInput >= 0 ? 1 / (1 - 0.95 * contrastInput) : 1 + contrastInput;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      const p = at * 4;
      alpha[at] = data[p + 3];
      let r = 0, g = 0, b = 0;
      if (data[p + 3]) {
        const scale = 1 / data[p + 3];
        r = data[p] * scale; g = data[p + 1] * scale; b = data[p + 2] * scale;
      }
      if (!monochrome) {
        tone[at] = adjustTone(r, gamma, contrast);
        tone[count + at] = adjustTone(g, gamma, contrast);
        tone[2 * count + at] = adjustTone(b, gamma, contrast);
        source[at * 3] = r; source[at * 3 + 1] = g; source[at * 3 + 2] = b;
      } else {
        tone[at] = adjustTone(0.2126 * r + 0.7152 * g + 0.0722 * b, gamma, contrast);
      }
    }
  }

  const dark = params.dark || [0, 0, 0];
  const light = params.light || [255, 255, 255];
  const levels = Math.max(2, Math.min(16, Math.round(params.levels || 2)));

  if (style <= DITHER_BAYER_8) {
    if (style <= DITHER_ATKINSON) {
      for (let c = 0; c < planes; c += 1) {
        diffuse(tone.subarray(c * count, (c + 1) * count), alpha, width, height, style, levels, 1);
      }
    } else {
      for (let c = 0; c < planes; c += 1) {
        const plane = tone.subarray(c * count, (c + 1) * count);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const at = y * width + x;
            if (alpha[at]) plane[at] = ordered(plane[at], orderedThreshold(style, x, y), levels);
          }
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * width + x;
        if (!alpha[at]) continue;
        const p = at * 4;
        if (!monochrome) {
          writePixel(data, p, tone[at], tone[count + at], tone[2 * count + at]);
        } else {
          const t = tone[at];
          writePixel(data, p,
            dark[0] / 255 + ((light[0] - dark[0]) / 255) * t,
            dark[1] / 255 + ((light[1] - dark[1]) / 255) * t,
            dark[2] / 255 + ((light[2] - dark[2]) / 255) * t);
        }
      }
    }
  } else if (style === DITHER_SCANLINES) {
    // A CRT: each line scans the image, its tone the average of the rows it covers.
    // The beam glows brighter where the picture is light; the screen stays dark.
    const spacing = Math.max(2, Math.round(params.cell || 2));
    const middle = spacing / 2;
    const dots = clamp01(params.dots || 0);
    const wobble = params.wobble || 0;
    const screen = dark.map((v) => v / 255), phosphor = light.map((v) => v / 255);
    const scan = new Float32Array(width * planes);
    for (let top = 0; top < height; top += spacing) {
      const bottom = Math.min(height, top + spacing);
      // Wobble: each line is pushed sideways, a slow wave down the screen with a
      // quicker one over it, as a CRT's picture wavers when its sync drifts.
      const line = top / spacing;
      const wave = Math.sin(line * 0.45) * 0.7 + Math.sin(line * 1.7 + 1.3) * 0.3;
      const shift = Math.round(wobble * wave);
      for (let x = 0; x < width; x += 1) {
        const sums = [0, 0, 0];
        let n = 0;
        const sx = x - shift;
        if (sx >= 0 && sx < width) {
          for (let y = top; y < bottom; y += 1) {
            const at = y * width + sx;
            if (!alpha[at]) continue;
            for (let c = 0; c < planes; c += 1) sums[c] += tone[c * count + at];
            n += 1;
          }
        }
        for (let c = 0; c < planes; c += 1) scan[c * width + x] = n ? sums[c] / n : 0;
      }
      for (let y = top; y < bottom; y += 1) {
        const offset = Math.abs(y - top + 0.5 - middle);
        for (let x = 0; x < width; x += 1) {
          const at = y * width + x;
          if (!alpha[at]) continue;
          const p = at * 4;
          // Dots: the line breaks into beads, one every line spacing, each lit in
          // the color at its middle.
          const along = ((x + 0.5) % spacing) - middle;
          const centered = Math.round(x - along * dots);
          const sample = Math.min(width - 1, Math.max(0, centered));
          let r, g, b, t;
          if (!monochrome) {
            r = scan[sample]; g = scan[width + sample]; b = scan[2 * width + sample];
            t = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          } else {
            t = scan[sample];
            r = screen[0] + (phosphor[0] - screen[0]) * t;
            g = screen[1] + (phosphor[1] - screen[1]) * t;
            b = screen[2] + (phosphor[2] - screen[2]) * t;
          }
          r *= 1.35; g *= 1.35; b *= 1.35;
          // Half the beam's height: thin in the shadows, wide in the highlights.
          const beam = middle * (0.2 + 0.5 * Math.sqrt(clamp01(t)));
          const across = along * dots, distance = Math.sqrt(offset * offset + across * across);
          const cover = clamp01(beam - distance + 0.5);
          const br = monochrome ? 0 : screen[0], bg = monochrome ? 0 : screen[1], bb = monochrome ? 0 : screen[2];
          writePixel(data, p, br + (r - br) * cover, bg + (g - bg) * cover, bb + (b - bb) * cover);
        }
      }
    }
  } else {
    // Marks (halftone shapes, patterns) cover as much of each spot as the tone calls
    // for. On light, they stand for darkness and are drawn in the dark color.
    const marks = monochrome ? tone : new Float32Array(count);
    if (!monochrome) {
      for (let i = 0; i < count; i += 1) {
        marks[i] = 0.2126 * tone[i] + 0.7152 * tone[count + i] + 0.0722 * tone[2 * count + i];
      }
    }
    const cosA = Math.cos(params.angle || 0), sinA = Math.sin(params.angle || 0);
    const cell = Math.max(2, Math.round(params.cell || 8));
    const ink = dark.map((v) => v / 255), paper = light.map((v) => v / 255);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * width + x;
        if (!alpha[at]) continue;
        const p = at * 4;
        let amount;
        if (style === DITHER_PATTERNS) {
          const coverage = clamp01(1 - marks[at]);
          const index = Math.round(coverage * (PATTERN_COUNT - 1));
          amount = (PATTERNS[index * 8 + (y & 7)] >> (7 - (x & 7))) & 1;
        } else {
          const fx = x + 0.5, fy = y + 0.5;
          let u = (fx * cosA + fy * sinA) / cell, v = (-fx * sinA + fy * cosA) / cell;
          u -= Math.floor(u) + 0.5;
          v -= Math.floor(v) + 0.5;
          amount = (1 - marks[at]) > spot(style, u, v) ? 1 : 0;
        }
        if (!monochrome) {
          const s = source.subarray(at * 3, at * 3 + 3);
          // The pixel's own color on white paper (lightOnDark defaults off).
          writePixel(data, p, 1 + (s[0] - 1) * amount, 1 + (s[1] - 1) * amount, 1 + (s[2] - 1) * amount);
        } else {
          writePixel(data, p,
            paper[0] + (ink[0] - paper[0]) * amount,
            paper[1] + (ink[1] - paper[1]) * amount,
            paper[2] + (ink[2] - paper[2]) * amount);
        }
      }
    }
  }
  return image;
}
