// Port of `parsers/RuntimeFunctionParser.kt`.
//
// Detects callable design-token helpers declared as SINGLE-ARGUMENT
// LINEAR arrow functions — the convention most React-Native theme
// files use for spacings, sizes, and elevations:
//
//   const spacingUnit = 8;
//   const spacing = (value: number) => spacingUnit * value;
//   const radius  = (n: number) => Math.floor(4 * Math.abs(n));
//
// Each match yields a `ParsedHelper` carrying the helper name, the
// numeric unit (the constant multiplier — resolved through previously
// declared `const NAME = NUMBER` in the same file), and the source
// offset for goto-definition.
//
// Intentionally narrow:
//   • only **arrow** functions with a single non-destructured parameter,
//   • only **linear** bodies of the form
//     `[wrap(] UNIT * [Math.abs(]param[)] [)]`
//     (or `param * UNIT` swapped), where UNIT is a numeric literal or
//     a previously declared local `const`,
//   • wrappers `Math.floor`, `Math.ceil`, `Math.round` are
//     transparently skipped — they don't change the inversion math at
//     quarter-step precision.
//
// Multi-arg helpers (`normalize(size, 'width')`), polynomial bodies,
// or anything else fall through. Surfacing them as suggestions
// without a sound inverse function would mislead users.

import {
  HelperParser,
  ParsedHelper,
  registerHelperParser,
} from "./jsTokenFileParserRegistry";

// `const NAME = (PARAM[: TYPE]) => BODY` — captures up to the arrow.
// The body is read separately (it may contain matched parens).
const DECL =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)(?:\s*:\s*([^,)\n]+?))?\s*\)\s*=>\s*/gm;

// `const NAME [: TYPE] = NUMBER ;?` — the pre-pass index of numeric
// constants that helpers may reference instead of inlining the unit.
const NUMERIC_CONST =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+?)?\s*=\s*(-?\d*\.?\d+)\s*;?\s*$/gm;

export const RuntimeFunctionParser: HelperParser = {
  parse(text: string): readonly ParsedHelper[] {
    const numericConsts = collectNumericConsts(text);
    const out: ParsedHelper[] = [];
    for (const m of text.matchAll(DECL)) {
      const name = m[1];
      const param = m[2];
      const rawType = (m[3] ?? "").trim();
      const type = rawType.length > 0 ? rawType : null;

      // The body starts immediately after the matched arrow header.
      const headStart = m.index ?? 0;
      const bodyStart = headStart + m[0].length;
      const body = readArrowBody(text, bodyStart);
      if (body === null) continue;

      const analysed = analyseLinearBody(body, param, numericConsts);
      if (!analysed) continue;

      out.push({
        name,
        paramName: param,
        paramType: type,
        unit: analysed.unit,
        unitSource: analysed.unitSource,
        offset: headStart,
      });
    }
    return out;
  },
};

// ─── Body reader ───────────────────────────────────────────────────────

/**
 * Reads the body of an arrow function starting at [start]. Handles
 * both:
 *   • `(...) => EXPR;`         expression body, terminated by `;`/newline/EOF
 *   • `(...) => { return EXPR; }`  block body — we extract the first `return`
 *
 * Returns the trimmed body expression, or null when the body is
 * malformed (unbalanced braces, no `return` in a block, etc.).
 */
function readArrowBody(text: string, start: number): string | null {
  let i = start;
  while (i < text.length && isInlineWs(text[i]) && text[i] !== "\n") i++;
  if (i >= text.length) return null;
  if (text[i] === "{") {
    const end = matchBrace(text, i);
    if (end === null) return null;
    const block = text.substring(i + 1, end);
    // `return EXPR;` — first `return` keyword followed by anything
    // up to the next `;`. The Kotlin pattern is `\breturn\b\s*([^;]+)`.
    const ret = block.match(/\breturn\b\s*([^;]+)/);
    if (!ret) return null;
    return ret[1].trim();
  }
  const end = readExpressionEnd(text, i);
  return text.substring(i, end).trim();
}

function matchBrace(text: string, openIdx: number): number | null {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    }
    i++;
  }
  return null;
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j;
    j++;
  }
  return j;
}

function readExpressionEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (depth === 0 && (c === ";" || c === "\n")) return i;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    }
    i++;
  }
  return i;
}

// ─── Linear body analysis ──────────────────────────────────────────────

interface LinearAnalysis {
  readonly unit: number;
  readonly unitSource: string;
}

/**
 * If [body] is a linear expression in [param] (after stripping
 * `Math.floor/ceil/round` wrappers and `Math.abs(param)`), returns
 * `{ unit, unitSource }`. Otherwise null.
 */
function analyseLinearBody(
  body: string,
  param: string,
  numericConsts: ReadonlyMap<string, number>,
): LinearAnalysis | null {
  let expr = body.trim();
  // Strip outer Math.floor / Math.ceil / Math.round wrappers,
  // possibly chained. The Kotlin uses `matchEntire` so we anchor
  // with `^…$` here too.
  while (true) {
    const m = expr.match(/^Math\.(floor|ceil|round)\s*\((.*)\)\s*$/);
    if (!m) break;
    expr = m[2].trim();
  }
  // Two shapes: `UNIT * PARAM[modifiers]` or `PARAM[modifiers] * UNIT`.
  // The Kotlin regex is `^(.+?)\s*\*\s*(.+)$` — non-greedy left to
  // bias toward `UNIT * REST`, then we test both sides.
  const mult = expr.match(/^(.+?)\s*\*\s*(.+)$/);
  if (!mult) return null;
  const left = mult[1].trim();
  const right = mult[2].trim();

  // `param` may appear bare or wrapped in `Math.abs(…)`.
  const paramSidePattern = new RegExp(
    `^(?:${escapeRegex(param)}|Math\\.abs\\s*\\(\\s*${escapeRegex(param)}\\s*\\))$`,
  );
  let unitToken: string;
  if (paramSidePattern.test(right)) {
    unitToken = left;
  } else if (paramSidePattern.test(left)) {
    unitToken = right;
  } else {
    return null;
  }

  // Resolve unit: numeric literal first, else local const.
  const numericValue = Number(unitToken);
  let unit: number | null = Number.isFinite(numericValue) ? numericValue : null;
  if (unit === null) {
    const fromConst = numericConsts.get(unitToken);
    if (fromConst !== undefined) unit = fromConst;
  }
  if (unit === null || unit === 0) return null;
  return { unit, unitSource: unitToken };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Numeric-const pre-pass ────────────────────────────────────────────

function collectNumericConsts(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of text.matchAll(NUMERIC_CONST)) {
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    map.set(m[1], n);
  }
  return map;
}

// ─── Char classes ──────────────────────────────────────────────────────

function isInlineWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";
}

registerHelperParser(RuntimeFunctionParser);
