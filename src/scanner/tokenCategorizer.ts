// Mirror of `TokenCategorizer.kt`. Pure name+value heuristics — no I/O,
// no VSCode API. Keep ordering identical to the Kotlin side so a given
// (name, value) pair always lands in the same bucket on both plugins.

import { TokenCategory } from "../model/designToken";

const COLOR_REGEX =
  /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(.*\))\s*$/;

const NAMED_COLORS = new Set([
  "transparent",
  "currentcolor",
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "gray",
  "grey",
]);

const LENGTH_REGEX = /^-?\d*\.?\d+(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\s*$/;
const DURATION_REGEX = /^-?\d*\.?\d+(ms|s)\s*$/;
const SHADOW_HINT = /\d+(px|rem|em).*\d+(px|rem|em)/;

export function categorize(name: string, resolvedValue: string): TokenCategory {
  // Strip leading `--` or `$` so name-hint heuristics work uniformly on
  // both kinds. Lowercase once up front for `contains` checks.
  const n = name.toLowerCase().replace(/^[-$]+/, "");
  const v = resolvedValue.trim();

  const nameHit = nameHints(n);

  // Stroke disambiguation: "stroke" usually means COLOR in Figma, but
  // when its value is a length (e.g. 1px), it's a BORDER width. Same
  // override the Kotlin side applies — keep both sides in lockstep so
  // mixed projects don't see split categorisation across plugins.
  if (
    nameHit === "COLOR" &&
    contains(n, "stroke", "border") &&
    LENGTH_REGEX.test(v)
  ) {
    return "BORDER";
  }

  if (nameHit) return nameHit;
  return valueHints(v) ?? "OTHER";
}

/**
 * Name-based heuristics, ordered by specificity:
 *   1. High-priority composites — multi-word patterns that would
 *      otherwise collide with their constituent root words
 *      (`border-color` → COLOR, but `border-width` → BORDER).
 *   2. Specific/restricted categories — Z_INDEX, OPACITY, ICON.
 *   3. General categories — broad keyword buckets.
 *
 * Order matters: each `if` short-circuits, so a name matching both
 * `border-width` and `border` lands on BORDER (specific) instead of
 * COLOR (general "border" keyword).
 */
function nameHints(name: string): TokenCategory | null {
  // (1) High-priority composites.
  if (contains(name, "border-color")) return "COLOR";
  if (contains(name, "border-width", "border-style", "stroke-width")) {
    return "BORDER";
  }
  if (contains(name, "box-shadow", "drop-shadow")) return "SHADOW";
  if (contains(name, "line-height")) return "TYPOGRAPHY";
  if (contains(name, "min-width", "max-width")) return "SIZING";

  // (2) Specific / restricted categories.
  if (
    contains(name, "z-index", "zindex", "layer", "depth", "elevation")
  ) {
    return "Z_INDEX";
  }
  if (contains(name, "opacity", "alpha")) return "OPACITY";
  if (contains(name, "icon", "glyph")) return "ICON";

  // (3) General categories.
  if (
    contains(
      name,
      "color",
      "colour",
      "bg",
      "background",
      "fill",
      "stroke",
      "surface",
      "gradient",
      "tint",
      "shade",
    )
  ) {
    return "COLOR";
  }
  if (
    contains(
      name,
      "font",
      "text",
      "type",
      "weight",
      "leading",
      "letter",
      "family",
      "tracking",
      "kerning",
      "decoration",
    )
  ) {
    return "TYPOGRAPHY";
  }
  if (contains(name, "shadow")) return "SHADOW";
  if (contains(name, "radius", "rounded")) return "RADIUS";
  if (
    contains(
      name,
      "duration",
      "transition",
      "delay",
      "ease",
      "motion",
      "animation",
      "timing",
      "speed",
    )
  ) {
    return "DURATION";
  }
  if (contains(name, "effect", "focus", "blur", "outline")) return "EFFECTS";
  if (
    contains(
      name,
      "grid",
      "column",
      "row",
      "breakpoint",
      "media",
      "screen",
      "layout",
      "viewport",
      "container",
    )
  ) {
    return "LAYOUT";
  }
  if (
    contains(name, "size", "width", "height", "sizing", "dimension", "scale", "ratio")
  ) {
    return "SIZING";
  }
  if (
    contains(
      name,
      "space",
      "spacing",
      "gap",
      "margin",
      "padding",
      "inset",
      "top",
      "bottom",
      "left",
      "right",
      "position",
    )
  ) {
    return "SPACING";
  }
  return null;
}

function valueHints(value: string): TokenCategory | null {
  if (COLOR_REGEX.test(value)) return "COLOR";
  if (NAMED_COLORS.has(value.toLowerCase())) return "COLOR";
  if (DURATION_REGEX.test(value)) return "DURATION";
  if (SHADOW_HINT.test(value) && value.includes(",")) return "SHADOW";
  if (LENGTH_REGEX.test(value)) return "SPACING";
  // Bare integer → likely a z-index. Mirrors the Kotlin
  // `value.toIntOrNull() != null` last-ditch heuristic.
  if (/^-?\d+$/.test(value)) return "Z_INDEX";
  return null;
}

function contains(haystack: string, ...needles: string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}
