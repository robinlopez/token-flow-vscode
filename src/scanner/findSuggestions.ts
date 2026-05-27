// Single entry-point for token suggestions on a hardcoded literal.
// Port of `SuggestionEngine.findSuggestions()` (Kotlin). Both the
// `HardcodedDiagnostics` provider and the Analyser dashboard call this
// so the two surfaces always show the same ordered candidate list.
//
// Pipeline (mirrors Kotlin):
//   1. Pick the expected category — caller-provided override beats the
//      literal's natural kind.
//   2. Cross-family pre-filter: drop candidates whose category isn't
//      semantically compatible with the expected one (rejects a
//      TYPOGRAPHY token on a `padding` declaration).
//   3. Name-based typography guard for metric properties.
//   4. Compose helper-derived candidates (`spacing(1.5)` etc).
//   5. If at least one exact or helper match exists, sort by
//      `scoreCandidate` and return the top N.
//   6. COLOR fallback: when no exact match exists, return every COLOR
//      token within `COLOR_DELTA_MAX` distance, sorted by colour
//      proximity first and semantic score second.

import { DesignToken, TokenCategory } from "../model/designToken";
import {
  isFamilyMismatch,
  isNameFamilyMismatch,
  scoreCandidate,
  ScoreContext,
} from "../model/semantics";
import { Hit, LiteralKind } from "./literalFinder";
import { TokenValueIndex } from "./tokenValueIndex";
import { helperSuggestionsFor } from "./helperSuggestions";
import { parseColor, RGBA } from "../ui/colorParser";

export const MAX_SUGGESTIONS = 5;
export const COLOR_DELTA_MAX = 0.05;

export interface TokenSuggestion {
  readonly token: DesignToken;
  /** True when the value matched exactly (vs. fuzzy colour or helper-derived). */
  readonly exact: boolean;
  /** Distance for non-exact matches (colour proximity in [0..1]). 0 for exact. */
  readonly delta: number;
}

/**
 * Maps a literal kind to the lookup category. SPACING is the default
 * for NUMBER-like literals because every numeric token category
 * normalises identical raw numbers to the same key, so the lookup
 * widens across all of them anyway (see `TokenValueIndex`).
 */
function literalKindToCategory(kind: LiteralKind): TokenCategory {
  if (kind === "COLOR") return "COLOR";
  if (kind === "DURATION") return "DURATION";
  return "SPACING";
}

export interface FindSuggestionsOptions {
  /** When provided, overrides the natural category derived from `hit.kind`. */
  readonly expectedCategory?: TokenCategory | null;
  /** Surrounding CSS property's expected role (surface/content/stroke/effect). */
  readonly expectedRole?: import("../model/semantics").TokenRole | null;
  /** When true, drop `external` (whitelist) tokens from the result. */
  readonly excludeExternal?: boolean;
}

export function findSuggestions(
  hit: Hit,
  valueIndex: TokenValueIndex,
  allTokens: readonly DesignToken[],
  opts: FindSuggestionsOptions = {},
): TokenSuggestion[] {
  const expectedCategory = opts.expectedCategory ?? null;
  const expectedRole = opts.expectedRole ?? null;
  const excludeExternal = opts.excludeExternal ?? false;
  const lookupCategory = expectedCategory ?? literalKindToCategory(hit.kind);

  // Exact value matches, with the two family guards applied.
  let exactMatches = valueIndex.lookupAcross(
    hit.text,
    expandedCategoriesFor(lookupCategory),
  );
  if (expectedCategory) {
    exactMatches = exactMatches.filter(
      (t) => !isFamilyMismatch(expectedCategory, t.category) &&
        !isNameFamilyMismatch(expectedCategory, t.name),
    );
  }
  if (excludeExternal) {
    exactMatches = exactMatches.filter((t) => !t.external);
  }

  // Helper-derived synthetic candidates (`spacing(1.5)`, `radius(2)` …).
  const helperMatches = helperSuggestionsFor(hit.text, hit.kind, allTokens)
    .filter((t) => !excludeExternal || !t.external)
    .map<TokenSuggestion>((t) => ({ token: t, exact: false, delta: 0 }));

  if (exactMatches.length > 0 || helperMatches.length > 0) {
    const direct = exactMatches.map<TokenSuggestion>((t) => ({
      token: t, exact: true, delta: 0,
    }));
    const ctx: ScoreContext = { expectedCategory, expectedRole };
    return [...direct, ...helperMatches]
      .sort((a, b) =>
        scoreCandidate(a.token, { ...ctx, isFuzzy: !a.exact }) -
        scoreCandidate(b.token, { ...ctx, isFuzzy: !b.exact }),
      )
      .slice(0, MAX_SUGGESTIONS);
  }

  // COLOR proximity fallback — no exact match exists, but a token may
  // sit close enough in RGBA space to be a useful suggestion.
  if (hit.kind === "COLOR") {
    const literalColor = parseColor(hit.text);
    if (!literalColor) return [];
    const candidates: { sugg: TokenSuggestion; score: number }[] = [];
    for (const token of allTokens) {
      if (token.category !== "COLOR") continue;
      if (excludeExternal && token.external) continue;
      const tokenColor = parseColor(token.resolvedValue);
      if (!tokenColor) continue;
      const delta = colorDistance(literalColor, tokenColor);
      if (delta > COLOR_DELTA_MAX) continue;
      const sugg: TokenSuggestion = { token, exact: false, delta };
      candidates.push({
        sugg,
        score: scoreCandidate(token, {
          expectedCategory, expectedRole, isFuzzy: true,
        }),
      });
    }
    return candidates
      // Primary: colour distance. Secondary: semantic score — same as
      // the Kotlin `compareBy({ delta }, { score })`.
      .sort((a, b) => a.sugg.delta - b.sugg.delta || a.score - b.score)
      .slice(0, MAX_SUGGESTIONS)
      .map(({ sugg }) => sugg);
  }

  return [];
}

/**
 * The set of categories `lookupAcross` should probe for an expected
 * category. Matches the IntelliJ widening (length-bearing family) so a
 * 12px spacing token can substitute for a missing radius candidate.
 */
function expandedCategoriesFor(c: TokenCategory): readonly TokenCategory[] {
  switch (c) {
    case "SPACING":
    case "RADIUS":
    case "SIZING":
    case "TYPOGRAPHY":
    case "BORDER":
    case "LAYOUT":
      // Order matters for `lookupAcross` dedup — prefer the requested
      // category first, then the broader family.
      return [c, "SPACING", "RADIUS", "SIZING", "TYPOGRAPHY"];
    default:
      return [c];
  }
}

function colorDistance(a: RGBA, b: RGBA): number {
  const dr = (a.r - b.r) / 255;
  const dg = (a.g - b.g) / 255;
  const db = (a.b - b.b) / 255;
  const da = (a.a - b.a) / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
}
