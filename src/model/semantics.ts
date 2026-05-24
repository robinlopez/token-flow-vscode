// ─── Token Semantics ────────────────────────────────────────────────────────
//
// Provides multi-criteria scoring for design-token suggestions, replacing the
// naive name-length tiebreaker with a proper semantic hierarchy:
//
//   1. Category match   (does the token's category fit the literal kind?)
//   2. Role match       (does the token's semantic role fit the CSS property?)
//   3. Tier weight      (Semantic > Component >> Primitive)
//   4. Exact vs Fuzzy   (small penalty for approximate color matches)
//   5. Name length      (tiebreaker only — can no longer override tiers)
//
// Designed to be used by HardcodedDiagnostics, CompletionProvider, and any
// place that sorts candidate design tokens for a given literal + CSS context.

import { DesignToken, TokenCategory } from "./designToken";

// ─── Token Tiers ─────────────────────────────────────────────────────────────

/**
 * The "level" of a token in the design-token hierarchy.
 *
 * SEMANTIC   — meaningful, context-aware aliases  (spacing-xl, color-surface-default)
 * COMPONENT  — component-scoped aliases           (token-button-background, comp-card-radius)
 * PRIMITIVE  — raw design primitives              (palette-blue-500, units-32)
 *
 * Lower enum value = preferred.
 */
export const enum TokenTier {
  SEMANTIC = 0,
  COMPONENT = 1,
  PRIMITIVE = 2,
}

/**
 * Prefixes that identify PRIMITIVE tokens (raw scale values, not contextual).
 * Everything else is SEMANTIC unless it matches a COMPONENT prefix.
 */
const PRIMITIVE_PREFIXES = [
  "units-",
  "palette-",
  "base-",
  "primitive-",
  "core-",
  "scale-",
  "raw-",
];

/** Prefixes that identify COMPONENT-scoped tokens. */
const COMPONENT_PREFIXES = ["token-", "comp-", "c-"];

/** Extract the structural tier of a token from its name. */
export function extractTier(tokenName: string): TokenTier {
  // Strip leading `--` or `$` sigil.
  const name = tokenName.replace(/^(--|\\$)/, "").toLowerCase();
  for (const p of PRIMITIVE_PREFIXES) {
    if (name.startsWith(p)) return TokenTier.PRIMITIVE;
  }
  for (const p of COMPONENT_PREFIXES) {
    if (name.startsWith(p)) return TokenTier.COMPONENT;
  }
  return TokenTier.SEMANTIC;
}

// ─── Token Roles ─────────────────────────────────────────────────────────────

/**
 * The visual/semantic role expressed by a token's name segments.
 * Used to cross-reference the token against the CSS property it's applied to.
 */
export const enum TokenRole {
  SURFACE = "surface",   // backgrounds, fills
  CONTENT = "content",   // text, icons, foreground
  STROKE  = "stroke",    // borders, outlines
  EFFECT  = "effect",    // shadows, filters
}

/** Ordered segment patterns — first match wins. */
const ROLE_PATTERNS: Array<{ role: TokenRole; patterns: RegExp }> = [
  {
    role: TokenRole.SURFACE,
    patterns: /(?:^|-)(?:surface|background|bg|fill)(?:-|$)/,
  },
  {
    role: TokenRole.CONTENT,
    patterns: /(?:^|-)(?:content|text|foreground|fg|icon)(?:-|$)/,
  },
  {
    role: TokenRole.STROKE,
    patterns: /(?:^|-)(?:stroke|border|outline|ring)(?:-|$)/,
  },
  {
    role: TokenRole.EFFECT,
    patterns: /(?:^|-)(?:effects?|shadow|blur|filter|overlay)(?:-|$)/,
  },
];

/** Extract the semantic role from a token name, or `null` if undetermined. */
export function extractRole(tokenName: string): TokenRole | null {
  const name = tokenName.replace(/^(--|\\$)/, "").toLowerCase();
  for (const { role, patterns } of ROLE_PATTERNS) {
    if (patterns.test(name)) return role;
  }
  return null;
}

// ─── CSS Property → Expected Role ────────────────────────────────────────────

/**
 * Maps a CSS property name to the token role we'd expect to see there.
 * Returns `null` when the property has no meaningful role constraint
 * (e.g. `padding`, `font-size` — value type already constrains the category).
 */
export function getExpectedRoleForProperty(cssProperty: string): TokenRole | null {
  const p = cssProperty.toLowerCase().trim();

  // Surface / fill
  if (
    p === "background" ||
    p === "background-color" ||
    p === "fill" ||
    p === "accent-color"
  ) {
    return TokenRole.SURFACE;
  }

  // Content / foreground
  if (
    p === "color" ||
    p === "caret-color" ||
    p === "text-decoration-color" ||
    p === "-webkit-text-fill-color"
  ) {
    return TokenRole.CONTENT;
  }

  // Stroke / border
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

  // Effect / shadow
  if (p === "box-shadow" || p === "text-shadow" || p === "filter" || p === "drop-shadow") {
    return TokenRole.EFFECT;
  }

  return null;
}

// ─── Score Context ────────────────────────────────────────────────────────────

export interface ScoreContext {
  /**
   * The token category we're primarily looking for (e.g. "SPACING").
   * When provided, an exact category match awards -100 pts.
   */
  expectedCategory?: TokenCategory;

  /**
   * The semantic role implied by the CSS property (e.g. TokenRole.SURFACE for
   * `background`). A matching role awards -80 pts; a conflicting role penalises
   * +60 pts. When `null` or `undefined` the role axis is skipped.
   */
  expectedRole?: TokenRole | null;

  /**
   * Set to `true` when the value match was approximate (RGB distance > 0 for
   * colors, unit conversion for lengths). Adds +5 pts.
   */
  isFuzzy?: boolean;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Computes a recommendation score for a candidate `DesignToken`.
 *
 * **Lower score = better suggestion.**
 *
 * The score is deliberately additive so each axis contributes independently
 * and the tiebreaker (name length) can never override a strong tier signal.
 *
 * Scoring table:
 * ┌──────────────────────────────┬─────────────┐
 * │ Factor                       │ Points      │
 * ├──────────────────────────────┼─────────────┤
 * │ Category match               │  -100       │
 * │ Role match (exact)           │   -80       │
 * │ Role conflict (wrong role)   │   +60       │
 * │ Tier: SEMANTIC               │   -30       │
 * │ Tier: COMPONENT              │   -10       │
 * │ Tier: PRIMITIVE              │   +40       │
 * │ Fuzzy match penalty          │    +5       │
 * │ Name length tiebreaker       │ len / 4     │
 * └──────────────────────────────┴─────────────┘
 */
export function scoreCandidate(token: DesignToken, ctx: ScoreContext): number {
  let score = 0;

  // 1. Category match
  if (ctx.expectedCategory && token.category === ctx.expectedCategory) {
    score -= 100;
  }

  // 2. Role match / conflict
  if (ctx.expectedRole != null) {
    const tokenRole = extractRole(token.name);
    if (tokenRole === ctx.expectedRole) {
      score -= 80; // ✓ perfect semantic role match
    } else if (tokenRole !== null) {
      score += 60; // ✗ wrong role — strong penalty
    }
    // tokenRole === null → role unknown, no bonus/malus
  }

  // 3. Tier weight
  const tier = extractTier(token.name);
  if (tier === TokenTier.SEMANTIC) {
    score -= 30;
  } else if (tier === TokenTier.COMPONENT) {
    score -= 10;
  } else {
    // PRIMITIVE — deprioritise unless nothing else matches
    score += 40;
  }

  // 4. Fuzzy match penalty
  if (ctx.isFuzzy) score += 5;

  // 5. Name-length tiebreaker — deliberately tiny weight
  score += token.name.length / 4;

  return score;
}

/**
 * Sort-in-place an array of candidates by their semantic score ascending
 * (lowest score = best suggestion appears first).
 */
export function sortCandidates(
  tokens: DesignToken[],
  ctx: ScoreContext,
): DesignToken[] {
  return tokens.slice().sort((a, b) => scoreCandidate(a, ctx) - scoreCandidate(b, ctx));
}

/**
 * Encodes a numeric score into a fixed-width sort string suitable for
 * `vscode.CompletionItem.sortText` (which uses lexicographic ordering).
 *
 * Scores are clamped to [-999, 999] then shifted to [0, 1998] and zero-padded
 * to 4 chars so the sort is stable and correct across VSCode's string sort.
 */
export function scoreToSortText(score: number): string {
  const shifted = Math.max(0, Math.min(1998, Math.round(score) + 999));
  return shifted.toString().padStart(4, "0");
}
