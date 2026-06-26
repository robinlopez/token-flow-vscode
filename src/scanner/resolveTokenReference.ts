// Resolves a textual token reference (as written in source) to the
// indexed `DesignToken` it ultimately points at — following the same
// alias-resolution chain the scanner and go-to-definition use, so any
// reference a hover can find is also resolvable here.
//
// Steps, in order of cost:
//   (a) exact name match,
//   (b) `resolveReference` — binding-prefix strip, mode-segment strip,
//       camelCase ↔ dot drift, dash-form fallback (shared with Alt+T
//       and the analyser's broken-ref detection),
//   (c) reverse mode-strip — index entry carries a mode segment the
//       reference doesn't,
//   (d) suffix match — index flattened beyond the reference's depth.

import { DesignToken } from "../model/designToken";
import { resolveReference, stripModeSegment } from "./tokenNameParser";

export function resolveTokenByReference(
  tokens: readonly DesignToken[],
  ref: string,
): DesignToken | null {
  // (a) exact.
  const exact = tokens.find((t) => t.name === ref);
  if (exact) return exact;

  // (b) shared multi-step resolver (prefix / mode / camelCase / dash).
  const names = new Set(tokens.map((t) => t.name));
  const resolved = resolveReference(ref, names);
  if (resolved) {
    const hit = tokens.find((t) => t.name === resolved.tokenName);
    if (hit) return hit;
  }

  // (c) reverse mode-strip.
  const modeHit = tokens.find(
    (t) => t.name !== ref && stripModeSegment(t.name) === ref,
  );
  if (modeHit) return modeHit;

  // (d) suffix match.
  if (ref.includes(".")) {
    const needle = "." + ref;
    const suffix = tokens.find((t) => t.name.endsWith(needle));
    if (suffix) return suffix;
  }

  return null;
}
