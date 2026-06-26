// Shared "what token reference is under the cursor?" detector.
//
// The same five-pattern recognition was previously inlined in three
// places (hover, go-to-definition, Alt+T alternatives). This module is
// the single source of truth used by the newer surfaces (Copy Token
// Value command + its `onTokenReference` context key) so the recognised
// reference shapes never drift.
//
// Patterns, checked most-specific first so `var(--x)` wins over the bare
// `--x` it contains:
//   1. `var(--name [, fallback])` — CSS var() call
//   2. `'{a.b.c}'` (also `"…"`, `` `…` ``) — Style-Dictionary alias literal
//   3. `--name`                  — bare CSS custom property
//   4. `$name`                   — SCSS variable
//   5. `ident.path.like.this`    — runtime property access (≥ 2 segments)

import * as vscode from "vscode";

export interface TokenReferenceHit {
  /** Resolved reference name (`--x`, `$x`, or a dotted JS path). */
  readonly name: string;
  /** Range of the recognised expression (the full `var(…)` call when present). */
  readonly range: vscode.Range;
}

export function tokenReferenceAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): TokenReferenceHit | null {
  const varCallRange = doc.getWordRangeAtPosition(
    pos,
    /var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*(?:,[^)]*)?\)/,
  );
  if (varCallRange) {
    const inner = doc.getText(varCallRange).match(/--[A-Za-z_][A-Za-z0-9_-]*/);
    if (inner) return { name: inner[0], range: varCallRange };
  }

  const sdAliasRange = doc.getWordRangeAtPosition(
    pos,
    /["'`]\{[A-Za-z_][A-Za-z0-9_.\-]*\}["'`]/,
  );
  if (sdAliasRange) {
    const inner = doc
      .getText(sdAliasRange)
      .match(/\{([A-Za-z_][A-Za-z0-9_.\-]*)\}/);
    if (inner) return { name: inner[1], range: sdAliasRange };
  }

  const cssRange = doc.getWordRangeAtPosition(pos, /--[A-Za-z_][A-Za-z0-9_-]*/);
  if (cssRange) return { name: doc.getText(cssRange), range: cssRange };

  const scssRange = doc.getWordRangeAtPosition(
    pos,
    /\$[A-Za-z_][A-Za-z0-9_-]*/,
  );
  if (scssRange) return { name: doc.getText(scssRange), range: scssRange };

  const propAccessRange = doc.getWordRangeAtPosition(
    pos,
    /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$0-9][A-Za-z0-9_$]*)+/,
  );
  if (propAccessRange) {
    return { name: doc.getText(propAccessRange), range: propAccessRange };
  }

  return null;
}
