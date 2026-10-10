// Layer effects rendering, ported from LayerEffectsRenderer (the CPU path):
// a shadow is the layer's shape moved and softened; an outer glow is the shape
// softened omnidirectionally with its interior excluded; a stroke is the band
// between the shape and its morphological grow/shrink (a square reach, not a
// round one); inner effects recolor the pixels themselves, keeping their alpha
// (source-atop). Order: shadow, outer glow, outside stroke, the styled pixels
// (color overlay, inner glow, inner shadow), then an inside stroke on top.
// Returns a padded canvas plus its inset so the caller grows the transform to
// land the bigger image where the layer sits.

const EFFECT_PAD = 2;

export function effectsVisible(effects) {
  if (!effects) return null;
  const visible = {};
  for (const key of ["stroke", "shadow", "colorOverlay", "innerShadow", "outerGlow", "innerGlow"]) {
    const effect = effects[key];
    if (effect && effect.isEnabled !== false) visible[key] = effect;
  }
  return Object.keys(visible).length ? visible : null;
}

// The room the effects need around the pixels (LayerEffectsRenderer.margin).
export function marginFor(effects) {
  let margin = 0;
  if (effects.stroke && !effects.stroke.inside) margin = Math.max(margin, effects.stroke.size);
  if (effects.shadow) margin = Math.max(margin, effects.shadow.distance + effects.shadow.blur * 3);
  if (effects.outerGlow) margin = Math.max(margin, effects.outerGlow.size * 3);
  return Math.ceil(margin) + EFFECT_PAD;
}

// Shadow offset from the angle: degrees counterclockwise from the right; the
// shadow falls away from the light, y downward (ShadowEffect.offset).
export function shadowOffset(effect) {
  const radians = (effect.angle * Math.PI) / 180;
  return { x: -Math.cos(radians) * effect.distance, y: Math.sin(radians) * effect.distance };
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// The shape's own alpha, placed in a bigger canvas and optionally softened:
// sigma = blur/2 as CIApplyingGaussianBlur does (Canvas blur(x) has sigma x/2,
// so the CSS radius equals the effect's blur value).
function coverageCanvas(source, width, height, dx, dy, blur) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d");
  if (blur > 0) context.filter = `blur(${blur}px)`;
  context.drawImage(source, dx, dy);
  return canvas;
}

function alphaOf(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, p = 3; i < alpha.length; i += 1, p += 4) alpha[i] = data[p] / 255;
  return alpha;
}

function coverageFromLevels(levels, width, height) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  for (let i = 0, p = 3; i < levels.length; i += 1, p += 4) image.data[p] = Math.round(levels[i] * 255);
  context.putImageData(image, 0, 0);
  return canvas;
}

// Two sliding-window passes (LayerEffectsRenderer.extreme): the max or min
// value within `reach` on each side, cost independent of the reach.
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

// Fills `color` at `alpha` where the coverage canvas shows, into `context`.
function fillWithCoverage(context, color, alpha, coverage) {
  const tinted = makeCanvas(coverage.width, coverage.height);
  const tintedContext = tinted.getContext("2d");
  tintedContext.fillStyle = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`;
  tintedContext.fillRect(0, 0, tinted.width, tinted.height);
  tintedContext.globalCompositeOperation = "destination-in";
  tintedContext.drawImage(coverage, 0, 0);
  context.globalAlpha = alpha;
  context.drawImage(tinted, 0, 0);
  context.globalAlpha = 1;
}

// Recolors the pixels toward `color` by `alpha`, scaled by `amount` where given,
// keeping their alpha: source-atop, so a translucent pixel takes the color fully.
function recolor(context, color, alpha, amount) {
  let source;
  if (amount) {
    source = makeCanvas(amount.width, amount.height);
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`;
    sourceContext.fillRect(0, 0, source.width, source.height);
    sourceContext.globalCompositeOperation = "destination-in";
    sourceContext.drawImage(amount, 0, 0);
  } else {
    source = makeCanvas(1, 1);
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = `rgba(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)},${alpha})`;
    sourceContext.fillRect(0, 0, 1, 1);
  }
  context.globalCompositeOperation = "source-atop";
  if (amount) {
    context.globalAlpha = alpha;
    context.drawImage(source, 0, 0);
    context.globalAlpha = 1;
  } else {
    context.drawImage(source, 0, 0, context.canvas.width, context.canvas.height);
  }
  context.globalCompositeOperation = "source-over";
}

// Where an inner glow or inner shadow falls: what lies outside the layer,
// moved and softened, inverted (strength before the layer's own alpha).
function insideCoverage(source, width, height, dx, dy, blur) {
  const moved = alphaOf(coverageCanvas(source, width, height, dx, dy, blur));
  const inside = new Float32Array(moved.length);
  for (let i = 0; i < inside.length; i += 1) inside[i] = Math.max(0, Math.min(1, 1 - moved[i]));
  return coverageFromLevels(inside, width, height);
}

// An outer glow's coverage: the shape softened, its sharp interior excluded.
function outerGlowCoverage(source, width, height, size) {
  const soft = alphaOf(coverageCanvas(source, width, height, 0, 0, size));
  const shape = alphaOf(coverageCanvas(source, width, height, 0, 0, 0));
  const levels = new Float32Array(soft.length);
  for (let i = 0; i < levels.length; i += 1) {
    levels[i] = Math.max(0, Math.min(1, soft[i] * (1 - shape[i])));
  }
  return coverageFromLevels(levels, width, height);
}

// Where a stroke lands: the shape grown (or shrunk) by its size, less the
// shape itself — a square reach via the sliding-window extreme.
function strokeCoverage(shapeLevels, width, height, stroke) {
  const reach = Math.max(1, Math.round(stroke.size));
  const moved = extreme(shapeLevels, width, height, reach, stroke.inside);
  const ring = new Float32Array(shapeLevels.length);
  for (let i = 0; i < ring.length; i += 1) {
    ring[i] = stroke.inside
      ? Math.max(0, shapeLevels[i] - moved[i])
      : Math.max(0, moved[i] - shapeLevels[i]);
  }
  return coverageFromLevels(ring, width, height);
}

const hex = (value) => Math.round(value * 255).toString(16).padStart(2, "0");
const rgbOf = (color) => `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;

// `raster` (the layer's shown pixels, mask already applied) with `effects`
// around it. Null when there is nothing to draw, so the caller draws the layer
// as it is. `MAX_SURFACE_PIXELS` guards the padded canvas size.
export function renderLayerEffects(raster, effects, maxSurfacePixels = 200_000_000) {
  const visible = effectsVisible(effects);
  if (!visible || !raster) return null;
  const inset = marginFor(visible);
  const width = raster.width + inset * 2;
  const height = raster.height + inset * 2;
  if (width * height > maxSurfacePixels) return null;
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const stroke = visible.stroke && visible.stroke.size > 0 && visible.stroke.opacity > 0 ? visible.stroke : null;
  let shapeLevels = null;
  function shapeCoverage() {
    if (!shapeLevels) shapeLevels = alphaOf(coverageCanvas(raster, width, height, inset, inset, 0));
    return shapeLevels;
  }

  if (visible.shadow && visible.shadow.opacity > 0) {
    const offset = shadowOffset(visible.shadow);
    const coverage = coverageCanvas(raster, width, height, inset + offset.x, inset + offset.y, visible.shadow.blur);
    fillWithCoverage(context, visible.shadow, visible.shadow.opacity, coverage);
  }
  if (visible.outerGlow && visible.outerGlow.opacity > 0) {
    const coverage = outerGlowCoverage(raster, width, height, visible.outerGlow.size);
    fillWithCoverage(context, visible.outerGlow, visible.outerGlow.opacity, coverage);
  }
  if (stroke && !stroke.inside) {
    const coverage = strokeCoverage(shapeCoverage(), width, height, stroke);
    fillWithCoverage(context, stroke, stroke.opacity, coverage);
  }

  // The pixels with room around them, recolored by the overlay, inner glow and
  // inner shadow (each keeping the pixels' alpha), then an inside stroke on top.
  const styled = makeCanvas(width, height);
  const styledContext = styled.getContext("2d");
  styledContext.drawImage(raster, inset, inset);
  if (visible.colorOverlay && visible.colorOverlay.opacity > 0) {
    recolor(styledContext, visible.colorOverlay, visible.colorOverlay.opacity, null);
  }
  if (visible.innerGlow && visible.innerGlow.isEnabled !== false && visible.innerGlow.size > 0 && visible.innerGlow.opacity > 0) {
    const amount = insideCoverage(raster, width, height, inset, inset, visible.innerGlow.size);
    recolor(styledContext, visible.innerGlow, visible.innerGlow.opacity, amount);
  }
  if (visible.innerShadow && visible.innerShadow.isEnabled !== false && visible.innerShadow.opacity > 0) {
    const offset = shadowOffset(visible.innerShadow);
    const amount = insideCoverage(raster, width, height, inset + offset.x, inset + offset.y, visible.innerShadow.blur);
    recolor(styledContext, visible.innerShadow, visible.innerShadow.opacity, amount);
  }
  context.drawImage(styled, 0, 0);
  if (stroke && stroke.inside) {
    const coverage = strokeCoverage(shapeCoverage(), width, height, stroke);
    fillWithCoverage(context, stroke, stroke.opacity, coverage);
  }
  return { image: canvas, inset };
}

// The transform grown by the margin its effects need, so the bigger image lands
// in the same place (LayerEffectsRenderer.placed).
export function placedTransform(transform, imageWidth, imageHeight, inset) {
  if (imageWidth <= inset * 2 || imageHeight <= inset * 2) return transform;
  const size = {
    width: transform.size.width * imageWidth / (imageWidth - inset * 2),
    height: transform.size.height * imageHeight / (imageHeight - inset * 2),
  };
  const centerX = transform.origin.x + transform.size.width / 2;
  const centerY = transform.origin.y + transform.size.height / 2;
  return {
    ...transform,
    size,
    origin: { x: centerX - size.width / 2, y: centerY - size.height / 2 },
  };
}

// Small result cache: effects only change when the pixels or settings do.
export function createEffectsCache(limit = 8) {
  const entries = new Map();
  return {
    get(raster, effects) {
      const key = `${raster?.__assetId || ""}|${JSON.stringify(effects)}`;
      const hit = entries.get(key);
      if (hit && hit.raster === raster) return hit.result;
      return null;
    },
    put(raster, effects, result) {
      const key = `${raster?.__assetId || ""}|${JSON.stringify(effects)}`;
      entries.set(key, { raster, result });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
  };
}
