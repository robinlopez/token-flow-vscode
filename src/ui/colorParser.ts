// Port of `ColorParser.kt`. Accepts the full set of CSS-flavoured color
// literals we ever index — hex (#rgb / #rgba / #rrggbb / #rrggbbaa), rgb()
// / rgba(), hsl() / hsla() (with optional `deg`, comma or space separator,
// `/` alpha syntax), and the basic named-color subset. Returns `null` for
// anything else so callers can fall back to a non-color rendering.
//
// Output is always opaque-RGBA tuples in 0..255 so downstream code (the
// swatch SVG generator) only deals with one canonical representation.

export interface RGBA {
  readonly r: number; // 0..255
  readonly g: number;
  readonly b: number;
  readonly a: number; // 0..255 (255 = opaque)
}

const HEX = /^#([0-9a-fA-F]{3,8})$/;
// rgb/rgba: separator can be `,`, `, ` or ` `; alpha can be after `,` or `/`.
const RGB = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$/;
// hsl/hsla: hue with optional `deg`, S+L as percent, alpha as in rgb.
const HSL = /^hsla?\(\s*([0-9.]+)(?:deg)?\s*[, ]\s*([0-9.]+)%\s*[, ]\s*([0-9.]+)%\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$/;

const NAMED: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  currentcolor: { r: 128, g: 128, b: 128, a: 255 }, // best-effort placeholder
  black: { r: 0, g: 0, b: 0, a: 255 },
  white: { r: 255, g: 255, b: 255, a: 255 },
  red: { r: 255, g: 0, b: 0, a: 255 },
  green: { r: 0, g: 128, b: 0, a: 255 },
  blue: { r: 0, g: 0, b: 255, a: 255 },
  yellow: { r: 255, g: 255, b: 0, a: 255 },
  orange: { r: 255, g: 165, b: 0, a: 255 },
  purple: { r: 128, g: 0, b: 128, a: 255 },
  pink: { r: 255, g: 192, b: 203, a: 255 },
  gray: { r: 128, g: 128, b: 128, a: 255 },
  grey: { r: 128, g: 128, b: 128, a: 255 },
};

export function parseColor(value: string): RGBA | null {
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];

  const hex = HEX.exec(v);
  if (hex) return parseHex(hex[1]);

  const rgb = RGB.exec(v);
  if (rgb) return parseRgb(rgb);

  const hsl = HSL.exec(v);
  if (hsl) return parseHsl(hsl);

  return null;
}

/** Canonical 8-char hex string (`rrggbbaa`, lowercase) — used as a stable cache key. */
export function rgbaToCacheKey(c: RGBA): string {
  const h2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return h2(c.r) + h2(c.g) + h2(c.b) + h2(c.a);
}

// ─── Internals ────────────────────────────────────────────────────────────

function parseHex(h: string): RGBA | null {
  // Each char in a 3- or 4-digit hex is duplicated to widen to 8 bits
  // (the `* 17` shortcut: `0x_ * 0x11 == 0x__`).
  if (h.length === 3) {
    return {
      r: parseInt(h[0], 16) * 17,
      g: parseInt(h[1], 16) * 17,
      b: parseInt(h[2], 16) * 17,
      a: 255,
    };
  }
  if (h.length === 4) {
    return {
      r: parseInt(h[0], 16) * 17,
      g: parseInt(h[1], 16) * 17,
      b: parseInt(h[2], 16) * 17,
      a: parseInt(h[3], 16) * 17,
    };
  }
  if (h.length === 6) {
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
      a: 255,
    };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
      a: parseInt(h.substring(6, 8), 16),
    };
  }
  return null;
}

function parseRgb(m: RegExpExecArray): RGBA | null {
  const r = clamp255(parseInt(m[1], 10));
  const g = clamp255(parseInt(m[2], 10));
  const b = clamp255(parseInt(m[3], 10));
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b, a: parseAlpha(m[4]) };
}

function parseHsl(m: RegExpExecArray): RGBA | null {
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  if ([h, s, l].some(Number.isNaN)) return null;
  const rgb = hslToRgb(h, s, l);
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: parseAlpha(m[4]) };
}

function parseAlpha(raw: string | undefined): number {
  if (!raw) return 255;
  const v = raw.endsWith("%")
    ? parseFloat(raw.slice(0, -1)) / 100
    : parseFloat(raw);
  if (Number.isNaN(v)) return 255;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return NaN;
  return Math.max(0, Math.min(255, n));
}

/**
 * HSL → RGB. Inputs are 0..1 each. Returns three 0..255 integers.
 * Direct port of the IntelliJ `hslToRgb` companion.
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

function hueToRgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
