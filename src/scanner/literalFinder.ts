// Port of `LiteralFinder.kt`. Locates literals in a stylesheet that could
// be replaced by an indexed design token: hex colors, functional colors
// (`rgb`/`rgba`/`hsl`/`hsla`/`hwb`), durations and lengths.
//
// Each [Hit] carries:
//  - the matched text (`14px`, `#fff`) and its absolute offsets,
//  - a coarse [Kind] used downstream to lookup the value in the token index,
//  - a separate "replace range" that can overshoot the literal when the
//    value sits inside a transparent wrapper like `utils.rem-calc(14px)` —
//    that way the quick-fix swaps the whole expression for `var(--token)`
//    instead of leaving a redundant `utils.rem-calc(var(--token))`.
//
// MVP scope vs. Kotlin: skips `NUMBER_PROP_REGEX` (RN-style unitless
// literals — irrelevant in pure stylesheet contexts) and the
// JS-string-literal expansion. `var(--name, FALLBACK)` exclusion and
// `rem-calc()` wrapper expansion are included.

export type LiteralKind = "COLOR" | "LENGTH" | "DURATION";

export interface Hit {
  /** Inner literal value, used for token-value lookup (e.g. `14px`). */
  readonly text: string;
  /** Inner literal start offset in the file text. */
  readonly startOffset: int;
  /** Exclusive end offset of the inner literal. */
  readonly endOffsetExclusive: int;
  readonly kind: LiteralKind;
  /** Replace range start — equals [startOffset] unless inside a wrapper. */
  readonly replaceStart: int;
  /** Exclusive end of the replace range. */
  readonly replaceEndExclusive: int;
  /** Source text of the replace range — used by the quick-fix preview. */
  readonly replaceText: string;
}

type int = number;

// ─── Regexes — direct port of LiteralFinder.kt's companion ──────────────

// `#abc` / `#abcd` / `#aabbcc` / `#aabbccdd`, never inside an identifier.
const HEX_REGEX =
  /(?<![A-Za-z0-9_-])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
// Functional color forms; the parentheses are inside the match so we
// replace the whole call.
const FN_COLOR_REGEX =
  /(?<![A-Za-z0-9_-])(?:rgb|rgba|hsl|hsla|hwb)\(\s*[^)]*\)/gi;
const DURATION_REGEX = /(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:ms|s)\b/g;
const LENGTH_REGEX =
  /(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|%)\b/g;
// `var(--name, FALLBACK)` — capture group 1 is the fallback span.
const VAR_WITH_FALLBACK = /var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*,([^)]*)\)/g;

const WHITELIST = new Set([
  "0",
  "0px",
  "0rem",
  "0em",
  "0%",
  "100%",
  "0s",
  "0ms",
]);

// ─── Public entry point ─────────────────────────────────────────────────

export function findLiterals(text: string): Hit[] {
  const out: Hit[] = [];
  const fallbackRanges = computeFallbackRanges(text);

  const considerMatch = (
    raw: RegExpMatchArray,
    kind: LiteralKind,
  ): Hit | null => {
    const start = raw.index ?? 0;
    if (isInsideFallback(start, fallbackRanges)) return null;
    if (kind !== "COLOR" && WHITELIST.has(raw[0].toLowerCase())) return null;
    const end = start + raw[0].length;
    // Expand first so the declaration check sees the wrapper's left
    // edge (`rem-calc(`) — that way `$x: rem-calc(14px)` correctly
    // counts as a token declaration even though the literal `14px` is
    // not directly after the `:`. Without this, the panel would offer
    // to replace `rem-calc(14px)` with `var(--x)` — a circular ref.
    const hit = expandWrapper(text, raw[0], start, end, kind);
    if (isTokenDeclarationValue(text, hit.replaceStart)) return null;
    return hit;
  };

  for (const m of text.matchAll(HEX_REGEX)) {
    const hit = considerMatch(m, "COLOR");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(FN_COLOR_REGEX)) {
    const hit = considerMatch(m, "COLOR");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(DURATION_REGEX)) {
    const hit = considerMatch(m, "DURATION");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(LENGTH_REGEX)) {
    const hit = considerMatch(m, "LENGTH");
    if (!hit) continue;
    // Avoid double-matching `12s` already tagged as duration.
    if (out.some((h) => h.startOffset === hit.startOffset)) continue;
    out.push(hit);
  }
  return out;
}

/**
 * Returns true when [offset] sits directly after a token-declaration
 * `key:` separator. Four shapes count as declarations:
 *
 *   "key":   value         ←  SCSS map entry (quoted)
 *   $name:   value         ←  SCSS variable
 *   --name:  value         ←  CSS custom property
 *   "key":   "value"       ←  JS/JSON object literal (the value is
 *                              itself wrapped in quotes — the literal
 *                              we're checking sits AFTER the opening
 *                              value-quote, so we skip it first)
 *
 * The fourth shape covers token-catalogue files like:
 *   `"500": "#fe5716"` → `#fe5716` is a declaration, not a usage
 *
 * Plain CSS / JS property uses (`font-size: 14px`, `padding: '1px'`)
 * do NOT qualify — those are real hardcoded values we want flagged.
 * The distinguishing rule is the `$` / `--` prefix on the bare key,
 * or a *quoted* key (which catches both SCSS map and JS-object
 * declarations).
 *
 * Wrapped values (`$x: rem-calc(14px)`) are intentionally NOT
 * filtered because the wrapper sits between the `:` and the literal
 * — those are still useful "this hex should be a token" leads.
 * Filtering them would also break the wrapper-expansion replacement
 * story.
 */
function isTokenDeclarationValue(text: string, offset: number): boolean {
  let i = offset - 1;
  // (1) Optionally skip a single opening quote (`"`, `'`, or
  //     backtick) that wraps the literal — needed for the JS/JSON
  //     "key": "value" shape where the literal sits just after the
  //     value's opening quote, not just after the `:`. Stylesheet
  //     callers are unaffected: their literals aren't quote-wrapped
  //     and the loop below sees the `:` directly.
  if (i >= 0 && (text[i] === '"' || text[i] === "'" || text[i] === "`")) i--;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0 || text[i] !== ":") return false;

  // Walk back past whitespace before `:`.
  i--;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return false;

  // Case 1: quoted key (SCSS map entry).
  if (text[i] === '"' || text[i] === "'") return true;

  // Case 2: bare identifier — must start with `$` (SCSS var) or `--`
  // (CSS custom property). Walking back greedily over identifier chars
  // INCLUDES the dashes, so `--color-primary` is consumed in full
  // before `j` settles on the preceding whitespace. We then inspect:
  //   • the char at `j` itself for the `$` prefix (which is not part
  //     of the identifier regex and thus stops the walk one step
  //     earlier);
  //   • the identifier's leading two chars for `--` (the dashes were
  //     captured by the walk).
  let j = i;
  while (j >= 0 && /[A-Za-z0-9_-]/.test(text[j])) j--;
  const ident = text.substring(j + 1, i + 1);
  if (ident.length === 0) return false;
  if (j >= 0 && text[j] === "$") return true; //                   `$name:`
  if (ident.startsWith("--")) return true; //                      `--name:`
  return false;
}

// ─── Wrapper expansion ──────────────────────────────────────────────────

/**
 * If the literal at [start, end) is the sole argument of a transparent
 * wrapper call (`rem-calc(14px)`, `utils.rem-calc(14px)`), widen the
 * replace range to cover the whole call. Otherwise return a Hit pointing
 * at the literal alone.
 */
function expandWrapper(
  source: string,
  value: string,
  start: int,
  end: int,
  kind: LiteralKind,
): Hit {
  const base: Hit = {
    text: value,
    startOffset: start,
    endOffsetExclusive: end,
    kind,
    replaceStart: start,
    replaceEndExclusive: end,
    replaceText: value,
  };

  // Walk back: only whitespace, then `(`, then a recognised wrapper name.
  let i = start - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0 || source[i] !== "(") return base;
  const parenOpen = i;

  let nameEnd = parenOpen;
  let nameStart = nameEnd;
  while (nameStart > 0 && isWrapperNameChar(source[nameStart - 1])) nameStart--;
  if (nameStart === nameEnd) return base;
  const wrapperName = source.substring(nameStart, nameEnd);
  if (!isTransparentWrapper(wrapperName)) return base;

  // Walk forward: only whitespace, then `)`.
  let j = end;
  while (j < source.length && /\s/.test(source[j])) j++;
  if (j >= source.length || source[j] !== ")") return base;
  const parenClose = j + 1;

  return {
    ...base,
    replaceStart: nameStart,
    replaceEndExclusive: parenClose,
    replaceText: source.substring(nameStart, parenClose),
  };
}

function isWrapperNameChar(c: string): boolean {
  return /[A-Za-z0-9_.-]/.test(c);
}

/**
 * Wrappers whose argument maps 1:1 to the token's resolved value —
 * the token is already available in the wrapper's output unit, so the
 * call can be replaced wholesale. Matches against the trailing
 * identifier (after any `module.` prefix).
 */
function isTransparentWrapper(name: string): boolean {
  const trailing = name.includes(".")
    ? name.substring(name.lastIndexOf(".") + 1)
    : name;
  const lower = trailing.toLowerCase();
  return lower === "rem-calc" || lower === "rem";
}

// ─── var() fallback exclusion ───────────────────────────────────────────

interface Range {
  readonly start: int;
  readonly endExclusive: int;
}

function computeFallbackRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const m of text.matchAll(VAR_WITH_FALLBACK)) {
    const groupStart =
      (m.index ?? 0) + m[0].indexOf(",") + 1; //                first char of fallback
    const groupEnd = (m.index ?? 0) + m[0].length - 1; //       before the `)`
    ranges.push({ start: groupStart, endExclusive: groupEnd });
  }
  return ranges;
}

function isInsideFallback(offset: int, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.endExclusive) return true;
  }
  return false;
}
