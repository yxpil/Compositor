// The 12 adjustment-layer kinds, dispatching to the pixel kernels with the exact
// semantics of LayerAdjustment.swift + its filters.

import * as K from "./kernels.js";
import { levelRangeApply, normalizeLevelRange, defaultLevelsSettings, defaultCurvesSettings, monotoneCurveValue } from "./format.js";

function levelsApplyValue(settings, value) {
  // Individual channels, followed by the composite RGB adjustment.
  const ranges = settings.ranges || defaultLevelsSettings().ranges;
  const channelIndex = { RGB: 0, Red: 1, Green: 2, Blue: 3 }[settings.channel || "RGB"] ?? 0;
  const channel = levelRangeApply(ranges[channelIndex], value);
  return levelRangeApply(normalizeLevelRange(ranges[0]), channel);
}

function applyLevels(image, settings) {
  // One 256-entry table per color channel, channel curve then composite RGB.
  const tables = ["Red", "Green", "Blue"].map(() => new Float32Array(256));
  for (let v = 0; v <= 255; v += 1) {
    for (let c = 0; c < 3; c += 1) {
      tables[c][v] = levelsApplyValue(settings, v / 255);
    }
  }
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = Math.round(tables[0][data[i]] * 255);
    data[i + 1] = Math.round(tables[1][data[i + 1]] * 255);
    data[i + 2] = Math.round(tables[2][data[i + 2]] * 255);
  }
  return image;
}

function applyCurves(image, settings) {
  const channels = settings.channels || defaultCurvesSettings().channels;
  const tables = [1, 2, 3].map((channel) => {
    const table = new Float32Array(256);
    for (let v = 0; v <= 255; v += 1) {
      // The channel curve, then the composite RGB curve.
      table[v] = monotoneCurveValue(channels[0], monotoneCurveValue(channels[channel], v)) / 255;
    }
    return table;
  });
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = Math.round(tables[0][data[i]] * 255);
    data[i + 1] = Math.round(tables[1][data[i + 1]] * 255);
    data[i + 2] = Math.round(tables[2][data[i + 2]] * 255);
  }
  return image;
}

function resolved(adjustment) {
  return {
    hsv: adjustment.hsvSettings || {
      range: "Master", colorize: !!adjustment.colorize, invertRange: false,
      adjustments: adjustment.hue || adjustment.saturation || adjustment.lightness
        ? { Master: { hue: adjustment.hue || 0, saturation: adjustment.saturation || 0, lightness: adjustment.lightness || 0 } }
        : {},
      bands: {},
    },
    exposure: adjustment.exposureSettings || { exposure: 0, offset: 0, gamma: 1 },
    gradientMap: adjustment.gradientMapSettings || { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false },
    grain: adjustment.grainSettings || { amount: 25, size: 1.5, roughness: 50, seed: 0 },
    blurRadius: adjustment.blurRadius ?? 10,
    motionAngle: adjustment.motionAngle ?? 0,
    motionDistance: adjustment.motionDistance ?? 10,
    noiseAmount: adjustment.noiseAmount ?? 10,
    noiseGaussian: adjustment.noiseGaussian ?? false,
    noiseMonochromatic: adjustment.noiseMonochromatic ?? false,
    noiseSeed: adjustment.noiseSeed ?? 0,
  };
}

// `region` places the image's pixels in document space (whole image at 1:1 omitted),
// so Grain's pattern and Add Noise's field stay fixed in the document.
export function applyAdjustment(image, adjustment, region, documentWidth, documentHeight) {
  const r = resolved(adjustment);
  const originX = region ? region.x : 0;
  const originY = region ? region.y : 0;
  const unitsPerPixel = region && region.width ? region.width / image.width : 1;
  switch (adjustment.kind) {
    case "Hue/Saturation":
      return K.applyHueSaturation(image, r.hsv);
    case "Levels":
      return applyLevels(image, adjustment.levels || defaultLevelsSettings());
    case "Curves":
      return applyCurves(image, adjustment.curves || defaultCurvesSettings());
    case "Exposure": {
      const e = r.exposure;
      return K.applyLut(image, K.exposureTable(e.exposure, e.offset, e.gamma));
    }
    case "Gradient Map":
      return K.applyGradientMap(image, K.gradientMapLut(r.gradientMap.shadows, r.gradientMap.highlights, !!r.gradientMap.reversed));
    case "Grain": {
      const g = r.grain;
      return K.applyGrain(image, g.amount, g.size, g.roughness, g.seed >>> 0, originX, originY, unitsPerPixel);
    }
    case "Gaussian Blur":
      return applyGaussianBlur(image, r.blurRadius, originX, originY);
    case "Motion Blur":
      return K.applyMotionBlur(image, r.motionAngle, r.motionDistance);
    case "Add Noise":
      return K.applyNoise(image, r.noiseAmount, r.noiseGaussian, r.noiseMonochromatic, r.noiseSeed >>> 0,
        Math.round(originX), Math.round(originY));
    case "Invert":
      return K.applyInvert(image);
    case "Black & White":
      return K.applyBlackWhite(image, adjustment.blackWhiteSettings || {
        reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
        tint: false, tintHue: 40, tintSaturation: 20,
      });
    case "Color Balance":
      return K.applyColorBalance(image, adjustment.colorBalanceSettings || {
        shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0,
        midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
        highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
        preserveLuminosity: true,
      });
    default:
      return image;
  }
}

// Gaussian blur with edge-clamped separable kernel over straight-alpha pixels.
export function applyGaussianBlur(image, radius, originX = 0, originY = 0) {
  const width = image.width, height = image.height;
  const data = image.data;
  const alpha = new Float32Array(width * height);
  const planes = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    alpha[p] = data[i + 3] / 255;
    planes[0][p] = data[i] * alpha[p];
    planes[1][p] = data[i + 1] * alpha[p];
    planes[2][p] = data[i + 2] * alpha[p];
  }
  const blurred = planes.map((plane) => K.gaussianBlurPlane(plane, width, height, Math.max(0.01, radius / 2)));
  const blurredAlpha = K.gaussianBlurPlane(alpha, width, height, Math.max(0.01, radius / 2));
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const a = blurredAlpha[p] * 255;
    data[i + 3] = Math.round(a);
    if (a > 0.5) {
      data[i] = Math.round(Math.min(255, blurred[0][p] / (a / 255)));
      data[i + 1] = Math.round(Math.min(255, blurred[1][p] / (a / 255)));
      data[i + 2] = Math.round(Math.min(255, blurred[2][p] / (a / 255)));
    }
  }
  return image;
}
