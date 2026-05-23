// Range-adjustment helpers used by the apply paths to avoid
// breaking the surrounding syntax when a token replacement crosses
// a context boundary (e.g. inserting a quoted Style-Dictionary
// alias inside an existing quoted string in JS/TS).
//
// Each helper takes the range the user thinks they want to overwrite
// (the literal that was detected by `findLiterals`) and returns the
// range that ACTUALLY needs to be overwritten so the resulting
// source is well-formed.

import * as vscode from "vscode";

const JS_LIKE_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
]);

const QUOTES = new Set(['"', "'", "`"]);

/**
 * In JS/TS-flavoured documents, expand [range] to include the
 * surrounding quote characters when the literal sits immediately
 * inside a matching pair. Solves the "double quote" problem:
 *
 *   Before fix: `padding: '1px'`
 *               replace `1px` with `'{path}'`
 *               → `padding: ''{path}''`  ← broken
 *
 *   After fix:  range expands to cover `'1px'`
 *               replace with `'{path}'`
 *               → `padding: '{path}'`     ← well-formed
 *
 * No-op for stylesheet documents (CSS doesn't have string-wrapped
 * values in this position) and for ranges not wrapped in matching
 * quotes.
 */
export function expandRangeForJsQuotes(
  document: vscode.TextDocument,
  range: vscode.Range,
): vscode.Range {
  if (!JS_LIKE_LANGUAGES.has(document.languageId)) return range;

  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  if (startOffset === 0 || endOffset >= document.getText().length) return range;

  const before = document.getText(
    new vscode.Range(
      document.positionAt(startOffset - 1),
      document.positionAt(startOffset),
    ),
  );
  const after = document.getText(
    new vscode.Range(
      document.positionAt(endOffset),
      document.positionAt(endOffset + 1),
    ),
  );

  if (!QUOTES.has(before) || before !== after) return range;
  return new vscode.Range(
    document.positionAt(startOffset - 1),
    document.positionAt(endOffset + 1),
  );
}

/**
 * Cheap heuristic: are we inside a backticked template literal?
 * Counts unescaped backticks from file start to [position]; an odd
 * count means there's an unclosed template, so the position is
 * inside one.
 *
 * Same algorithm as the drop-edit provider. Limitations are
 * deliberate (simple > clever): comments or single-/double-quoted
 * strings containing a literal "`" can skew the count. Real-world
 * boundaries dominate; false positives are rare.
 */
export function isInsideTemplateLiteral(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  if (!JS_LIKE_LANGUAGES.has(document.languageId)) return false;
  const text = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position),
  );
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") count++;
  }
  return count % 2 === 1;
}

/**
 * When the replacement text is a Style-Dictionary alias literal
 * (`'{a.b.c}'`) and the apply position sits inside a backticked
 * template literal in JS/TS, rewrite the alias to the PrimeUIX-style
 * `${dt('a.b.c')}` call interpolation. Otherwise return the
 * replacement unchanged.
 *
 * Mirrors the `TokenDropEditProvider` transformation so the user
 * gets the same well-formed output whether they apply via the
 * Hardcoded panel, Alt+T, or drag-drop into the same template.
 */
const SD_ALIAS_PAYLOAD = /^["'`]\{([A-Za-z_][A-Za-z0-9_.\-]*)\}["'`]$/;

export function adjustReplacementForContext(
  document: vscode.TextDocument,
  range: vscode.Range,
  replacement: string,
): string {
  const match = replacement.match(SD_ALIAS_PAYLOAD);
  if (!match) return replacement;
  if (!isInsideTemplateLiteral(document, range.start)) return replacement;
  return "${dt('" + match[1] + "')}";
}
