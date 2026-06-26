// TypeScript port of `ColorConversions.kt` — turns a parsed colour into
// the four CSS string formats Token Flow offers in the "Copy Token Value"
// dropdown (HEX / RGB / HSL / OKLCH).
//
// Input is the canonical `RGBA` produced by `colorParser.ts` (r,g,b in
// 0..255, a in 0..255 where 255 = opaque). Output is always a CSS string.
//
// Locale safety: unlike Java's locale-sensitive `String.format`, JS
// `Number.toFixed`/`toString` always emit `.` as the decimal separator —
// so no explicit locale guard is needed. The `trim` helper is centralised
// so that rule stays obvious and every formatter rounds the same way.

import { RGBA } from "./colorParser";

export type ColorFormat = "HEX" | "RGB" | "HSL" | "OKLCH";

/** Display + iteration order for the dropdown's colour alternates. */
export const COLOR_FORMATS: readonly ColorFormat[] = [
  "HEX",
  "RGB",
  "HSL",
  "OKLCH",
];

/** Round to [dp] decimals, then drop trailing zeros (`0.50` → `0.5`). */
const trim = (v: number, dp: number): string =>
  parseFloat(v.toFixed(dp)).toString();

/** Alpha as a 0..1 float (the canonical RGBA stores it as 0..255). */
const alpha01 = (a: number): number => a / 255;

const isOpaque = (a: number): boolean => a >= 255;

export function toFormat(color: RGBA, fmt: ColorFormat): string {
  switch (fmt) {
    case "HEX":
      return toHex(color);
    case "RGB":
      return toRgb(color);
    case "HSL":
      return toHsl(color);
    case "OKLCH":
      return toOklch(color);
  }
}

export function toHex({ r, g, b, a }: RGBA): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return isOpaque(a) ? base : base + h(a);
}

export function toRgb({ r, g, b, a }: RGBA): string {
  return isOpaque(a)
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${trim(alpha01(a), 2)})`;
}

export function toHsl({ r, g, b, a }: RGBA): string {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
    }
    h *= 60;
  }
  const H = Math.round(h),
    S = Math.round(s * 100),
    L = Math.round(l * 100);
  return isOpaque(a)
    ? `hsl(${H}deg ${S}% ${L}%)`
    : `hsla(${H}deg ${S}% ${L}% / ${trim(alpha01(a), 2)})`;
}

// Björn Ottosson's sRGB → OKLab → OKLCH transform.
export function toOklch({ r, g, b, a }: RGBA): string {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  const l_ = Math.cbrt(l),
    m_ = Math.cbrt(m),
    s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const Bc = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.sqrt(A * A + Bc * Bc);
  let H = (Math.atan2(Bc, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  const core = `oklch(${trim(L, 3)} ${trim(C, 3)} ${trim(H, 1)}deg`;
  return isOpaque(a) ? `${core})` : `${core} / ${trim(alpha01(a), 2)})`;
}

/**
 * Detects the source format of a raw colour string so the dropdown can
 * skip offering the format the value is already in. Returns `null` for
 * named colours (`red`, `transparent`) — those have no canonical source
 * format, so the dropdown offers all four.
 */
export function detectFormat(raw: string): ColorFormat | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("#")) return "HEX";
  if (v.startsWith("oklch")) return "OKLCH";
  if (v.startsWith("hsl")) return "HSL";
  if (v.startsWith("rgb")) return "RGB";
  return null;
}
