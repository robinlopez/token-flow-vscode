// Port of `TokenValueIndex.kt`. Builds a normalised `value → tokens` map
// so that hardcoded-value diagnostics can look up "does any token resolve
// to this literal?" in O(1).
//
// Normalisation rules (per category):
//   - COLOR  : canonical lowercase `#rrggbb[aa]` — `#FFF`, `#FfFfFf`,
//              `rgb(255,255,255)`, `white` all collide on `#ffffff`.
//   - SPACING / RADIUS / TYPOGRAPHY : px / rem / em are converted to a
//              canonical px value (16-px root font-size). Other units
//              (%, vh, vw, …) keep their raw lowercase form.
//   - Anything else : lowercased trim only.

import { DesignToken, TokenCategory } from "../model/designToken";
import { parseColor, rgbaToCacheKey } from "../ui/colorParser";

const ROOT_FONT_SIZE_PX = 16;
const LENGTH_REGEX = /^(-?\d*\.?\d+)(px|rem|em)$/;

export class TokenValueIndex {
  private readonly byNormalized = new Map<string, DesignToken[]>();

  constructor(tokens: readonly DesignToken[]) {
    for (const token of tokens) {
      const key = normalize(token.resolvedValue, token.category);
      if (!key) continue;
      const list = this.byNormalized.get(key) ?? [];
      list.push(token);
      this.byNormalized.set(key, list);
    }
  }

  /** Returns every token whose normalised value matches [literal] under [category]. */
  lookup(literal: string, category: TokenCategory): readonly DesignToken[] {
    const key = normalize(literal, category);
    if (!key) return [];
    return this.byNormalized.get(key) ?? [];
  }

  /**
   * Cross-category lookup: when the inspection only knows the literal's
   * kind (`COLOR`/`LENGTH`/`DURATION`), it can ask for matches across
   * every plausible token category. Cheap because the map is already
   * built — we just probe each candidate category and concat.
   */
  lookupAcross(
    literal: string,
    categories: readonly TokenCategory[],
  ): DesignToken[] {
    const seen = new Set<string>();
    const out: DesignToken[] = [];
    for (const c of categories) {
      for (const t of this.lookup(literal, c)) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }
}

/**
 * Normalises [value] for token-lookup purposes. Returns `null` when the
 * value is empty or unparseable under the given category — that signals
 * the inspection to skip the literal entirely.
 */
export function normalize(
  value: string,
  category: TokenCategory,
): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  switch (category) {
    case "COLOR":
      return normalizeColor(v);
    case "SPACING":
    case "RADIUS":
    case "TYPOGRAPHY":
      return normalizeLength(v) ?? v;
    default:
      return v;
  }
}

function normalizeColor(value: string): string {
  const rgba = parseColor(value);
  if (!rgba) return value;
  const hex = rgbaToCacheKey(rgba); //                            `rrggbbaa`
  return rgba.a === 255 ? "#" + hex.substring(0, 6) : "#" + hex;
}

function normalizeLength(value: string): string | null {
  const m = LENGTH_REGEX.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = m[2];
  const px = unit === "px" ? n : n * ROOT_FONT_SIZE_PX;
  return formatPx(px) + "px";
}

function formatPx(d: number): string {
  // Sub-pixel precision (0.5, 1.25) preserved; trailing zeros stripped.
  if (Number.isInteger(d)) return d.toString();
  return d.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
