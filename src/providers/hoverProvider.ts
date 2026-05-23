// Hover for `var(--name)` / `--name` / `$name` references. Renders the
// shared token markdown (see `ui/tokenMarkdown.ts`) — same content the
// Library tree shows on item hover.

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { buildTokenMarkdown } from "../ui/tokenMarkdown";
import { ActiveScopeTracker } from "../services/activeScopeTracker";

export class TokenHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly scanner: TokenScanner,
    private readonly scopes: ActiveScopeTracker,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | null> {
    const enabled = vscode.workspace
      .getConfiguration("tokenFlow")
      .get<boolean>("hover.enabled", true);
    if (!enabled) return null;

    const ref = referenceAt(document, position);
    if (!ref) return null;

    const tokens = await this.scanner.scan();
    // Match by name + active-scope membership so a token from a
    // non-active scope (e.g. `mobile` referenced inside a `desktop`
    // file) doesn't surface — keeps the hover honest about which
    // tokens actually resolve in the current context.
    const active = this.scopes.activeNames();
    const token = tokens.find(
      (t) => t.name === ref.name && active.has(t.scope),
    );
    if (!token) return null;

    const md = new vscode.MarkdownString(buildTokenMarkdown(token), true);
    md.supportHtml = true;
    return new vscode.Hover(md, ref.range);
  }
}

interface TokenRef {
  readonly name: string; //  `$x` or `--x`
  readonly range: vscode.Range;
}

/** Identify a token reference at the cursor — supports `var(--x)`, `--x`, `$x`. */
function referenceAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): TokenRef | null {
  const cssRange = doc.getWordRangeAtPosition(pos, /--[A-Za-z_][A-Za-z0-9_-]*/);
  if (cssRange) return { name: doc.getText(cssRange), range: cssRange };

  const scssRange = doc.getWordRangeAtPosition(
    pos,
    /\$[A-Za-z_][A-Za-z0-9_-]*/,
  );
  if (scssRange) return { name: doc.getText(scssRange), range: scssRange };

  return null;
}
