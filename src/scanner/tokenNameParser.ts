// Partial port of `TokenNameParser.kt`. Only the helpers required by
// the JS alias resolver and group-collapsing logic are ported here —
// the camelCase/dot reconciliation used by the IntelliJ replacement
// helpers lives on the call-site replacement path, which the VS Code
// port hasn't reached yet.
//
// What "mode segment" means:
//
//   Style-Dictionary / PrimeUIX presets often carry sibling paths
//   `…modeLight.…` and `…modeDark.…` for the same logical token.
//   We want those to collapse into a single index entry whose primary
//   value comes from `modeLight` and whose variants carry the other
//   mode declarations.

/**
 * Detects a "mode" segment (`modeLight`, `modeDark`, `mode-xxx`, …).
 * These segments come from theme presets where light/dark variants
 * live at sibling paths and would otherwise look like unrelated
 * tokens.
 */
export function isModeSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  if (!s.startsWith("mode") || s.length <= 4) return false;
  const c = s[4];
  return (c >= "a" && c <= "z") || c === "-";
}

/**
 * Strips the first `modeXxx` segment from a JS/TS object path so
 * light/dark variants share a single canonical name. Returns null
 * when [name] has no mode segment (i.e. nothing to strip).
 */
export function stripModeSegment(name: string): string | null {
  if (!name.includes(".")) return null;
  const parts = name.split(".");
  const idx = parts.findIndex(isModeSegment);
  if (idx < 0) return null;
  return [...parts.slice(0, idx), ...parts.slice(idx + 1)].join(".");
}

/**
 * Returns the mode segment of [name], lowercased and prefix-stripped
 * (`light`, `dark`). Used by `primaryConditionLabel` so the first
 * column of the variant table reads as the mode rather than the
 * generic "default".
 */
export function modeSegmentOf(name: string): string | null {
  if (!name.includes(".")) return null;
  const seg = name.split(".").find(isModeSegment);
  if (!seg) return null;
  // Both casings appear in the wild — be tolerant.
  return seg
    .replace(/^mode/i, "")
    .replace(/^-/, "")
    .toLowerCase();
}

/** Returns the raw mode segment as it appears in [name] (`modeLight`, `modeDark`). */
export function rawModeSegmentOf(name: string): string | null {
  const sep = pathSeparator(name);
  if (!sep) return null;
  return name.split(sep).find(isModeSegment) ?? null;
}

/** Index of the mode segment in the split name, or -1 when none. */
export function modeSegmentIndex(name: string): number {
  const sep = pathSeparator(name);
  if (!sep) return -1;
  return name.split(sep).findIndex(isModeSegment);
}

/**
 * Picks the segment separator a JS path actually uses. Dots win when
 * both are present (`token.modeLight.form-weight`) because the dash
 * may be inside a leaf identifier rather than a real separator.
 */
export function pathSeparator(name: string): "." | "-" | null {
  if (name.includes(".")) return ".";
  if (name.includes("-")) return "-";
  return null;
}

/**
 * Re-injects [rawModeSegment] at [index] in [canonical]. Symmetric with
 * `stripModeSegment` so insertion paths can preserve the source's mode.
 * When [separator] is supplied, the replacement uses that joiner —
 * lets callers emit `token-modeLight-x-y` (dash form observed in some
 * PrimeUIX-derived setups) instead of dotting an inherently-hyphenated
 * source.
 */
export function injectModeSegment(
  canonical: string,
  rawModeSegment: string,
  index: number,
  separator: "." | "-" = ".",
): string {
  // The canonical name is always dotted at indexing time; split on `.`
  // regardless of the desired output separator.
  const segs = canonical.split(".");
  const pos = Math.max(0, Math.min(index, segs.length));
  segs.splice(pos, 0, rawModeSegment);
  return segs.join(separator);
}

export interface ResolvedReference {
  readonly tokenName: string;
  readonly bindingPrefix: string;
}

/**
 * Port of `TokenNameParser.resolveReference` (IntelliJ). Resolves a
 * reference name to a token that exists in [tokenNames], tolerating:
 *
 *   1. A leading export-binding segment (`token.…`) the indexer strips.
 *   2. A mode segment (`modeLight` / `modeDark`) the indexer strips.
 *   3. camelCase / dot drift between source and tree
 *      (`…defaultHigh.surface` vs `…default.high.surface`).
 *   4. Dash-separated paths (`{token-modeLight-form-…}`) — the index
 *      stores dotted names, source occasionally hyphenates. We retry
 *      with `-` rewritten to `.` when the dotted form would otherwise
 *      have nothing to chew on.
 *
 * Returns the matched token name plus the binding prefix that had to
 * be stripped (`"token."` or `""`), so the caller can re-inject it
 * when rebuilding a replacement string.
 */
export function resolveReference(
  name: string,
  tokenNames: ReadonlySet<string>,
): ResolvedReference | null {
  const direct = resolveDotted(name, tokenNames);
  if (direct) return direct;
  // Dash-form fallback: `{token-modeLight-form-…}` is observed in the
  // wild (some PrimeNG / Tailwind setups). The indexer emits dotted
  // names, so we re-attempt with dashes folded into dots. Only worth
  // doing when there's no dot already — mixed shapes (e.g. one segment
  // with a literal `-` like `font-weight`) would be mangled.
  if (!name.includes(".") && name.includes("-")) {
    const dotted = name.replace(/-/g, ".");
    const viaDots = resolveDotted(dotted, tokenNames);
    if (viaDots) return viaDots;
  }
  return null;
}

function resolveDotted(
  name: string,
  tokenNames: ReadonlySet<string>,
): ResolvedReference | null {
  const hit0 = tryMatch(name, "", tokenNames);
  if (hit0) return hit0;
  const canonical = stripModeSegment(name) ?? name;
  if (canonical !== name) {
    const hit1 = tryMatch(canonical, "", tokenNames);
    if (hit1) return hit1;
  }
  if (!name.includes(".")) return null;

  // `token.global.x.y` → bindingPrefix=`token.`, stripped=`global.x.y`.
  // Try every leading-segment-strip in turn — IntelliJ only strips the
  // first segment, but in practice some indexes drop the outer binding
  // AND a wrapper key (e.g. `colorScheme.light.x.y` → `x.y`). Walking
  // the prefix gives us the same coverage as the suffix-match fallback
  // without the O(n) scan.
  const segs = name.split(".");
  for (let skip = 1; skip < segs.length; skip++) {
    const stripped = segs.slice(skip).join(".");
    const prefix = segs.slice(0, skip).join(".") + ".";
    const hit = tryMatch(stripped, prefix, tokenNames);
    if (hit) return hit;
    const strippedCanonical = stripModeSegment(stripped) ?? stripped;
    if (strippedCanonical !== stripped) {
      const hit2 = tryMatch(strippedCanonical, prefix, tokenNames);
      if (hit2) return hit2;
    }
  }
  return null;
}

function tryMatch(
  candidate: string,
  prefix: string,
  tokenNames: ReadonlySet<string>,
): ResolvedReference | null {
  if (tokenNames.has(candidate)) return { tokenName: candidate, bindingPrefix: prefix };
  const segs = candidate.split(".");
  // One adjacent merge: `a.b` → `aB`.
  if (segs.length >= 2) {
    for (let i = 0; i < segs.length - 1; i++) {
      const merged = [...segs];
      merged[i] = merged[i] + capitalize(merged[i + 1]);
      merged.splice(i + 1, 1);
      const c = merged.join(".");
      if (tokenNames.has(c)) return { tokenName: c, bindingPrefix: prefix };
    }
  }
  // One camelCase split: `aB` → `a.b`.
  for (let i = 0; i < segs.length; i++) {
    const split = splitCamelCaseOnce(segs[i]);
    if (!split) continue;
    const expanded = [...segs];
    expanded[i] = split[0];
    expanded.splice(i + 1, 0, split[1]);
    const c = expanded.join(".");
    if (tokenNames.has(c)) return { tokenName: c, bindingPrefix: prefix };
  }
  return null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.substring(1);
}

function splitCamelCaseOnce(segment: string): [string, string] | null {
  let idx = -1;
  for (let i = 1; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return null;
  const head = segment.substring(0, idx);
  const tail = segment[idx].toLowerCase() + segment.substring(idx + 1);
  return [head, tail];
}
