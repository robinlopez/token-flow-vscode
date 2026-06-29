// Port of `LiteralFinder.kt`. Locates literals that could be replaced by
// an indexed design token: hex colors, functional colors
// (`rgb`/`rgba`/`hsl`/`hsla`/`hwb`), named colors (`white`, `transparent`,
// …), durations, lengths, and bare unitless numbers in property-value
// position (`fontSize: 14`, `borderRadius: 8` — the React-Native / JS
// object-theme shape).
//
// Each [Hit] carries:
//  - the matched text (`14px`, `#fff`) and its absolute offsets,
//  - a coarse [Kind] used downstream to lookup the value in the token index,
//  - a separate "replace range" that can overshoot the literal when the
//    value sits inside a transparent wrapper like `utils.rem-calc(14px)` —
//    that way the quick-fix swaps the whole expression for `var(--token)`
//    instead of leaving a redundant `utils.rem-calc(var(--token))`.
//
// Literals inside `// …` / `/* … */` comments and inside `var(--x, FALLBACK)`
// fallback expressions are skipped (IntelliJ parity). `rem-calc()` wrapper
// expansion is included. The JS-string-literal expansion from the Kotlin
// side is still out of scope (replacement nicety, not a detection gap).

export type LiteralKind = "COLOR" | "LENGTH" | "DURATION" | "NUMBER";

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
  /**
   * The CSS property name this literal is the value of, e.g. `"background-color"`.
   * Extracted by walking back from [startOffset] to the preceding `:`. Used by
   * the scoring engine to determine the expected token role.
   * `null` when the property name cannot be determined (complex expressions,
   * SCSS maps, etc.).
   */
  readonly cssProperty: string | null;
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
// Named colors — same set as the Kotlin side.
const NAMED_COLOR_REGEX =
  /(?<![A-Za-z0-9_-])(?:transparent|black|white|red|green|blue|yellow|orange|purple|gray|grey|pink|brown)\b(?!-)/gi;
const DURATION_REGEX = /(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:ms|s)\b/g;
const LENGTH_REGEX =
  /(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|%)\b/g;
// Bare numeric value as the **sole** content of a property slot
// (`fontSize: 34,`, `radius: 8}`, `opacity: 0.5` at line end). Group 1 is
// the number itself — it always sits at the very end of the match (the
// trailing constructs are zero-width lookaheads), so callers recover its
// offset from `m.index + m[0].length - m[1].length`. The negative
// lookahead rejects unit-bearing values (`12px`, `1fr`, `50%`) and the
// positive lookahead requires the number to be alone in its slot, so CSS
// shorthand like `flex: 1 1 auto` / `border: 1 solid red` doesn't match.
const NUMBER_PROP_REGEX =
  /[A-Za-z_$][\w$]*\s*:\s*(-?\d+(?:\.\d+)?)(?![\w%.\-])(?=\s*[,;)}\]\n]|\s*$)/g;
// `var(--name, FALLBACK)` — capture group 1 is the fallback span.
const VAR_WITH_FALLBACK = /var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*,([^)]*)\)/g;
// Comment spans — literals inside them must not be flagged (IntelliJ parity).
const BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_REGEX = /\/\/.*/g;

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
  const commentRanges = computeCommentRanges(text);
  const isIgnored = (offset: int): boolean =>
    isInsideFallback(offset, fallbackRanges) ||
    isInsideRanges(offset, commentRanges);

  const considerMatch = (
    raw: RegExpMatchArray,
    kind: LiteralKind,
  ): Hit | null => {
    const start = raw.index ?? 0;
    if (isIgnored(start)) return null;
    if (kind !== "COLOR" && WHITELIST.has(raw[0].toLowerCase())) return null;
    const end = start + raw[0].length;
    const hit = expandWrapper(text, raw[0], start, end, kind);
    if (isTokenDeclarationValue(text, hit.replaceStart)) return null;
    const cssProperty = extractCssProperty(text, hit.replaceStart);
    return { ...hit, cssProperty };
  };

  for (const m of text.matchAll(HEX_REGEX)) {
    const hit = considerMatch(m, "COLOR");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(FN_COLOR_REGEX)) {
    const hit = considerMatch(m, "COLOR");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(NAMED_COLOR_REGEX)) {
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
  // Bare numbers in property-value position — runs last so any value
  // already tagged at the same offset (a unit-bearing `12px`) wins. The
  // reported range is group 1 (the number), not the leading `IDENT:`.
  for (const m of text.matchAll(NUMBER_PROP_REGEX)) {
    const number = m[1];
    if (number === undefined) continue;
    const start = (m.index ?? 0) + m[0].length - number.length;
    const end = start + number.length;
    if (isIgnored(start)) continue;
    if (WHITELIST.has(number.toLowerCase())) continue;
    if (out.some((h) => h.startOffset === start)) continue;
    // Reuse the same declaration detector as the unit-bearing literals so
    // RN/JS catalog entries (`sm: 8`, `"sm": 8`) fold into the declaration
    // bucket exactly like `8px` and get skipped consistently.
    if (isTokenDeclarationValue(text, start)) continue;
    out.push({
      text: number,
      startOffset: start,
      endOffsetExclusive: end,
      kind: "NUMBER",
      replaceStart: start,
      replaceEndExclusive: end,
      replaceText: number,
      cssProperty: extractCssProperty(text, start),
    });
  }
  return out;
}

/** Returns block (`/* … *\/`) and line (`// …`) comment spans. */
function computeCommentRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const m of text.matchAll(BLOCK_COMMENT_REGEX)) {
    const start = m.index ?? 0;
    ranges.push({ start, endExclusive: start + m[0].length });
  }
  for (const m of text.matchAll(LINE_COMMENT_REGEX)) {
    const start = m.index ?? 0;
    ranges.push({ start, endExclusive: start + m[0].length });
  }
  return ranges;
}

function isInsideRanges(offset: int, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.endExclusive) return true;
  }
  return false;
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
// ─── CSS property extraction ────────────────────────────────────────────────

/**
 * Walk backward from [startOffset] (the start of the replace range,
 * i.e. including any wrapper like `rem-calc(`) to find the CSS property
 * name that precedes the colon separator.
 *
 * We skip over whitespace and the colon, then read back an identifier
 * that matches `[a-z][a-z0-9-]*` (CSS property names). Stops at `{`, `;`,
 * newline or start-of-string to avoid crossing rule boundaries.
 *
 * Returns `null` when the pattern cannot be found (e.g. inside a SCSS map,
 * multiline shorthand, or template interpolation).
 */
function extractCssProperty(source: string, startOffset: number): string | null {
  let i = startOffset - 1;
  // Skip whitespace before the literal (and before any `(` wrapper).
  while (i >= 0 && /[\s()]/.test(source[i])) i--;
  // Expect a colon.
  if (i < 0 || source[i] !== ":") return null;
  i--;
  // Skip whitespace after the property name.
  while (i >= 0 && source[i] === " ") i--;
  // Read the property name backward (CSS props are [a-zA-Z0-9-]).
  const nameEnd = i + 1;
  while (i >= 0 && /[a-zA-Z0-9-]/.test(source[i])) i--;
  const nameStart = i + 1;
  if (nameStart === nameEnd) return null;
  const prop = source.substring(nameStart, nameEnd);
  // Sanity check: CSS property names start with a letter (or `-` for vendor).
  if (!/^-?[a-zA-Z]/.test(prop)) return null;
  // Reject SCSS/CSS variable declarations (`--foo:` or `$foo:`).
  if (prop.startsWith("--")) return null;
  return prop.toLowerCase();
}


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
    cssProperty: null, // filled in by the caller after expansion
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
