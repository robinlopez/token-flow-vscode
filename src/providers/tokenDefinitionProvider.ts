// `DefinitionProvider` for token references — wires Ctrl/Cmd+Click,
// F12, Peek Definition and Go-to-Definition-to-the-Side straight to
// the token's declaration. Native VSCode flow, so the keyboard
// shortcut, peek view, sidebar navigation and the user's custom
// `editor.action.revealDefinition*` bindings all just work.
//
// Recognised references:
//   • `var(--name)`              — anywhere in the call
//   • `--name`, `$name`          — bare CSS / SCSS
//   • `'{a.b.c}'` (also `"…"`, `` `…` ``)   — Style-Dictionary alias
//   • `colors.PRIMARY_500`       — runtime property access (≥1 dot)
//
// Targeting follows the same alias-resolution chain the scanner uses
// (exact / mode-strip / lead-segment-strip / reverse-mode-strip /
// suffix), so a click on `'{primitive.neutral.400}'` lands on
// `primitive.modeLight.neutral.400` when only the mode-bearing
// variant is indexed.

import * as vscode from "vscode";
import { DesignToken } from "../model/designToken";
import { TokenScanner } from "../scanner/tokenScanner";
import { stripModeSegment } from "../scanner/tokenNameParser";
import { ActiveScopeTracker } from "../services/activeScopeTracker";

export class TokenDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly scanner: TokenScanner,
    private readonly scopes: ActiveScopeTracker,
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | null> {
    const name = referenceNameAt(document, position);
    if (!name) return null;

    const tokens = await this.scanner.scan();
    const active = this.scopes.activeNames();
    const inScope = tokens.filter((t) => active.has(t.scope));

    const token = findDefinitionTarget(inScope, name);
    if (!token) return null;

    const targetUri = vscode.Uri.file(token.filePath);
    const targetDoc = await vscode.workspace.openTextDocument(targetUri);
    const targetPos = targetDoc.positionAt(token.offset);
    return new vscode.Location(targetUri, targetPos);
  }
}

/**
 * Returns the textual token reference under [position]. Five patterns,
 * checked in this order so a more specific match (e.g. `var(--x)`)
 * always wins over a contained narrower one (the bare `--x`).
 *
 *   1. `var(--name [, fallback])` — CSS var() call
 *   2. `'{a.b.c}'`               — Style-Dictionary alias literal
 *   3. `--name`                  — bare CSS custom-property name
 *   4. `$name`                   — SCSS variable
 *   5. `ident.path.like.this`    — runtime property access (≥ 2 segs)
 */
function referenceNameAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): string | null {
  const varCallRange = doc.getWordRangeAtPosition(
    pos,
    /var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*(?:,[^)]*)?\)/,
  );
  if (varCallRange) {
    const inner = doc.getText(varCallRange).match(/--[A-Za-z_][A-Za-z0-9_-]*/);
    if (inner) return inner[0];
  }
  const sdAliasRange = doc.getWordRangeAtPosition(
    pos,
    /["'`]\{[A-Za-z_][A-Za-z0-9_.\-]*\}["'`]/,
  );
  if (sdAliasRange) {
    const inner = doc.getText(sdAliasRange).match(/\{([A-Za-z_][A-Za-z0-9_.\-]*)\}/);
    if (inner) return inner[1];
  }
  const cssRange = doc.getWordRangeAtPosition(pos, /--[A-Za-z_][A-Za-z0-9_-]*/);
  if (cssRange) return doc.getText(cssRange);

  const scssRange = doc.getWordRangeAtPosition(
    pos,
    /\$[A-Za-z_][A-Za-z0-9_-]*/,
  );
  if (scssRange) return doc.getText(scssRange);

  const propAccessRange = doc.getWordRangeAtPosition(
    pos,
    /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$0-9][A-Za-z0-9_$]*)+/,
  );
  if (propAccessRange) return doc.getText(propAccessRange);

  return null;
}

/**
 * Applies the same multi-step lookup chain `resolveValue` uses, so a
 * reference that successfully resolves to a value also navigates to
 * the right declaration. Mirroring keeps the two surfaces (alias
 * resolution / go-to-def) coherent — any name a hover can find is
 * also clickable.
 */
function findDefinitionTarget(
  tokens: readonly DesignToken[],
  ref: string,
): DesignToken | null {
  // (a) exact.
  const exact = tokens.find((t) => t.name === ref);
  if (exact) return exact;

  // (b) mode-stripped retry.
  const canonical = stripModeSegment(ref);
  if (canonical) {
    const hit = tokens.find((t) => t.name === canonical);
    if (hit) return hit;
  }

  // (c) lead-segment strip — `primitive.primary.500` → `primary.500` → `500`.
  const segs = ref.split(".");
  for (let skip = 1; skip < segs.length; skip++) {
    const sub = segs.slice(skip).join(".");
    const hit = tokens.find((t) => t.name === sub);
    if (hit) return hit;
  }

  // (d) reverse mode-strip — index entry has a mode segment the
  //     reference doesn't carry.
  const modeHit = tokens.find(
    (t) => t.name !== ref && stripModeSegment(t.name) === ref,
  );
  if (modeHit) return modeHit;

  // (e) suffix match.
  const needle = "." + ref;
  const suffix = tokens.find((t) => t.name.endsWith(needle));
  if (suffix) return suffix;

  return null;
}
