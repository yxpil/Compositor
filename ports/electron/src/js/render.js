// The compositor. Mirrors the macOS renderer's semantics:
// - Layers draw bottom-to-top onto a shared target (pass-through folders), blending
//   against everything below; CoreGraphics-equivalent blend modes.
// - Visibility is inherited; opacity is the parent-chain product (folder opacity is v8).
// - Folder masks (v6) isolate the subtree: the folder's children composite into their own
//   buffer, the grayscale mask clips it, and the buffer draws with the folder's opacity.
// - Adjustment layers (v7) affect everything composited below them within their folder,
//   scaled by their effective opacity and clipped by their own raster mask if present.
//   A folder containing a visible adjustment therefore renders into a buffer too.
// - Raster masks (v4) clip before blend/opacity; maskPlacement (additive field) keeps an
//   unlinked mask in document space; group masks cover the folder's own transform rectangle.
// - Clipping masks (v5, maskSourceID) multiply the target's coverage with the source's live
//   alpha in document coordinates: source pixels, transform, opacity, raster mask and
//   upstream live masks contribute; visibility and RGB do not.
// - Guides (v8) are session display only.

import { BLEND_TO_CANVAS } from "./format.js";
import { applyAdjustment } from "./adjustments.js";
import { renderLayerEffects, placedTransform, createEffectsCache } from "./effects.js";

const effectsCache = createEffectsCache();

export function drawTransformed(context, transform, image) {
  const { origin, size } = transform;
  context.save();
  context.translate(origin.x + size.width / 2, origin.y + size.height / 2);
  context.rotate(((transform.rotation || 0) * Math.PI) / 180);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.imageSmoothingEnabled = (transform.sampling || "Smooth") !== "Nearest";
  context.imageSmoothingQuality = transform.sampling === "High quality" ? "high" : "medium";
  context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
  context.restore();
}

function samePlacement(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Sets the canvas CTM to map document points into a layer's pixel grid: the inverse
// of drawTransformed's placement. LayerMask.placed composes exactly this inverse with
// the mask's own placement (pixelToDocument(placement)·pixelToDocument(layer)⁻¹).
function enterGridSpace(context, transform) {
  const rotation = ((transform.rotation || 0) * Math.PI) / 180;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.translate(transform.size.width / 2, transform.size.height / 2);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.rotate(-rotation);
  context.translate(-transform.origin.x - transform.size.width / 2, -transform.origin.y - transform.size.height / 2);
}

export function createRenderer(manifest, images, hooks = {}) {
  const { width, height } = manifest;
  const layerById = new Map(manifest.layers.map((layer) => [layer.id, layer]));
  const maskCache = new Map();

  // Tree for scope decisions; the flat array stays authoritative for order.
  const children = new Map();
  for (const layer of manifest.layers) {
    const key = layer.parentID && layerById.has(layer.parentID) ? layer.parentID : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(layer);
  }

  function visibleWithAncestors(layer) {
    let current = layer;
    while (current) {
      if (current.isVisible === false) return false;
      current = current.parentID ? layerById.get(current.parentID) : null;
    }
    return true;
  }

  function effectiveOpacity(layer, scopeParentId = null) {
    let opacity = typeof layer.opacity === "number" ? layer.opacity : 1;
    let current = layer.parentID ? layerById.get(layer.parentID) : null;
    while (current) {
      if (scopeParentId !== null && current.id === scopeParentId) break;
      if (typeof current.opacity === "number") opacity *= current.opacity;
      current = current.parentID ? layerById.get(current.parentID) : null;
    }
    return opacity;
  }

  function subtreeContainsAdjustment(node) {
    for (const child of children.get(node.id) || []) {
      if (child.adjustment && visibleWithAncestors(child)) return true;
      if (child.isGroup && subtreeContainsAdjustment(child)) return true;
    }
    return false;
  }

  // A folder renders isolated when it has an enabled mask or a visible adjustment inside.
  function folderNeedsBuffer(folder) {
    return (folder.maskFile && folder.maskEnabled !== false) || subtreeContainsAdjustment(folder);
  }

  function makeCanvas(w = width, h = height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    return canvas;
  }

  function maskAsAlpha(maskFile) {
    if (maskCache.has(maskFile)) return maskCache.get(maskFile);
    const image = images.get(maskFile);
    if (!image) return null;
    const canvas = makeCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = data.data;
    // Masks are 8-bit grayscale coverage without alpha: luminance becomes coverage.
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = pixels[i];
    }
    context.putImageData(data, 0, 0);
    maskCache.set(maskFile, canvas);
    return canvas;
  }

  // One leaf layer's own pixels: the cached asset, or a live text/shape raster.
  function liveRasterOf(layer) {
    if (hooks.rasterize && !images.get(layer.imageFile) && (layer.text || layer.shape)) {
      return hooks.rasterize(layer);
    }
    return images.get(layer.imageFile) || null;
  }

  // One leaf layer's raster for compositing. Without masking this is the raw source:
  // the caller places it with drawTransformed, one resample straight into document
  // space (CoreGraphics draws the transform, not a grid-staged copy). With a raster
  // mask or a clipping source, everything composites inside the layer's pixel grid
  // (LayerMask.clipImage) and the caller places the finished grid with the transform.
  function layerRaster(layer) {
    const source = liveRasterOf(layer);
    if (!source) return null;
    const mask = layer.maskFile && layer.maskEnabled !== false ? maskAsAlpha(layer.maskFile) : null;
    if (!mask && !layer.maskSourceID) return source;
    const size = layer.transform.size;
    const canvas = makeCanvas(Math.abs(size.width) || 1, Math.abs(size.height) || 1);
    const context = canvas.getContext("2d");
    // The source stretches over the whole pixel grid; flips and rotation belong to
    // the placement, applied once when the grid lands in document space.
    context.imageSmoothingEnabled = (layer.transform.sampling || "Smooth") !== "Nearest";
    context.imageSmoothingQuality = layer.transform.sampling === "High quality" ? "high" : "medium";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    if (mask) {
      const placement = layer.maskPlacement;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "destination-in";
      if (!placement || samePlacement(placement, layer.transform)) {
        // Linked: the mask stretches over the layer's whole pixel grid (LayerMask.clipImage).
        context.drawImage(mask, 0, 0, canvas.width, canvas.height);
      } else {
        // Placed apart: the mask lives in document space; resample it into the grid.
        enterGridSpace(context, layer.transform);
        drawTransformed(context, placement, mask);
      }
      context.globalCompositeOperation = "source-over";
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (layer.maskSourceID) {
      const upstream = liveAlphaOf(layer.maskSourceID);
      if (upstream) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = "destination-in";
        // The clip composites in document space (CIBlendWithAlphaMask); map it into
        // the layer's grid so offset/rotated layers clip at the right place.
        enterGridSpace(context, layer.transform);
        context.drawImage(upstream, 0, 0);
        context.globalCompositeOperation = "source-over";
        context.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    return canvas;
  }

  // Live alpha of a clipping source in document space: pixels at its transform, times its
  // own raster mask, times upstream live masks. Visibility and RGB do not contribute.
  const liveAlphaCache = new Map();
  function liveAlphaOf(layerId, depth = 0) {
    if (depth > 256) return null;
    const key = `${layerId}`;
    if (liveAlphaCache.has(key)) return liveAlphaCache.get(key);
    const layer = layerById.get(layerId);
    if (!layer || layer.isGroup) return null;
    const image = liveRasterOf(layer);
    if (!image) return null;
    const canvas = makeCanvas();
    const context = canvas.getContext("2d", { willReadFrequently: true });
    drawTransformed(context, layer.transform, image);
    if (layer.maskFile && layer.maskEnabled !== false) {
      const mask = maskAsAlpha(layer.maskFile);
      if (mask) {
        const placement = layer.maskPlacement || layer.transform;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = "destination-in";
        drawTransformed(context, placement, mask);
        context.globalCompositeOperation = "source-over";
        context.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    let opacity = typeof layer.opacity === "number" ? layer.opacity : 1;
    let parent = layer.parentID ? layerById.get(layer.parentID) : null;
    while (parent) {
      if (typeof parent.opacity === "number") opacity *= parent.opacity;
      parent = parent.parentID ? layerById.get(parent.parentID) : null;
    }
    if (opacity < 1) {
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = data.data;
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = Math.round(pixels[i] * opacity);
      context.putImageData(data, 0, 0);
    }
    if (layer.maskSourceID) {
      const upstream = liveAlphaOf(layer.maskSourceID, depth + 1);
      if (upstream) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = "destination-in";
        context.drawImage(upstream, 0, 0);
        context.globalCompositeOperation = "source-over";
      }
    }
    liveAlphaCache.set(key, canvas);
    return canvas;
  }

  function renderNodeList(context, nodes, scopeParentId = null) {
    for (const layer of nodes) {
      if (!visibleWithAncestors(layer)) continue;
      if (layer.isGroup) {
        renderGroup(layer, context, scopeParentId);
      } else if (layer.adjustment) {
        renderAdjustment(layer, context, scopeParentId);
      } else {
        renderLeaf(layer, context, scopeParentId);
      }
    }
  }

  function renderGroup(folder, context, scopeParentId = null) {
    const kids = children.get(folder.id) || [];
    if (folderNeedsBuffer(folder)) {
      const buffer = makeCanvas();
      renderNodeList(buffer.getContext("2d"), kids, folder.id);
      if (folder.maskFile && folder.maskEnabled !== false) {
        const mask = maskAsAlpha(folder.maskFile);
        if (mask) {
          const bufferContext = buffer.getContext("2d");
          const placement = folder.maskPlacement || folder.transform;
          bufferContext.setTransform(1, 0, 0, 1, 0, 0);
          bufferContext.globalCompositeOperation = "destination-in";
          drawTransformed(bufferContext, placement, mask);
          bufferContext.globalCompositeOperation = "source-over";
        }
      }
      context.globalAlpha = effectiveOpacity(folder, scopeParentId);
      context.drawImage(buffer, 0, 0);
      context.globalAlpha = 1;
    } else {
      // Pass-through: children blend against everything below the folder too.
      renderNodeList(context, kids, scopeParentId);
    }
  }

  function renderAdjustment(layer, context, scopeParentId = null) {
    const canvas = context.canvas;
    const effective = effectiveOpacity(layer, scopeParentId);
    if (effective <= 0) return;
    const snapshot = context.getImageData(0, 0, canvas.width, canvas.height);
    const adjusted = new ImageData(new Uint8ClampedArray(snapshot.data), snapshot.width, snapshot.height);
    applyAdjustment(adjusted, layer.adjustment, null, manifest.width, manifest.height);
    // The adjustment's own raster mask limits where it applies (maskPlacement follows
    // the layer transform when linked).
    if (layer.maskFile && layer.maskEnabled !== false) {
      const mask = maskAsAlpha(layer.maskFile);
      if (mask) {
        const placed = makeCanvas();
        const placedContext = placed.getContext("2d");
        const placement = layer.maskPlacement || layer.transform;
        drawTransformed(placedContext, placement, mask);
        const coverage = placedContext.getImageData(0, 0, placed.width, placed.height).data;
        const out = adjusted.data;
        for (let i = 3; i < out.length; i += 4) {
          out[i] = Math.round(out[i] * (coverage[i] / 255));
        }
      }
    }
    const data = adjusted.data;
    const original = snapshot.data;
    // Opacity scales the adjustment's strength (CIBlendWithRedMask): per-channel mix
    // back toward the snapshot. Kernels don't touch alpha, so RGB does the work.
    for (let i = 0; i < data.length; i += 4) {
      if (effective >= 1) break;
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.round(original[i + c] + (data[i + c] - original[i + c]) * effective);
      }
    }
    context.putImageData(adjusted, 0, 0);
  }

  function renderLeaf(layer, context, scopeParentId = null) {
    const raster = layerRaster(layer);
    if (!raster) return;
    context.globalAlpha = effectiveOpacity(layer, scopeParentId);
    context.globalCompositeOperation = BLEND_TO_CANVAS[layer.blendMode] || "source-over";
    // Effects render around the layer's own pixels (LayerEffectsRenderer); the
    // padded result lands through a grown transform, cache keyed on the raster.
    if (layer.effects) {
      const styled = effectsCache.get(raster, layer.effects)
        || renderLayerEffects(raster, layer.effects);
      if (styled) {
        effectsCache.put(raster, layer.effects, styled);
        drawTransformed(context, placedTransform(layer.transform, styled.image.width, styled.image.height, styled.inset), styled.image);
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        return;
      }
    }
    drawTransformed(context, layer.transform, raster);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  function render() {
    liveAlphaCache.clear();
    const canvas = makeCanvas();
    const context = canvas.getContext("2d");
    renderNodeList(context, children.get(null) || []);
    if (hooks.afterRender) hooks.afterRender(canvas);
    return canvas;
  }

  return { render, layerById, visibleWithAncestors, effectiveOpacity, maskAsAlpha, drawTransformed, children };
}
