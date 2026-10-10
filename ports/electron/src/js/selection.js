// The selection engine. Mirrors the macOS app's DocumentSelection + WandPixels.c:
// a selection is document-resolution coverage (0..255 per pixel) plus a vector
// outline for the marching overlay. Every edit ultimately acts through the
// coverage, so booleans (Add/Subtract/Intersect), Expand/Contract (a band on
// each side of the outline) and Feather (a blurred edge) are raster operations;
// the overlay draws the traced outline. Selections are immutable: every change
// builds a new object, so history snapshots can share them by reference.

// Bounds over which an antialiased edge may fade outside the vector outline.
const FEATHER_BOUNDS_PAD = (feather) => Math.ceil(feather * 2);

export function emptyMask(width, height) {
  return new Uint8Array(width * height);
}

// Rasterizes vector shapes with the winding rule (CGPath .winding): overlapping
// subpaths fill once, as Canvas 2D's default "nonzero" does.
export function rasterizeShapes(shapes, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (const shape of shapes) {
    context.beginPath();
    if (shape.kind === "ellipse") {
      context.ellipse(
        shape.x + shape.width / 2, shape.y + shape.height / 2,
        Math.abs(shape.width) / 2, Math.abs(shape.height) / 2, 0, 0, Math.PI * 2,
      );
    } else {
      const points = shape.points;
      if (!points.length) continue;
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) context.lineTo(points[i].x, points[i].y);
      context.closePath();
    }
    context.fill();
  }
  const data = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 3; i < mask.length; i += 1, p += 4) mask[i] = data[p];
  return mask;
}

// Booleans over coverage: union takes the stronger claim, subtract removes the
// other's coverage, intersect keeps the weaker. Binary masks behave exactly.
export function combineMasks(a, b, mode) {
  const out = new Uint8Array(a.length);
  if (mode === "add") {
    for (let i = 0; i < a.length; i += 1) out[i] = Math.max(a[i], b[i]);
  } else if (mode === "subtract") {
    for (let i = 0; i < a.length; i += 1) out[i] = Math.max(0, a[i] - b[i]);
  } else {
    for (let i = 0; i < a.length; i += 1) out[i] = Math.min(a[i], b[i]);
  }
  return out;
}

export function invertMask(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) out[i] = 255 - mask[i];
  return out;
}

export function maskBounds(mask, width) {
  let x0 = mask.length ? 1 : 0, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const x = i % width, y = (i / width) | 0;
    if (x < x0) x0 = x;
    if (x + 1 > x1) x1 = x + 1;
    if (y < y0) y0 = y;
    if (y + 1 > y1) y1 = y + 1;
  }
  return x1 <= x0 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The largest (smallest) value within `reach` on each side: two sliding-window
// passes, ported from LayerEffectsRenderer.extreme. O(n) in the mask size.
export function extreme(values, width, height, reach, smallest) {
  if (width <= 0 || height <= 0 || values.length !== width * height) return [];
  const radius = Math.max(0, reach);
  const pass = new Float32Array(values.length);
  const result = new Float32Array(values.length);
  const queue = new Int32Array(Math.max(width, height));
  function sweep(input, output, lines, count, lineStep, elementStep) {
    for (let line = 0; line < lines; line += 1) {
      const base = line * lineStep;
      let head = 0, tail = 0, next = 0;
      for (let center = 0; center < count; center += 1) {
        while (next <= Math.min(count - 1, center + radius)) {
          const value = input[base + next * elementStep];
          while (tail > head) {
            const previous = input[base + queue[tail - 1] * elementStep];
            if (smallest ? previous < value : previous > value) break;
            tail -= 1;
          }
          queue[tail] = next;
          tail += 1;
          next += 1;
        }
        while (head < tail && queue[head] < center - radius) head += 1;
        const outside = center < radius || center + radius >= count;
        output[base + center * elementStep] = smallest && outside ? 0 : input[base + queue[head] * elementStep];
      }
    }
  }
  sweep(values, pass, height, width, width, 1);
  sweep(pass, result, width, height, 1, width);
  return result;
}

// Grows (amount > 0) or shrinks the outline by `amount` pixels, clipped to the
// canvas: a band |amount| wide on each side of the outline, added or removed.
export function resizeMask(mask, width, height, amount) {
  const levels = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) levels[i] = mask[i] / 255;
  const reach = Math.max(1, Math.round(Math.abs(amount)));
  const moved = extreme(levels, width, height, reach, amount < 0);
  const out = new Uint8Array(mask.length);
  if (amount > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.max(levels[i], moved[i]) * 255);
  } else {
    for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.max(0, levels[i] - moved[i]) * 255);
  }
  return out;
}

// Softens the edge: a Gaussian with sigma = amount/2 (CIApplyingGaussianBlur),
// edge-clamped so the falloff survives at the canvas border.
export function featherMask(mask, width, height, amount) {
  if (amount <= 0) return mask;
  const levels = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) levels[i] = mask[i] / 255;
  const soft = window.gaussianBlurPlane
    ? window.gaussianBlurPlane(levels, width, height, amount / 2)
    : boxBlurPlane(levels, width, height, Math.max(1, Math.round(amount / 4)));
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.max(0, Math.min(1, soft[i])) * 255);
  return out;
}

// Fallback blur (no kernel import here to keep the module dependency-free in
// Node tests): three box passes approximate the Gaussian well enough for edges.
function boxBlurPlane(levels, width, height, radius) {
  let current = Float32Array.from(levels);
  for (let pass = 0; pass < 3; pass += 1) {
    const horizontal = new Float32Array(current.length);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      const row = y * width;
      for (let x = -radius; x <= radius; x += 1) sum += current[row + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x] = sum / (radius * 2 + 1);
        sum -= current[row + Math.min(width - 1, Math.max(0, x - radius))];
        sum += current[row + Math.min(width - 1, Math.max(0, x + radius + 1))];
      }
    }
    const vertical = new Float32Array(current.length);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1) sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y += 1) {
        vertical[y * width + x] = sum / (radius * 2 + 1);
        sum -= horizontal[Math.min(height - 1, Math.max(0, y - radius)) * width + x];
        sum += horizontal[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x];
      }
    }
    current = vertical;
  }
  return current;
}

// ---- Magic Wand (WandPixels.c port) ----

function wandMatches(pixel, p, reference, tolerance) {
  for (let c = 0; c < 4; c += 1) {
    const d = pixel[p + c] - reference[c];
    if (d < -tolerance || d > tolerance) return false;
  }
  return true;
}

// Scanline flood fill over pixels within tolerance of the averaged reference;
// non-contiguous matches every similar pixel in the image. Returns coverage.
export function wandMask(rgba, width, height, seedX, seedY, radius, tolerance, contiguous) {
  const mask = new Uint8Array(width * height);
  if (!width || !height || seedX >= width || seedY >= height) return mask;
  const x0 = Math.max(0, seedX - radius), x1 = Math.min(width - 1, seedX + radius);
  const y0 = Math.max(0, seedY - radius), y1 = Math.min(height - 1, seedY + radius);
  const sums = [0, 0, 0, 0];
  let samples = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) sums[c] += rgba[p + c];
      samples += 1;
    }
  }
  const reference = sums.map((sum) => Math.round(sum / samples));
  if (!contiguous) {
    let count = 0;
    for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
      if (wandMatches(rgba, p, reference, tolerance)) { mask[i] = 255; count += 1; }
    }
    return mask;
  }
  // Scanline flood fill: each popped seed fills its whole horizontal run, then
  // pushes one seed per matching run in the rows directly above and below.
  const stack = [seedX, seedY];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * width;
    if (mask[row + x] || !wandMatches(rgba, row * 4 + x * 4, reference, tolerance)) continue;
    let left = x, right = x;
    while (left > 0 && !mask[row + left - 1] && wandMatches(rgba, row * 4 + (left - 1) * 4, reference, tolerance)) left -= 1;
    while (right + 1 < width && !mask[row + right + 1] && wandMatches(rgba, row * 4 + (right + 1) * 4, reference, tolerance)) right += 1;
    mask.fill(255, row + left, row + right + 1);
    for (let side = 0; side < 2; side += 1) {
      const ny = side === 0 ? y - 1 : y + 1;
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let nx = left; nx <= right; nx += 1) {
        const candidate = !mask[nrow + nx] && wandMatches(rgba, nrow * 4 + nx * 4, reference, tolerance);
        if (candidate && !inRun) stack.push(nx, ny);
        inRun = candidate;
      }
    }
  }
  return mask;
}

// Color Range: pixels whose premultiplied-to-RGB color lies within fuzziness of
// any include color and no exclude color (ColorRangeSelection via C).
export function colorRangeMask(rgba, width, height, includes, excludes, fuzziness, invert) {
  const mask = new Uint8Array(width * height);
  const near = (r, g, b, colors) => colors.some((c) =>
    Math.abs(r - c[0]) <= fuzziness && Math.abs(g - c[1]) <= fuzziness && Math.abs(b - c[2]) <= fuzziness);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    let matches = false;
    if (rgba[p + 3]) {
      const a = rgba[p + 3];
      const r = Math.round((rgba[p] * 255 + a / 2) / a);
      const g = Math.round((rgba[p + 1] * 255 + a / 2) / a);
      const b = Math.round((rgba[p + 2] * 255 + a / 2) / a);
      matches = near(r, g, b, includes) && !near(r, g, b, excludes);
    }
    if (invert) matches = !matches;
    mask[i] = matches ? 255 : 0;
  }
  return mask;
}

// Subject: flood-grows the border's background — transparent pixels plus those
// within `tolerance` of the border's average tone — then selects the rest. An
// approximation of Vision's subject separation for the common cut-out case.
export function subjectMask(rgba, width, height, tolerance) {
  const mask = new Uint8Array(width * height); // 255 = background
  // The background's reference tone: the average of opaque border pixels.
  let rSum = 0, gSum = 0, bSum = 0, samples = 0;
  const border = (x, y) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!border(x, y)) continue;
      const p = (y * width + x) * 4;
      if (rgba[p + 3] >= 8) {
        const a = rgba[p + 3];
        rSum += Math.round((rgba[p] * 255 + a / 2) / a);
        gSum += Math.round((rgba[p + 1] * 255 + a / 2) / a);
        bSum += Math.round((rgba[p + 2] * 255 + a / 2) / a);
        samples += 1;
      }
    }
  }
  const reference = samples ? [rSum / samples, gSum / samples, bSum / samples] : [255, 255, 255];
  const isBackground = (x, y) => {
    const p = (y * width + x) * 4;
    if (rgba[p + 3] < 8) return true;
    const a = rgba[p + 3];
    const r = (rgba[p] * 255 + a / 2) / a;
    const g = (rgba[p + 1] * 255 + a / 2) / a;
    const b = (rgba[p + 2] * 255 + a / 2) / a;
    return Math.abs(r - reference[0]) <= tolerance
      && Math.abs(g - reference[1]) <= tolerance
      && Math.abs(b - reference[2]) <= tolerance;
  };
  // Scanline flood from every border pixel, as the wand does from its seed.
  const stack = [];
  for (let x = 0; x < width; x += 1) stack.push(x, 0, x, height - 1);
  for (let y = 1; y < height - 1; y += 1) stack.push(0, y, width - 1, y);
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * width;
    if (mask[row + x] || !isBackground(x, y)) continue;
    let left = x, right = x;
    while (left > 0 && !mask[row + left - 1] && isBackground(left - 1, y)) left -= 1;
    while (right + 1 < width && !mask[row + right + 1] && isBackground(right + 1, y)) right += 1;
    mask.fill(255, row + left, row + right + 1);
    for (let side = 0; side < 2; side += 1) {
      const ny = side === 0 ? y - 1 : y + 1;
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let nx = left; nx <= right; nx += 1) {
        const candidate = !mask[nrow + nx] && isBackground(nx, ny);
        if (candidate && !inRun) stack.push(nx, ny);
        inRun = candidate;
      }
    }
  }
  // The selection is everything that isn't background.
  for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] ? 0 : 255;
  return mask;
}

// Traces a coverage mask's outline along exact pixel edges (wand_trace port):
// directed boundary edges on the (w+1)×(h+1) grid, walked clockwise around each
// pixel; where two loops meet at a corner, turning right keeps them apart.
export function traceMaskOutline(mask, width, height) {
  if (!width || !height) return [];
  const EAST = 1, SOUTH = 2, WEST = 4, NORTH = 8;
  const stride = width + 1;
  const out = new Uint8Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) continue;
      if (y === 0 || !mask[row - width + x]) out[y * stride + x] |= EAST;
      if (x + 1 === width || !mask[row + x + 1]) out[y * stride + x + 1] |= SOUTH;
      if (y + 1 === height || !mask[row + width + x]) out[(y + 1) * stride + x + 1] |= WEST;
      if (x === 0 || !mask[row + x - 1]) out[(y + 1) * stride + x] |= NORTH;
    }
  }
  const turnRight = (d) => (d === NORTH ? EAST : d << 1);
  const turnLeft = (d) => (d === EAST ? NORTH : d >> 1);
  const loops = [];
  const limit = 8_000_000;
  let edges = 0;
  for (let i = 0; i < out.length; i += 1) {
    for (let b = out[i]; b; b &= b - 1) edges += 1;
  }
  if (edges > limit) return []; // too detailed to outline; the coverage still works
  for (let start = 0; start < out.length; start += 1) {
    while (out[start]) {
      const points = [];
      let v = start;
      let heading = 0, initial = 0;
      do {
        const bits = out[v];
        let d;
        if (!heading) d = bits & -bits;
        else if (bits & turnRight(heading)) d = turnRight(heading);
        else if (bits & heading) d = heading;
        else if (bits & turnLeft(heading)) d = turnLeft(heading);
        else d = bits & -bits;
        if (!d) break;
        out[v] &= ~d;
        if (d !== heading) points.push([v % stride, (v / stride) | 0]);
        if (!heading) initial = d;
        heading = d;
        v = d === EAST ? v + 1 : d === WEST ? v - 1 : d === SOUTH ? v + stride : v - stride;
      } while (v !== start);
      // The start is a corner unless the loop arrives on the heading it left with.
      if (heading === initial && points.length > 0) points.shift();
      if (points.length >= 3) loops.push(points);
    }
  }
  return loops;
}

// Moves a mask by whole pixels without re-deriving it, so it can leave the
// canvas and come back intact.
export function translateMask(mask, width, height, dx, dy) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      out[y * width + x] = mask[sy * width + sx];
    }
  }
  return out;
}

// ---- The selection object ----

export function makeSelection(mask, width, height, { feather = 0 } = {}) {
  const bounds = maskBounds(mask, width);
  if (!bounds) return null;
  return {
    mask,
    width,
    height,
    feather,
    paths: traceMaskOutline(mask, width, height),
    bounds,
  };
}

export function selectionFromShapes(shapes, width, height, feather = 0) {
  return makeSelection(rasterizeShapes(shapes, width, height), width, height, { feather });
}

export function selectionIsEmpty(selection) {
  return !selection || !selection.bounds;
}

// Point-in-selection test in document pixels.
export function selectionContains(selection, point) {
  if (!selection) return false;
  const x = Math.floor(point.x), y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= selection.width || y >= selection.height) return false;
  return selection.mask[y * selection.width + x] > 0;
}

// Selection coverage for one region of the document, ready to clip edits: the
// mask cropped to `rect` as a canvas whose alpha is the coverage.
export function selectionClip(selection, rect) {
  if (!selection || !selection.bounds) return { rect: null, coverage: null };
  const region = {
    x: Math.max(0, Math.floor(selection.bounds.x - FEATHER_BOUNDS_PAD(selection.feather) - 1)),
    y: Math.max(0, Math.floor(selection.bounds.y - FEATHER_BOUNDS_PAD(selection.feather) - 1)),
    width: 0,
    height: 0,
  };
  region.width = Math.min(selection.width, Math.ceil(selection.bounds.x + selection.bounds.width + FEATHER_BOUNDS_PAD(selection.feather) + 1)) - region.x;
  region.height = Math.min(selection.height, Math.ceil(selection.bounds.y + selection.bounds.height + FEATHER_BOUNDS_PAD(selection.feather) + 1)) - region.y;
  const canvas = document.createElement("canvas");
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(region.width, region.height);
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const docX = region.x + x, docY = region.y + y;
      const value = selection.mask[docY * selection.width + docX];
      const p = (y * region.width + x) * 4;
      image.data[p + 3] = value;
    }
  }
  context.putImageData(image, 0, 0);
  return { rect: region, coverage: canvas };
}

// Clips a painted canvas (in layer pixel space) to the selection: coverage is
// mapped from document space into the layer's grid through the inverse of its
// placement transform. Returns null when there is no selection.
export function clippedToSelection(painted, transform, documentWidth, documentHeight) {
  const selection = sessionSelection();
  if (!selection) return painted;
  const { rect: region, coverage } = selectionClip(selection, { x: 0, y: 0, width: documentWidth, height: documentHeight });
  if (!coverage) return document.createElement("canvas"); // explicit empty: touch nothing
  const grid = document.createElement("canvas");
  grid.width = painted.width;
  grid.height = painted.height;
  const context = grid.getContext("2d");
  // The layer's CTM maps grid pixels to document points (render.enterGridSpace);
  // drawing the coverage through it resamples the document-space mask in place.
  context.setTransform(1, 0, 0, 1, 0, 0);
  const rotation = ((transform.rotation || 0) * Math.PI) / 180;
  context.translate(transform.size.width / 2, transform.size.height / 2);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.rotate(-rotation);
  context.translate(-transform.origin.x - transform.size.width / 2, -transform.origin.y - transform.size.height / 2);
  context.drawImage(coverage, region.x, region.y);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(painted, 0, 0);
  return grid;
}

// The session's live selection; injected by state.js to avoid a cycle.
let sessionSelection = () => null;
export function installSelectionState(getter) {
  sessionSelection = getter;
}
