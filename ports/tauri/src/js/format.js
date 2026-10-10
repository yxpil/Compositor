// Format constants, limits and enums mirroring the macOS app's DocumentLimits,
// ProjectStore validation and settings ranges (docs/project-format.md, v1–11).

export const PROJECT_FORMAT = "com.compositor.project";
export const MIN_VERSION = 1;
export const MAX_VERSION = 11;
export const SAVE_VERSION = 11;

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
export const MAX_LAYERS = 10_000;
export const MAX_SIDE = 30_000;
export const MAX_SURFACE_PIXELS = 200_000_000;
export const MAX_TOTAL_PIXELS = 800_000_000;
export const MAX_GUIDES = 1_000;
export const MAX_GUIDE_POSITION = 1_000_000;
export const MAX_GROUP_DEPTH = 64;
export const MAX_CLIP_CHAIN = 256;

export const BLEND_MODES = [
  "Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten",
  "Difference", "Color Dodge", "Color Burn",
];
export const BLEND_TO_CANVAS = {
  Normal: "source-over",
  Multiply: "multiply",
  Screen: "screen",
  Overlay: "overlay",
  Darken: "darken",
  Lighten: "lighten",
  Difference: "difference",
  "Color Dodge": "color-dodge",
  "Color Burn": "color-burn",
};
export const SAMPLING_MODES = ["Nearest", "Smooth", "High quality"];
// Folders may carry their own opacity from version 8 on (docs/project-format.md).
export const FOLDER_OPACITY_VERSION = 8;

export const ADJUSTMENT_KINDS = [
  "Hue/Saturation", "Levels", "Curves", "Exposure", "Gradient Map", "Grain",
  "Invert", "Black & White", "Color Balance",
  // Version 9 adds the three that sample neighbouring pixels.
  "Gaussian Blur", "Motion Blur", "Add Noise",
];
export const V9_ADJUSTMENTS = new Set(["Gaussian Blur", "Motion Blur", "Add Noise"]);

export const TEXT_FONT_SIZE = { min: 1, max: 2000 };
export const TEXT_TRACKING = { min: -100, max: 1000 };
export const TEXT_LEADING = { min: 0, max: 5000 };
export const TEXT_BOX_MIN = 16;
export const TEXT_MAX_UTF16 = 100_000;
export const TEXT_PADDING = 12;
export const TEXT_ALIGNMENTS = ["Left", "Center", "Right"];

// Ranges for every editable value, mirroring the Swift settings structs.
export const RANGES = {
  levels: { black: [0, 254], white: [1, 255], gamma: [0.1, 9.99], output: [0, 255] },
  exposure: { exposure: [-20, 20], offset: [-0.5, 0.5], gamma: [0.01, 9.99] },
  gradientMap: { color: [0, 1] },
  grain: { amount: [0, 100], size: [0.5, 20], roughness: [0, 100] },
  blackWhite: { weight: [-200, 300], tintHue: [0, 360], tintSaturation: [0, 100] },
  colorBalance: { shift: [-100, 100] },
  gaussianBlur: { radius: [0.1, 250] },
  motionBlur: { angle: [-90, 90], distance: [1, 2000] },
  addNoise: { amount: [0.1, 400] },
  hsv: { hue: [-360, 360], saturation: [-100, 100], lightness: [-100, 100] },
  brush: { diameter: [1, 2000], hardness: [0, 1], opacity: [0, 1], smoothing: [0, 100], blurRadius: [1, 250] },
  wand: { tolerance: [0, 255] },
  filters: {
    radius: [0.1, 250], angle: [-90, 90], distance: [1, 2000], amount: [0.1, 400],
    vignetteAmount: [0, 100], vignetteMidpoint: [0, 100], vignetteRoundness: [-100, 100],
    vignetteFeather: [0, 100], vignetteHighlights: [0, 100],
    bloomAmount: [0, 100], bloomRadius: [1, 150],
    tonalAmount: [0, 100], tonalRadius: [1, 100],
    tonalShadows: [-100, 100], tonalMidtones: [-100, 100], tonalHighlights: [-100, 100],
    distortion: [-100, 100],
    refineEdges: [0, 40], matteContrast: [0, 100], shiftEdge: [-10, 10],
  },
  transform: { rotation: [-360, 360] },
};

export const FILTER_KINDS = [
  "Gaussian Blur", "Motion Blur", "Add Noise", "Vignette", "Bloom / Glow", "Dither",
  "Tonal Contrast", "Lens Correction", "Camera Raw Filter",
  "Remove Background", "Content-Aware Fill",
];

export const TOOLS = [
  "move", "marquee", "lasso", "wand", "crop", "brush", "spotHealing",
  "cloneStamp", "blur", "gradient", "shape", "type", "eyedropper", "hand", "zoom", "idle",
];

export function clampRange(value, range, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], value));
}

export function isFiniteIn(value, range) {
  return Number.isFinite(value) && value >= range[0] && value <= range[1];
}

// ---- Validation, mirroring ProjectStore.validate ----

export function defaultLevelRange() {
  return { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 };
}

export function normalizeLevelRange(range) {
  const result = { ...range };
  result.black = clampRange(range.black, RANGES.levels.black, 0);
  result.white = clampRange(range.white, [result.black + 1, 255], 255);
  result.gamma = clampRange(range.gamma, RANGES.levels.gamma, 1);
  result.outputBlack = clampRange(range.outputBlack, RANGES.levels.output, 0);
  result.outputWhite = clampRange(range.outputWhite, RANGES.levels.output, 255);
  return result;
}

export function levelRangeApply(range, value) {
  const s = normalizeLevelRange(range);
  const input = Math.min(1, Math.max(0, (value * 255 - s.black) / (s.white - s.black)));
  return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
}

export function defaultLevelsSettings() {
  return {
    channel: "RGB",
    ranges: [defaultLevelRange(), defaultLevelRange(), defaultLevelRange(), defaultLevelRange()],
  };
}

export function defaultCurvePoint(x, y) { return { x, y }; }

export function defaultCurvesSettings() {
  const channel = [defaultCurvePoint(0, 0), defaultCurvePoint(255, 255)];
  return { channel: "RGB", channels: [channel.slice(), channel.slice(), channel.slice(), channel.slice()] };
}

export function monotoneCurveValue(points, x) {
  const i = Math.min(points.length - 2, Math.max(0, lastIndexAtOrBefore(points, x)));
  const d = points.slice(0, -1).map((p, j) => (points[j + 1].y - p.y) / (points[j + 1].x - p.x));
  const slope = (j) => {
    if (j <= 0) return d[0];
    if (j >= points.length - 1) return d[d.length - 1];
    if (d[j - 1] * d[j] <= 0) return 0;
    return 2 / (1 / d[j - 1] + 1 / d[j]);
  };
  const h = points[i + 1].x - points[i].x;
  const t = Math.min(1, Math.max(0, (x - points[i].x) / h));
  const y = (2 * t * t * t - 3 * t * t + 1) * points[i].y
    + (t * t * t - 2 * t * t + t) * h * slope(i)
    + (-2 * t * t * t + 3 * t * t) * points[i + 1].y
    + (t * t * t - t * t) * h * slope(i + 1);
  return Math.min(255, Math.max(0, y));
}

function lastIndexAtOrBefore(points, x) {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].x <= x) return i;
  }
  return 0;
}

export function defaultHSVSettings() {
  return {
    range: "Master", colorize: false, invertRange: false,
    adjustments: {}, bands: {},
  };
}

export function colorRangeDefaultBand(range) {
  const bands = {
    Master: [0, 0, 360, 360],
    Reds: [315, 345, 15, 45],
    Yellows: [15, 45, 75, 105],
    Greens: [75, 105, 135, 165],
    Cyans: [135, 165, 195, 225],
    Blues: [195, 225, 255, 285],
    Magentas: [255, 285, 315, 345],
  };
  const [falloffStart, rangeStart, rangeEnd, falloffEnd] = bands[range] || bands.Master;
  return { falloffStart, rangeStart, rangeEnd, falloffEnd };
}

export function hueBandWeight(band, hue) {
  const span = forwardDegrees(band.falloffStart, band.falloffEnd);
  if (span <= 0) return 1;
  const position = forwardDegrees(band.falloffStart, hue);
  if (position > span) return 0;
  const rampIn = forwardDegrees(band.falloffStart, band.rangeStart);
  const plateauEnd = forwardDegrees(band.falloffStart, band.rangeEnd);
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
  if (position <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - position) / rampOut : 1;
}

export function forwardDegrees(from, to) {
  const delta = (to - from) % 360;
  return delta < 0 ? delta + 360 : delta;
}

export function defaultAdjustment(kind) {
  const adjustment = {
    kind,
    hue: 0, saturation: 0, lightness: 0, colorize: false,
    hsvSettings: null, levels: defaultLevelsSettings(), curves: defaultCurvesSettings(),
    exposureSettings: null, gradientMapSettings: null, grainSettings: null,
    blackWhiteSettings: null, colorBalanceSettings: null,
    blurRadius: null, motionAngle: null, motionDistance: null,
    noiseAmount: null, noiseGaussian: null, noiseMonochromatic: null, noiseSeed: null,
  };
  return adjustment;
}

export function defaultExposureSettings() {
  return { exposure: 0, offset: 0, gamma: 1 };
}
export function defaultGradientMapSettings() {
  return { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false };
}
export function defaultGrainSettings() {
  return { amount: 25, size: 1.5, roughness: 50, seed: 0 };
}
export function defaultBlackWhiteSettings() {
  return {
    reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
    tint: false, tintHue: 40, tintSaturation: 20,
  };
}
export function defaultColorBalanceSettings() {
  return {
    shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0,
    midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
    highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
    preserveLuminosity: true,
  };
}
export function defaultFilterSettings() {
  return {
    radius: 1, angle: 0, distance: 10, amount: 10, gaussian: false, monochromatic: false,
    vignetteAmount: 35, vignetteColor: { red: 0, green: 0, blue: 0 },
    vignetteMidpoint: 50, vignetteRoundness: 100, vignetteFeather: 60, vignetteHighlights: 25,
    bloomAmount: 40, bloomRadius: 24,
    tonalAmount: 50, tonalRadius: 16, tonalShadows: 40, tonalMidtones: 60, tonalHighlights: 30,
    distortion: 0,
    curves: defaultCurvesSettings(), exposure: defaultExposureSettings(),
    gradientMap: defaultGradientMapSettings(), grain: defaultGrainSettings(),
    blackWhite: defaultBlackWhiteSettings(), colorBalance: defaultColorBalanceSettings(),
    dither: defaultDitherSettings(), cameraRaw: defaultCameraRawSettings(),
    backgroundQuality: "Basic", refineEdges: 12, matteContrast: 25, shiftEdge: 0,
  };
}
export function defaultDitherSettings() {
  return { amount: 50, type: "Floyd–Steinberg", paletteSize: 8 };
}
export function defaultCameraRawSettings() {
  return {
    temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
    whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0,
    vibrance: 0, saturation: 0,
    sharpenAmount: 0, sharpenRadius: 25, sharpenDetail: 25, sharpenMasking: 0,
    noiseLuminance: 0, noiseLuminanceDetail: 50, noiseLuminanceContrast: 0,
    noiseColor: 0, noiseColorDetail: 50, noiseColorSmoothness: 50,
    removeChromatic: false, distortion: 0,
    purpleAmount: 0, greenAmount: 0,
    vignetteAmount: 0, vignetteMidpoint: 50,
    toneCurve: defaultCurvesSettings(),
    redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0,
  };
}

export function defaultTextStyle() {
  return {
    content: "Text", fontName: "Helvetica", fontSize: 72,
    red: 0, green: 0, blue: 0, alignment: "Left", tracking: 0, leading: 0,
    boxSize: null, colorRuns: null, fontRuns: null,
  };
}

// ---- Manifest validation ----

export class ValidationError extends Error {}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new ValidationError("Manifest is not valid JSON");
  if (manifest.format !== PROJECT_FORMAT) throw new ValidationError("This is not a Compositor project manifest");
  const version = manifest.version;
  if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
    throw new ValidationError(`Unsupported project version ${version} (this port reads ${MIN_VERSION}-${MAX_VERSION})`);
  }
  const width = manifest.width, height = manifest.height;
  if (!isFiniteIn(width, [1, MAX_SIDE]) || !isFiniteIn(height, [1, MAX_SIDE])) {
    throw new ValidationError("Canvas dimensions are outside the supported limits");
  }
  const layers = manifest.layers;
  if (!Array.isArray(layers)) throw new ValidationError("Manifest has no layers array");
  if (layers.length > MAX_LAYERS) throw new ValidationError("Project exceeds the 10,000 layer limit");
  if (manifest.resolution !== undefined && manifest.resolution !== null
    && !isFiniteIn(manifest.resolution, [1, 9600])) {
    throw new ValidationError("Resolution is outside the supported 1–9600 ppi");
  }

  const ids = new Set();
  const groups = new Map();
  const versionRules = {
    parentID: 2, isGroup: 2, opacity: 3, blendMode: 3, maskFile: 4, maskEnabled: 4,
    maskSourceID: 5, guides: 8, adjustment: 7,
  };
  for (const layer of layers) {
    validateLayer(layer, manifest, ids, groups, versionRules);
  }
  if (manifest.guides !== undefined && manifest.guides !== null) {
    if (version < 8) throw new ValidationError("Files declaring versions 1–7 cannot contain guides");
    if (!Array.isArray(manifest.guides)) throw new ValidationError("Guides must be an array");
    if (manifest.guides.length > MAX_GUIDES) throw new ValidationError("More than 1,000 guides");
    for (const guide of manifest.guides) {
      if (!guide || typeof guide.id !== "string" || !guide.id) throw new ValidationError("A guide has no id");
      if (guide.axis !== "horizontal" && guide.axis !== "vertical") throw new ValidationError("Guide axis must be horizontal or vertical");
      if (!Number.isFinite(guide.position) || Math.abs(guide.position) > MAX_GUIDE_POSITION) {
        throw new ValidationError("Guide position is outside the supported range");
      }
    }
  }
  return manifest;
}

function validateLayer(layer, manifest, ids, groups, versionRules) {
  const version = manifest.version;
  if (!layer || typeof layer.id !== "string" || !layer.id) throw new ValidationError("A layer has no id");
  if (ids.has(layer.id)) throw new ValidationError(`Duplicate layer id ${layer.id}`);
  ids.add(layer.id);

  if (layer.transform) validateTransform(layer.transform);
  if (layer.isGroup !== undefined && version < versionRules.isGroup && layer.isGroup) {
    throw new ValidationError("Files declaring versions 1–1 cannot contain groups");
  }
  const isGroup = !!layer.isGroup;
  if (layer.parentID !== undefined && layer.parentID !== null) {
    if (version < versionRules.parentID) throw new ValidationError("Older versions cannot contain groups");
  }
  if (isGroup) {
    if (layer.imageFile) throw new ValidationError("A group cannot have an image file");
    groups.set(layer.id, layer);
  }
  if (layer.opacity !== undefined && layer.opacity !== null) {
    if (version < versionRules.opacity && !(layer.opacity === 1 && layer.blendMode === undefined)) {
      throw new ValidationError("Files declaring versions 1–2 cannot contain non-default appearance values");
    }
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      throw new ValidationError("Layer opacity must be between 0 and 1");
    }
  }
  if (layer.blendMode !== undefined && layer.blendMode !== null && layer.blendMode !== "Normal") {
    if (version < versionRules.blendMode) throw new ValidationError("Files declaring versions 1–2 cannot contain blend modes");
    if (!BLEND_MODES.includes(layer.blendMode)) throw new ValidationError(`Unknown blend mode ${layer.blendMode}`);
  }
  if (isGroup && version < 8 && layer.opacity !== undefined && layer.opacity !== 1) {
    throw new ValidationError("Files declaring versions 1–7 require folders at full opacity");
  }
  if (layer.maskFile) {
    if (isGroup && version < 6) throw new ValidationError("Files declaring versions 1–5 cannot give a group a mask");
    if (!isGroup && version < 4) throw new ValidationError("Files declaring versions 1–3 cannot contain mask metadata");
  }
  if (layer.maskSourceID) {
    if (version < 5) throw new ValidationError("Older versions cannot contain live masks");
    if (isGroup) throw new ValidationError("A group cannot be a clipping mask target with maskSourceID");
  }
  if (layer.adjustment) {
    if (version < 7) throw new ValidationError("Files declaring versions 1–6 cannot contain adjustment records");
    if (isGroup) throw new ValidationError("Adjustment layers cannot be groups");
    if (layer.text) throw new ValidationError("Adjustment layers cannot carry text");
    validateAdjustment(layer.adjustment, version);
  }
  if (layer.text) {
    validateTextStyle(layer.text);
  }
  if (layer.shape) {
    validateShape(layer.shape);
  }
}

export function validateTransform(transform) {
  if (!transform || typeof transform !== "object") throw new ValidationError("A layer has no transform");
  const { origin, size } = transform;
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new ValidationError("A transform has no origin");
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new ValidationError("A transform has no size");
  if (size.width < 0 || size.height < 0) throw new ValidationError("A transform size cannot be negative");
  if (Math.abs(size.width) > MAX_SIDE || Math.abs(size.height) > MAX_SIDE) throw new ValidationError("A layer exceeds the 30,000-pixel side limit");
  if (transform.rotation !== undefined && !Number.isFinite(transform.rotation)) throw new ValidationError("Rotation is not finite");
  for (const key of ["flipX", "flipY"]) {
    if (transform[key] !== undefined && typeof transform[key] !== "boolean") {
      throw new ValidationError(`Transform ${key} must be a boolean`);
    }
  }
  if (transform.sampling !== undefined && transform.sampling !== null && !SAMPLING_MODES.includes(transform.sampling)) {
    throw new ValidationError(`Unknown sampling mode ${transform.sampling}`);
  }
}

export function validateAdjustment(adjustment, version) {
  if (!adjustment || typeof adjustment !== "object" || typeof adjustment.kind !== "string") {
    throw new ValidationError("An adjustment record has no kind");
  }
  if (!ADJUSTMENT_KINDS.includes(adjustment.kind)) throw new ValidationError(`Unknown adjustment ${adjustment.kind}`);
  if (V9_ADJUSTMENTS.has(adjustment.kind) && version < 9) {
    throw new ValidationError("Files declaring versions 1–8 cannot contain these adjustment kinds");
  }
  for (const key of ["hue", "saturation", "lightness"]) {
    if (adjustment[key] !== undefined && adjustment[key] !== null
      && !isFiniteIn(adjustment[key], RANGES.hsv[key])) {
      throw new ValidationError(`Adjustment ${key} is outside its range`);
    }
  }
  if (adjustment.blurRadius !== undefined && adjustment.blurRadius !== null
    && !isFiniteIn(adjustment.blurRadius, RANGES.gaussianBlur.radius)) {
    throw new ValidationError("Gaussian Blur radius is outside 0.1–250");
  }
  if (adjustment.motionAngle !== undefined && adjustment.motionAngle !== null
    && !isFiniteIn(adjustment.motionAngle, RANGES.motionBlur.angle)) {
    throw new ValidationError("Motion Blur angle is outside −90–90");
  }
  if (adjustment.motionDistance !== undefined && adjustment.motionDistance !== null
    && !isFiniteIn(adjustment.motionDistance, RANGES.motionBlur.distance)) {
    throw new ValidationError("Motion Blur distance is outside 1–2000");
  }
  if (adjustment.noiseAmount !== undefined && adjustment.noiseAmount !== null
    && !isFiniteIn(adjustment.noiseAmount, RANGES.addNoise.amount)) {
    throw new ValidationError("Add Noise amount is outside 0.1–400");
  }
  if (adjustment.levels) {
    const ranges = adjustment.levels.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 4) throw new ValidationError("Levels needs four channel ranges");
  }
  if (adjustment.curves) {
    const channels = adjustment.curves.channels;
    if (!Array.isArray(channels) || channels.length !== 4) throw new ValidationError("Curves needs four channels");
    for (const points of channels) {
      if (!Array.isArray(points) || points.length < 2 || points.length > 32) {
        throw new ValidationError("A curve needs 2–32 points");
      }
      if (points[0].x !== 0 || points[points.length - 1].x !== 255) {
        throw new ValidationError("A curve must start at 0 and end at 255");
      }
      for (let i = 0; i < points.length; i += 1) {
        if (!Number.isFinite(points[i].x) || !Number.isFinite(points[i].y)
          || points[i].x < 0 || points[i].x > 255 || points[i].y < 0 || points[i].y > 255) {
          throw new ValidationError("A curve point is outside 0–255");
        }
        if (i > 0 && points[i].x <= points[i - 1].x) throw new ValidationError("Curve points must advance in x");
      }
    }
  }
  if (adjustment.exposureSettings) {
    const e = adjustment.exposureSettings;
    if (!isFiniteIn(e.exposure, RANGES.exposure.exposure) || !isFiniteIn(e.offset, RANGES.exposure.offset)
      || !isFiniteIn(e.gamma, RANGES.exposure.gamma)) {
      throw new ValidationError("Exposure settings are outside their ranges");
    }
  }
  if (adjustment.gradientMapSettings) {
    const g = adjustment.gradientMapSettings;
    for (const end of [g.shadows, g.highlights]) {
      for (const key of ["red", "green", "blue"]) {
        if (!isFiniteIn(end[key], [0, 1])) throw new ValidationError("Gradient Map colors are outside 0–1");
      }
    }
  }
  if (adjustment.grainSettings) {
    const g = adjustment.grainSettings;
    if (!isFiniteIn(g.amount, RANGES.grain.amount) || !isFiniteIn(g.size, RANGES.grain.size)
      || !isFiniteIn(g.roughness, RANGES.grain.roughness)) {
      throw new ValidationError("Grain settings are outside their ranges");
    }
  }
  if (adjustment.blackWhiteSettings) {
    const b = adjustment.blackWhiteSettings;
    for (const key of ["reds", "yellows", "greens", "cyans", "blues", "magentas"]) {
      if (!isFiniteIn(b[key], RANGES.blackWhite.weight)) throw new ValidationError("Black & White weights are outside −200–300");
    }
  }
  if (adjustment.colorBalanceSettings) {
    const c = adjustment.colorBalanceSettings;
    for (const key of Object.keys(c)) {
      if (key === "preserveLuminosity") continue;
      if (!isFiniteIn(c[key], RANGES.colorBalance.shift)) throw new ValidationError("Color Balance shifts are outside −100–100");
    }
  }
}

export function validateTextStyle(style) {
  if (!style || typeof style !== "object") throw new ValidationError("Text metadata is missing");
  if (typeof style.content !== "string" || style.content.length > TEXT_MAX_UTF16) {
    throw new ValidationError("Text content is missing or too long");
  }
  if (!isFiniteIn(style.fontSize, [TEXT_FONT_SIZE.min, TEXT_FONT_SIZE.max])) throw new ValidationError("Font size is outside 1–2000");
  for (const key of ["red", "green", "blue"]) {
    if (!isFiniteIn(style[key], [0, 1])) throw new ValidationError("Text color is outside 0–1");
  }
  if (!isFiniteIn(style.tracking, [TEXT_TRACKING.min, TEXT_TRACKING.max])) throw new ValidationError("Tracking is outside −100–1000");
  if (!isFiniteIn(style.leading, [TEXT_LEADING.min, TEXT_LEADING.max])) throw new ValidationError("Leading is outside 0–5000");
  if (style.boxSize !== undefined && style.boxSize !== null) {
    if (!Number.isFinite(style.boxSize.width) || !Number.isFinite(style.boxSize.height)
      || style.boxSize.width < TEXT_BOX_MIN || style.boxSize.height < TEXT_BOX_MIN
      || style.boxSize.width > MAX_SIDE || style.boxSize.height > MAX_SIDE
      || style.boxSize.width * style.boxSize.height > MAX_SURFACE_PIXELS) {
      throw new ValidationError("Text box exceeds the supported limits");
    }
  }
  validateRuns(style.colorRuns, (run) => ["red", "green", "blue"].every((k) => isFiniteIn(run[k], [0, 1])));
  validateRuns(style.fontRuns, (run) => typeof run.fontName === "string" && run.fontName.length > 0 && run.fontName.length <= 200);
}

function validateRuns(runs, checkValue) {
  if (runs === undefined || runs === null) return;
  if (!Array.isArray(runs) || runs.length === 0) throw new ValidationError("Runs must be a non-empty array");
  let end = 0;
  for (const run of runs) {
    if (!Number.isInteger(run.location) || run.location < end || !Number.isInteger(run.length) || run.length <= 0) {
      throw new ValidationError("Text runs must be sorted and non-overlapping");
    }
    if (!checkValue(run)) throw new ValidationError("A text run value is outside its range");
    end = run.location + run.length;
  }
}

export function validateShape(shape) {
  if (!shape || typeof shape !== "object") throw new ValidationError("Shape metadata is missing");
  if (!["Rectangle", "Ellipse", "Line"].includes(shape.kind)) throw new ValidationError(`Unknown shape kind ${shape.kind}`);
  for (const key of ["red", "green", "blue"]) {
    if (!isFiniteIn(shape[key], [0, 1])) throw new ValidationError("Shape color is outside 0–1");
  }
  if (shape.cornerRadius !== undefined && !Number.isFinite(shape.cornerRadius)) {
    throw new ValidationError("Corner radius is not finite");
  }
  if (shape.kind === "Line") {
    if (!Number.isFinite(shape.lineWidth) || shape.lineWidth <= 0) throw new ValidationError("A line needs a positive width");
    if (!Number.isFinite(shape.start?.x) || !Number.isFinite(shape.start?.y)
      || !Number.isFinite(shape.end?.x) || !Number.isFinite(shape.end?.y)) {
      throw new ValidationError("A line needs start and end points");
    }
  }
}

// Version bumping: an edit that introduces a field must raise the manifest version.
export function versionNeededFor(manifest, change) {
  let version = manifest.version;
  const bump = (minimum) => { if (version < minimum) version = minimum; };
  if (change.groupFields) bump(2);
  if (change.appearance) bump(3);
  if (change.layerMask) bump(4);
  if (change.liveMask) bump(5);
  if (change.groupMask) bump(6);
  if (change.adjustment) bump(7);
  if (change.adjustmentKind && V9_ADJUSTMENTS.has(change.adjustmentKind)) bump(9);
  if (change.folderOpacity) bump(8);
  if (change.guides) bump(8);
  if (change.colorRuns) bump(10);
  if (change.fontRuns) bump(11);
  return version;
}
