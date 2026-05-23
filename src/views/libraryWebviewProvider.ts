// Webview-based Library view. Rich rows with inline color swatches,
// in-panel search + chip filters, per-row action buttons (copy, goto)
// and a variant-table popover on the `+N` badge.
//
// Architecture:
//   • Host owns the lifecycle, the source of truth for tokens (via
//     `TokenScanner`) and the filter state (in-memory, resets on
//     reload — matches every other VSCode sidebar filter).
//   • Client (src/webview/library/main.ts) is purely declarative:
//     receives `tokens` + `filterState` snapshots, renders the DOM,
//     re-emits user-driven events through `postMessage`.

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { DesignToken, TokenCategory, TokenKind } from "../model/designToken";
import {
  LibraryClientMessage,
  LibraryHostMessage,
} from "../webview/shared/protocol";
import { buildWebviewHtml } from "./webviewHtml";
import { toWireToken } from "./wireConversions";
import {
  ActiveScopeTracker,
  isTokenRelevantLanguage,
} from "../services/activeScopeTracker";

export class LibraryWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tokenFlow.library";

  private view: vscode.WebviewView | null = null;
  /**
   * Stored verbatim — no `.trim()` at write time. Trimming would
   * silently swallow trailing spaces the user typed, which breaks the
   * multi-term search UX ("informative " becomes "informative" and
   * the next character lands AFTER the swallowed space, making it
   * impossible to type the second term). Normalisation happens only
   * when matching.
   */
  private query: string | null = null;
  private categories: ReadonlySet<TokenCategory> = new Set();
  private kinds: ReadonlySet<TokenKind> = new Set();
  private readonly _onDidChangeFilter = new vscode.EventEmitter<void>();
  /** Fires whenever the filter changes — drives the title-bar context key. */
  readonly onDidChangeFilter = this._onDidChangeFilter.event;

  constructor(
    private readonly scanner: TokenScanner,
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ActiveScopeTracker,
  ) {
    scanner.onDidChange(() => this.postTokens());
    scopes.onDidChange(() => {
      this.postTokens();
      this.postScope();
    });
    // The status-bar item already listens for active-editor changes;
    // we mirror that here so the in-panel scope strip stays accurate
    // when the user just switches tabs without a settings change.
    vscode.window.onDidChangeActiveTextEditor(() => this.postScope());
  }

  // ─── Filter state ─────────────────────────────────────────────────────

  get isFilterActive(): boolean {
    return (
      this.query !== null ||
      this.categories.size > 0 ||
      this.kinds.size > 0
    );
  }

  describeFilter(): string {
    const parts: string[] = [];
    if (this.categories.size > 0) parts.push(`${this.categories.size} cat`);
    if (this.kinds.size > 0) parts.push(`${this.kinds.size} kind`);
    if (this.query) parts.push(`"${truncate(this.query, 20)}"`);
    return parts.join(" · ");
  }

  clearFilters(): void {
    if (!this.isFilterActive) return;
    this.query = null;
    this.categories = new Set();
    this.kinds = new Set();
    this._onDidChangeFilter.fire();
    this.postFilterState();
  }

  // ─── WebviewViewProvider ─────────────────────────────────────────────

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")],
    };
    view.webview.html = buildWebviewHtml({
      name: "library",
      title: "Token Flow — Library",
      webview: view.webview,
      extensionUri: this.extensionUri,
      bodyHtml: skeletonHtml(),
    });
    view.webview.onDidReceiveMessage((msg: LibraryClientMessage) =>
      this.handleClientMessage(msg),
    );
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  // ─── Outbound messages ───────────────────────────────────────────────

  private async postTokens(): Promise<void> {
    if (!this.view) return;
    const tokens = await this.scanner.scan();
    const active = this.scopes.activeNames();
    const wire = tokens.filter((t) => active.has(t.scope)).map(toWireToken);
    this.send({ type: "tokens", tokens: wire });
  }

  private postScope(): void {
    if (!this.view) return;
    const resolution = this.scopes.get();
    const editor = vscode.window.activeTextEditor;
    const idle =
      !editor || !isTokenRelevantLanguage(editor.document.languageId);
    this.send({
      type: "scope",
      specificName: resolution.specific?.name ?? null,
      activeNames: resolution.active.map((s) => s.name),
      idle,
    });
  }

  private postFilterState(): void {
    this.send({
      type: "filterState",
      query: this.query,
      categories: [...this.categories],
      kinds: [...this.kinds],
    });
  }

  private send(msg: LibraryHostMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  // ─── Inbound messages ────────────────────────────────────────────────

  private async handleClientMessage(msg: LibraryClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postTokens();
        this.postFilterState();
        this.postScope();
        return;
      case "setQuery":
        // Store the raw string (including trailing spaces) so multi-
        // term search can compose terms. Treat a value of only
        // whitespace as "no filter" to keep the chip-active indicator
        // honest.
        this.query = msg.query.trim().length === 0 ? null : msg.query;
        this._onDidChangeFilter.fire();
        this.postFilterState();
        return;
      case "toggleCategory": {
        const next = new Set(this.categories);
        if (next.has(msg.category)) next.delete(msg.category);
        else next.add(msg.category);
        this.categories = next;
        this._onDidChangeFilter.fire();
        this.postFilterState();
        return;
      }
      case "toggleKind": {
        const next = new Set(this.kinds);
        if (next.has(msg.kind)) next.delete(msg.kind);
        else next.add(msg.kind);
        this.kinds = next;
        this._onDidChangeFilter.fire();
        this.postFilterState();
        return;
      }
      case "clearFilters":
        this.clearFilters();
        return;
      case "revealToken": {
        const token = await this.findToken(msg.name);
        if (token) await revealToken(token);
        return;
      }
      case "copyToken": {
        const token = await this.findToken(msg.name);
        if (!token) return;
        const expr = tokenExpressionOf(token);
        await vscode.env.clipboard.writeText(expr);
        // 2s status hint so the user gets feedback for an otherwise
        // silent action. Using setStatusBarMessage keeps things light
        // — a popup notification would be too loud for "I clicked copy".
        vscode.window.setStatusBarMessage(
          `Token Flow: copied ${expr}`,
          2000,
        );
        return;
      }
      case "showAlternatives": {
        await vscode.commands.executeCommand(
          "tokenFlow.showAlternativesForToken",
          msg.name,
        );
        return;
      }
      case "openSettings":
        await vscode.commands.executeCommand("tokenFlow.openSettings");
        return;
    }
  }

  private async findToken(name: string): Promise<DesignToken | undefined> {
    const tokens = await this.scanner.scan();
    return tokens.find((t) => t.name === name);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

import { tokenExpression } from "../model/designToken";
// Imported at the bottom to keep the file's "what does this provider
// actually do" section readable above. tokenExpression is the single
// place that knows how to turn a token into its source-code form
// (`var(--x)` / `$x` / `'{path}'`). copyToken re-uses it so the
// clipboard payload matches whatever an insertion / quick-fix would
// emit elsewhere in the plugin.
function tokenExpressionOf(token: DesignToken): string {
  return tokenExpression(token);
}

async function revealToken(token: DesignToken): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(token.filePath);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = doc.positionAt(token.offset);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

function skeletonHtml(): string {
  // The header now has three rows:
  //   1. scope strip (clickable → opens the Settings webview),
  //   2. search input + filter-icon button (opens a dropdown panel
  //      with Kinds first, then Categories, with a divider),
  //   3. an active-filter summary line, only visible when a chip is on.
  // The dropdown panel itself lives outside the .library-header__row
  // for absolute positioning relative to the button.
  return /* html */ `
<header class="library-header">
  <button id="library-scope" class="scope-strip" type="button" title="Click to configure scopes">
    <span class="scope-strip__icon" aria-hidden="true">⌗</span>
    <span class="scope-strip__label">Scope</span>
    <span id="library-scope-value" class="scope-strip__value">…</span>
  </button>
  <div class="library-header__row">
    <input id="library-search" type="search" placeholder="Search by name or value (multi-term)…" autocomplete="off">
    <button id="library-view-mode-btn" class="view-mode-btn" type="button" title="Switch to Visual mode">
      <!-- icon-list: shown when we ARE in visual mode (click to go back to list) -->
      <span class="icon-list" hidden aria-hidden="true">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
          <rect x="2" y="3" width="3" height="2" rx="0.5"/><rect x="7" y="3" width="7" height="2" rx="0.5"/>
          <rect x="2" y="7" width="3" height="2" rx="0.5"/><rect x="7" y="7" width="7" height="2" rx="0.5"/>
          <rect x="2" y="11" width="3" height="2" rx="0.5"/><rect x="7" y="11" width="7" height="2" rx="0.5"/>
        </svg>
      </span>
      <!-- icon-visual: shown when we ARE in list mode (click to go to visual) -->
      <span class="icon-visual" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
          <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/>
          <rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>
        </svg>
      </span>
    </button>
    <div class="filter-wrap">
      <button id="library-filter-btn" class="filter-btn" type="button" title="Filter by kind / category" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z"/></svg>
        <span id="library-filter-count" class="filter-btn__count" hidden>0</span>
      </button>
      <div id="library-filter-panel" class="filter-panel" hidden role="dialog" aria-label="Filter tokens">
        <div class="filter-panel__section">
          <h4 class="filter-panel__title">Kinds</h4>
          <div id="library-kind-chips" class="chips"></div>
        </div>
        <hr class="filter-panel__divider">
        <div class="filter-panel__section">
          <h4 class="filter-panel__title">Categories</h4>
          <div id="library-chips" class="chips"></div>
        </div>
        <hr class="filter-panel__divider">
        <div class="filter-panel__section">
          <h4 class="filter-panel__title">Grouping</h4>
          <label class="toggle-row" for="library-subfamily-toggle">
            <input id="library-subfamily-toggle" type="checkbox">
            <span class="toggle-row__text">
              <span class="toggle-row__title">Group by sub-family</span>
              <span class="toggle-row__hint">Auto-detected from token names (IntelliJ parity).</span>
            </span>
          </label>
        </div>
      </div>
    </div>
  </div>

</header>
<main id="library-body">
  <p class="library-empty">Scanning…</p>
</main>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n - 1) + "…" : s;
}
