// sRGB transfer functions and HSL conversions, ported from the Swift/C kernels.

export function srgbToLinear(encoded) {
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(linear) {
  if (linear <= 0) return 0;
  if (linear >= 1) return 1;
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

export function rec709(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function rgbToHSL(r, g, b) {
  const high = Math.max(r, g, b), low = Math.min(r, g, b);
  const lightness = (high + low) / 2;
  const delta = high - low;
  if (delta <= 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (high === r) hue = (g - b) / delta;
  else if (high === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: Math.min(1, saturation), l: lightness };
}

export function hslToRGB(hue, saturation, lightness) {
  if (saturation <= 0) return { r: lightness, g: lightness, b: lightness };
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  let r, g, b;
  switch (Math.floor(sector)) {
    case 0: r = chroma; g = second; b = 0; break;
    case 1: r = second; g = chroma; b = 0; break;
    case 2: r = 0; g = chroma; b = second; break;
    case 3: r = 0; g = second; b = chroma; break;
    case 4: r = second; g = 0; b = chroma; break;
    default: r = chroma; g = 0; b = second; break;
  }
  return {
    r: Math.min(1, Math.max(0, r + base)),
    g: Math.min(1, Math.max(0, g + base)),
    b: Math.min(1, Math.max(0, b + base)),
  };
}

// Photoshop's multiplicative saturation: below 0 scales toward gray, above 0
// divides by what's left, so +50 doubles it and +100 saturates fully.
export function adjustedSaturation(saturation, amount) {
  const a = Math.min(1, Math.max(-1, amount / 100));
  if (a <= 0) return Math.max(0, saturation * (1 + a));
  if (a >= 1) return saturation > 0 ? 1 : 0;
  return Math.min(1, saturation / (1 - a));
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function rgbToHex({ red, green, blue }) {
  const channel = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${channel(red ?? 0)}${channel(green ?? 0)}${channel(blue ?? 0)}`;
}

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { red: 0, green: 0, blue: 0 };
  const value = parseInt(match[1], 16);
  return { red: ((value >> 16) & 255) / 255, green: ((value >> 8) & 255) / 255, blue: (value & 255) / 255 };
}
