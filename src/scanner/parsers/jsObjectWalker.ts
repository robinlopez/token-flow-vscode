// Port of `JsObjectTokenParser.kt`.
//
// Light-weight parser for design-token files written as TS/JS object
// literals (PrimeUIX preset syntax, Style Dictionary refs, Material 3
// tokens, …). Walks every top-level `export const NAME = { … }` or
// `export default { … }` block and emits a `path → string` leaf for
// each terminal value.
//
// The path is the dot-joined sequence of keys leading to the leaf —
// `global.modeLight.high.surface.default`. Values are stored verbatim
// with the surrounding quotes stripped:
//   `"{primitive.primary.500}"` → `{primitive.primary.500}`
//   `'12px'` → `12px`
//
// Intentionally NOT a full JS parser. Skips arrays, computed keys,
// function values and template-string interpolations. Token files are
// pure data by convention so this is plenty.
//
// Shared utility: `parseAt` is exposed so other parsers (RuntimeObject,
// Phase 4) can reuse the same object/array/string-skipping logic
// rooted at a custom binding name.

export interface Leaf {
  readonly path: string;
  readonly value: string;
  /** Absolute offset of the value (or its opening quote) inside the source. */
  readonly offset: number;
}

const EXPORT_HEAD = /\bexport\s+(?:default|const\s+\w+)\s*[:=]?\s*/g;

/**
 * Top-level entry point: finds every `export const|default` object
 * literal and walks it with an empty initial path.
 */
export function parse(text: string): Leaf[] {
  const out: Leaf[] = [];
  for (const match of text.matchAll(EXPORT_HEAD)) {
    const headEnd = (match.index ?? 0) + match[0].length;
    let i = skipWs(text, headEnd);
    if (i >= text.length || text[i] !== "{") continue;
    walkObject(text, i + 1, [], out);
  }
  return out;
}

/**
 * Walks a single object literal whose opening `{` sits at
 * [openBraceIndex]. Leaves are collected under [initialPath] (so a
 * runtime parser can prefix them with the binding name, e.g.
 * `["colors"]`).
 *
 * Returns the index just past the matching `}` (or end-of-text on
 * EOF). Exposed so multiple parser strategies can reuse the same
 * walker without duplicating the skipping logic.
 */
export function parseAt(
  text: string,
  openBraceIndex: number,
  initialPath: readonly string[] = [],
): Leaf[] {
  if (openBraceIndex >= text.length || text[openBraceIndex] !== "{") return [];
  const out: Leaf[] = [];
  walkObject(text, openBraceIndex + 1, [...initialPath], out);
  return out;
}

// ─── Walker ────────────────────────────────────────────────────────────

function walkObject(
  text: string,
  start: number,
  path: string[],
  out: Leaf[],
): number {
  let i = start;
  while (i < text.length) {
    i = skipWsAndComments(text, i);
    if (i >= text.length) return i;
    const c = text[i];
    if (c === "}") return i + 1;
    if (c === ",") {
      i++;
      continue;
    }
    // Read a key: either a quoted string or a JS identifier.
    const key = readKey(text, i);
    if (!key) return i;
    i = key.endExclusive;
    i = skipWsAndComments(text, i);
    if (i >= text.length || text[i] !== ":") return i;
    i++; // past ':'
    i = skipWsAndComments(text, i);
    if (i >= text.length) return i;

    path.push(key.value);
    i = readValue(text, i, path, out);
    path.pop();
  }
  return i;
}

function readValue(
  text: string,
  start: number,
  path: string[],
  out: Leaf[],
): number {
  const i = skipWsAndComments(text, start);
  if (i >= text.length) return i;
  const c = text[i];
  if (c === "{") return walkObject(text, i + 1, path, out);
  if (c === "[") return skipBracketed(text, i, "[", "]");
  if (c === '"' || c === "'" || c === "`") {
    const tokenStart = i;
    const str = readStringLiteral(text, i);
    out.push({ path: path.join("."), value: str.value, offset: tokenStart });
    return str.endExclusive;
  }
  // Number / identifier / expression — read until `,` `}` `]` or newline at depth 0.
  const rawStart = i;
  const end = readPrimitive(text, i);
  const raw = text.substring(rawStart, end).trim();
  if (raw.length > 0 && raw !== "null" && raw !== "undefined") {
    out.push({ path: path.join("."), value: raw, offset: rawStart });
  }
  return end;
}

// ─── Small readers ─────────────────────────────────────────────────────

interface Range {
  readonly value: string;
  readonly endExclusive: number;
}

function readKey(text: string, start: number): Range | null {
  const c = text[start];
  if (c === undefined) return null;
  if (c === '"' || c === "'" || c === "`") {
    return readStringLiteral(text, start);
  }
  // Accept identifier-style keys AND unquoted numeric keys (e.g.
  // `neutral: { 700: '#fff' }`), which Style-Dictionary / PrimeUIX
  // presets routinely use for colour-scale shades.
  if (!isIdentStart(c)) return null;
  let j = start;
  while (j < text.length && isIdentPart(text[j])) j++;
  return { value: text.substring(start, j), endExclusive: j };
}

function readStringLiteral(text: string, start: number): Range {
  const quote = text[start];
  let j = start + 1;
  let sb = "";
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\" && j + 1 < text.length) {
      sb += text[j + 1];
      j += 2;
      continue;
    }
    if (ch === quote) {
      return { value: sb, endExclusive: j + 1 };
    }
    sb += ch;
    j++;
  }
  return { value: sb, endExclusive: j };
}

function readPrimitive(text: string, start: number): number {
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === "," || c === "}" || c === "]" || c === "\n") break;
    j++;
  }
  return j;
}

function skipBracketed(
  text: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      // Skip over string content so brackets inside literals don't
      // unbalance the count.
      j = readStringLiteral(text, j).endExclusive - 1;
    }
    j++;
  }
  return j;
}

function skipWs(text: string, start: number): number {
  let j = start;
  while (j < text.length && isWhitespace(text[j])) j++;
  return j;
}

function skipWsAndComments(text: string, start: number): number {
  let j = skipWs(text, start);
  while (j + 1 < text.length && text[j] === "/") {
    const next = text[j + 1];
    if (next === "/") {
      j += 2;
      while (j < text.length && text[j] !== "\n") j++;
    } else if (next === "*") {
      j += 2;
      while (j + 1 < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
    } else {
      return j;
    }
    j = skipWs(text, j);
  }
  return j;
}

// ─── Char classes ──────────────────────────────────────────────────────

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

function isIdentStart(c: string): boolean {
  return (
    (c >= "A" && c <= "Z") ||
    (c >= "a" && c <= "z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "$"
  );
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || c === "-";
}
