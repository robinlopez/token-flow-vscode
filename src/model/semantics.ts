// ─── Token Semantics ────────────────────────────────────────────────────────
//
// Multi-criteria scoring for design-token suggestions. Direct port of the
// IntelliJ `SuggestionEngine` (Kotlin) — `SuggestionEngine.kt` is the
// source of truth per SHARED_LOGIC.md. Any divergence from the Kotlin
// side must land here in the same PR.
//
// Scoring axes (lower = better):
//   1. Category match               (-100)
//   2. Cross-family demotion        (+200)   ← Kotlin parity
//   3. Role match                   (-80)
//   4. Role conflict                (+60)
//   5. Tier weight                  (-30 sem / -10 comp / +40 prim)
//   6. Exact vs fuzzy/helper        (+5)
//   7. Name length tiebreaker       (len / 4)
//
// Two name-based filters reject obviously-wrong candidates before they
// hit the score:
//   • isFamilyMismatch — categorical (TYPOGRAPHY token on a width property).
//   • isNameFamilyMismatch — name-based (a token named `--size-typography-…`
//     is metric by category but semantically belongs to a type ramp).

import { DesignToken, TokenCategory } from "./designToken";

// ─── Token Tiers ─────────────────────────────────────────────────────────────

export const enum TokenTier {
  SEMANTIC = 0,
  COMPONENT = 1,
  PRIMITIVE = 2,
}

/**
 * Hyphen-or-dot delimited leading segments that signal a PRIMITIVE token.
 * Verbatim port of `SuggestionEngine.PRIMITIVE_PREFIXES`.
 */
const PRIMITIVE_HEADS = new Set([
  "units", "unit", "palette", "base", "primitive", "primitives",
  "core", "scale", "raw",
]);

/**
 * Same shape for COMPONENT — `token-` / `token.` is handled separately
 * (Kotlin: `n.startsWith("token-") || n.startsWith("token.")`) so we
 * keep that fork below in `extractTier`.
 */
const COMPONENT_HEADS = new Set([
  "comp", "component", "components",
]);

/**
 * Strip the sigil that prefixes CSS custom properties (`--`) and SCSS
 * variables (`$`). The previous regex `/^(--|\\$)/` had an escaping
 * bug (the literal `\\$` only matches a backslash, not `$`), so SCSS
 * names like `$units-xl` were never normalised — tier classification
 * silently mis-scored every SCSS token. Use a string-prefix check to
 * keep the intent obvious.
 */
function normaliseName(name: string): string {
  let n = name.toLowerCase();
  if (n.startsWith("--")) n = n.substring(2);
  else if (n.startsWith("$")) n = n.substring(1);
  return n;
}

/** Extract the structural tier of a token from its name. */
export function extractTier(tokenName: string): TokenTier {
  const n = normaliseName(tokenName);
  // CSS / SCSS use hyphens (`units-xl`); JS object paths use dots
  // (`primitive.units.xl`). Splitting on both gives the same leading
  // segment for both flavours so `units.sm` doesn't fall through to
  // SEMANTIC anymore.
  const head = n.split(/[-.]/, 1)[0];
  if (PRIMITIVE_HEADS.has(head)) return TokenTier.PRIMITIVE;
  if (n.startsWith("token-") || n.startsWith("token.") || COMPONENT_HEADS.has(head)) {
    return TokenTier.COMPONENT;
  }
  return TokenTier.SEMANTIC;
}

// ─── Token Roles ─────────────────────────────────────────────────────────────

export const enum TokenRole {
  SURFACE = "surface",
  CONTENT = "content",
  STROKE = "stroke",
  EFFECT = "effect",
}

/**
 * Segment-level role markers. Verbatim port of `SuggestionEngine.roleOf`
 * — any divergence here means the two plugins ranks differently and
 * SHARED_LOGIC.md is no longer authoritative.
 */
const ROLE_BY_SEGMENT: Record<string, TokenRole> = {
  // SURFACE
  surface: TokenRole.SURFACE,
  background: TokenRole.SURFACE,
  bg: TokenRole.SURFACE,
  fill: TokenRole.SURFACE,
  canvas: TokenRole.SURFACE,
  // CONTENT
  content: TokenRole.CONTENT,
  text: TokenRole.CONTENT,
  foreground: TokenRole.CONTENT,
  fg: TokenRole.CONTENT,
  label: TokenRole.CONTENT,
  icon: TokenRole.CONTENT,
  // STROKE
  stroke: TokenRole.STROKE,
  border: TokenRole.STROKE,
  outline: TokenRole.STROKE,
  divider: TokenRole.STROKE,
  // EFFECT
  shadow: TokenRole.EFFECT,
  focus: TokenRole.EFFECT,
  effect: TokenRole.EFFECT,
  effects: TokenRole.EFFECT,
  glow: TokenRole.EFFECT,
};

/** Extract the semantic role from a token name, or `null` if undetermined. */
export function extractRole(tokenName: string): TokenRole | null {
  const n = normaliseName(tokenName);
  for (const seg of n.split(/[-.]/)) {
    const role = ROLE_BY_SEGMENT[seg];
    if (role !== undefined) return role;
  }
  return null;
}

// ─── CSS Property → Expected Role ────────────────────────────────────────────

/**
 * Maps a CSS property name to the token role we'd expect to see there.
 * VSCode-specific helper — IntelliJ derives this at the inspection call
 * site. Returning null lets the role axis stay neutral when the
 * property is not colour-bearing.
 */
export function getExpectedRoleForProperty(cssProperty: string): TokenRole | null {
  const p = cssProperty.toLowerCase().trim();
  if (
    p === "background" ||
    p === "background-color" ||
    p === "fill" ||
    p === "accent-color"
  ) {
    return TokenRole.SURFACE;
  }
  if (
    p === "color" ||
    p === "caret-color" ||
    p === "text-decoration-color" ||
    p === "-webkit-text-fill-color"
  ) {
    return TokenRole.CONTENT;
  }
  if (
    p === "border-color" ||
    p === "border-top-color" ||
    p === "border-right-color" ||
    p === "border-bottom-color" ||
    p === "border-left-color" ||
    p === "border-inline-color" ||
    p === "border-block-color" ||
    p === "outline-color" ||
    p === "stroke" ||
    p === "column-rule-color"
  ) {
    return TokenRole.STROKE;
  }
  if (p === "box-shadow" || p === "text-shadow" || p === "filter" || p === "drop-shadow") {
    return TokenRole.EFFECT;
  }
  return null;
}

// ─── Cross-family rules ─────────────────────────────────────────────────────

/**
 * Compatible length-bearing categories that can substitute for one another.
 * Design systems regularly reuse the same scale across spacing, sizing
 * and small radii. TYPOGRAPHY and BORDER each stand alone outside this
 * pool — see `isFamilyMismatch`.
 */
const METRIC_INTERCHANGEABLE: ReadonlySet<TokenCategory> = new Set<TokenCategory>([
  "SPACING", "SIZING", "RADIUS",
]);

/**
 * Categories whose surrounding property expects a frame/distance value.
 * When the expected family is one of these, name-based typography
 * markers in a candidate's name are a hard reject (see
 * `isNameFamilyMismatch`).
 */
const METRIC_FRAME: ReadonlySet<TokenCategory> = new Set<TokenCategory>([
  "SPACING", "SIZING", "RADIUS", "BORDER", "LAYOUT",
]);

/**
 * Hyphen-and-dot delimited segments that strongly signal a typography
 * ramp. A SIZING-categorised token named `--size-typography-title-md`
 * is still semantically a font-size; it has no business surfacing on
 * `width: 20px`.
 *
 * Word-boundary lookarounds prevent partial-word collisions (`type`
 * inside `typography` leaking back).
 */
const TYPO_NAME_SEGMENT_RE =
  /(?<![a-z])(?:typography|font|text|weight|leading|letter|family|tracking|kerning|decoration|title|heading|caption|paragraph)(?![a-z])/;

export function isFamilyMismatch(
  expected: TokenCategory,
  actual: TokenCategory,
): boolean {
  if (expected === actual) return false;
  if (METRIC_INTERCHANGEABLE.has(expected) && METRIC_INTERCHANGEABLE.has(actual)) {
    return false;
  }
  return true;
}

export function isNameFamilyMismatch(
  expected: TokenCategory,
  tokenName: string,
): boolean {
  if (!METRIC_FRAME.has(expected)) return false;
  return TYPO_NAME_SEGMENT_RE.test(normaliseName(tokenName));
}

// ─── Score Context ────────────────────────────────────────────────────────────

export interface ScoreContext {
  expectedCategory?: TokenCategory | null;
  expectedRole?: TokenRole | null;
  /** True when the value match was approximate (RGB distance > 0, helper-derived). */
  isFuzzy?: boolean;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Computes a recommendation score for a candidate `DesignToken`.
 * **Lower score = better suggestion.** Mirrors `SuggestionEngine.score`.
 */
export function scoreCandidate(token: DesignToken, ctx: ScoreContext): number {
  let n = 0;

  // 1. Category alignment.
  if (ctx.expectedCategory && token.category === ctx.expectedCategory) {
    n -= 100;
  }

  // 1b. Cross-family demotion. A wrong-family token only surfaces as a
  //     last-resort fuzzy hint and never beats a strict in-family
  //     candidate — see Kotlin parity comment.
  if (
    ctx.expectedCategory != null &&
    token.category !== ctx.expectedCategory &&
    isFamilyMismatch(ctx.expectedCategory, token.category)
  ) {
    n += 200;
  }

  // 2. Role alignment.
  if (ctx.expectedRole != null) {
    const role = extractRole(token.name);
    if (role === ctx.expectedRole) n -= 80;
    else if (role !== null) n += 60;
    // unknown role → neutral
  }

  // 3. Tier weight.
  const tier = extractTier(token.name);
  if (tier === TokenTier.SEMANTIC) n -= 30;
  else if (tier === TokenTier.COMPONENT) n -= 10;
  else n += 40;

  // 4. Fuzzy / helper-derived penalty.
  if (ctx.isFuzzy) n += 5;

  // 5. Name length tiebreaker.
  n += token.name.length / 4;

  return n;
}

/**
 * Sort candidates by their semantic score ascending (best first).
 * Pure — returns a new array. Caller is responsible for any post-filter
 * (e.g. exclude `external` tokens).
 */
export function sortCandidates(
  tokens: readonly DesignToken[],
  ctx: ScoreContext,
): DesignToken[] {
  return tokens
    .slice()
    .sort((a, b) => scoreCandidate(a, ctx) - scoreCandidate(b, ctx));
}

/**
 * Encodes a numeric score into a fixed-width sort string suitable for
 * `vscode.CompletionItem.sortText` (which uses lexicographic ordering).
 * Scores clamp to [-999, 999] then shift to [0, 1998] and zero-pad to 4
 * chars so the sort is stable across VSCode's string comparator.
 */
export function scoreToSortText(score: number): string {
  const shifted = Math.max(0, Math.min(1998, Math.round(score) + 999));
  return shifted.toString().padStart(4, "0");
}
