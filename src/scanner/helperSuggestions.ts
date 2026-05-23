// Port of `SuggestionEngine.helperSuggestionsFor()` from the IntelliJ
// plugin. Takes a hardcoded literal (`16px`, `250ms`) and the indexed
// `JS_RUNTIME_FUNCTION` tokens, and emits synthetic candidates whose
// name is the full call expression: `spacing(2)`, `radius(1.5)`.
//
// Why "synthetic": the resulting DesignToken doesn't correspond to an
// actual declaration — it's a fully-applied invocation of an existing
// helper. The replacement pipeline downstream (toWireCandidate /
// tokenExpression) only reads `name` and `kind`, so a synthetic with
// `kind = JS_RUNTIME_FUNCTION` and `name = "spacing(2)"` flows through
// the existing apply path unchanged: `tokenExpression(t) = t.name`.
//
// Multiplier snapping:
//   • round to the nearest quarter step (0.25 increments) — captures
//     `spacing(1)`, `spacing(1.5)`, `spacing(2)`, etc.; rejects
//     `spacing(1.33…)`.
//   • snapped value must land in [0.25, 12.0] — outside that range the
//     suggestion stops being plausible (a 50× scale isn't a token, it's
//     a layout decision).
//   • |exact - snapped| must be ≤ 0.05 — keeps `12 / 8 = 1.5` as a hit
//     but rejects `13 / 8 ≈ 1.625`.
//   • |unit × snapped - literal| must be ≤ 0.5 — value-space sanity
//     check after re-multiplying, so floating-point drift in the
//     multiplier doesn't push the result a full pixel off.
//
// Colour helpers aren't attempted — they'd need a different shape
// (interpolation/mix functions are not linear in the user's scalar).

import { DesignToken } from "../model/designToken";
import { LiteralKind } from "./literalFinder";

const HELPER_MIN_MULTIPLIER = 0.25;
const HELPER_MAX_MULTIPLIER = 12.0;
const HELPER_MULTIPLIER_TOLERANCE = 0.05;
const HELPER_VALUE_TOLERANCE = 0.5;

/**
 * Builds helper-call candidates for [literalText] of [literalKind],
 * drawing from [allTokens] (only the `JS_RUNTIME_FUNCTION` entries
 * with a non-null `functionUnit` are used).
 *
 * Returns an empty array when no helper invertibly matches the
 * literal — callers can concat unconditionally with the regular
 * value-index lookup.
 */
export function helperSuggestionsFor(
  literalText: string,
  literalKind: LiteralKind,
  allTokens: readonly DesignToken[],
): DesignToken[] {
  // COLOR helpers aren't linear — see file header. LENGTH and
  // DURATION are both handled because RN themes routinely expose
  // `spacing` (px), `radius` (px), and timing helpers (`ms`).
  if (literalKind === "COLOR") return [];

  const helpers = allTokens.filter(
    (t) => t.kind === "JS_RUNTIME_FUNCTION" && t.functionUnit !== null,
  );
  if (helpers.length === 0) return [];

  const literal = parseLiteralMagnitude(literalText);
  if (literal === null) return [];

  const out: DesignToken[] = [];
  for (const helper of helpers) {
    const unit = helper.functionUnit;
    if (unit === null || unit === 0) continue;
    const exact = literal / unit;
    const snapped = snapToQuarter(exact);
    if (snapped === null) continue;
    const produced = unit * snapped;
    if (Math.abs(produced - literal) > HELPER_VALUE_TOLERANCE) continue;

    const call = `${helper.name}(${formatMultiplier(snapped)})`;
    const producedDisplay = formatProduced(produced);
    // Synthetic clone — keep every field the apply/render pipeline
    // reads (kind, filePath, offset, scope, external, category) and
    // only swap the bits that depend on the call: name, raw/resolved
    // value, primaryConditionLabel (none — synthetic), variants
    // (none — a call has no variants).
    out.push({
      ...helper,
      name: call,
      rawValue: producedDisplay,
      resolvedValue: producedDisplay,
      variants: [],
      primaryConditionLabel: null,
    });
  }
  return out;
}

/**
 * Strips the trailing unit (`px`, `ms`, etc.) and parses the numeric
 * core. Returns null for unparsable input — callers skip them.
 *
 * Mirror of the Kotlin `parseLiteralMagnitude`: strip from the end
 * any character that isn't a digit / dot / leading-minus, then
 * `toDoubleOrNull()`. Robust against arbitrary unit suffixes without
 * having to enumerate them.
 */
function parseLiteralMagnitude(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  let end = trimmed.length;
  while (end > 0) {
    const c = trimmed[end - 1];
    if ((c >= "0" && c <= "9") || c === "." || c === "-") break;
    end--;
  }
  if (end === 0) return null;
  const n = Number(trimmed.substring(0, end));
  return Number.isFinite(n) ? n : null;
}

function snapToQuarter(m: number): number | null {
  const rounded = Math.round(m * 4.0) / 4.0;
  if (rounded < HELPER_MIN_MULTIPLIER || rounded > HELPER_MAX_MULTIPLIER) {
    return null;
  }
  if (Math.abs(m - rounded) > HELPER_MULTIPLIER_TOLERANCE) return null;
  return rounded;
}

function formatMultiplier(m: number): string {
  return Number.isInteger(m) ? String(Math.trunc(m)) : String(m);
}

function formatProduced(d: number): string {
  return Number.isInteger(d) ? String(Math.trunc(d)) : String(d);
}
