// Webview-based Hardcoded-values panel — **scoped to the active
// editor**. Mirrors the IntelliJ tool window behaviour: when the user
// jumps between files the panel follows along, so they can see what
// needs cleaning up in the file they're currently looking at without
// being drowned in workspace-wide noise. The Analyse dashboard keeps
// the global view for high-level reporting.
//
// Re-runs on:
//   • active editor change (window.onDidChangeActiveTextEditor)
//   • document edits in the active editor (debounced)
//   • token index invalidation (`scanner.onDidChange`)

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { aggregateHardcodedInDocument } from "../scanner/hardcodedAggregator";
import {
  HardcodedClientMessage,
  HardcodedHostMessage,
  WireHardcodedEdit,
} from "../webview/shared/protocol";
import { buildWebviewHtml } from "./webviewHtml";
import {
  ActiveScopeTracker,
  TOKEN_RELEVANT_LANGUAGES,
} from "../services/activeScopeTracker";
import {
  adjustReplacementForContext,
  expandRangeForJsQuotes,
} from "../scanner/replacementContext";

const DEBOUNCE_MS = 250;
// Reuse the centralised language set so the panel covers every file
// type the scanner can ingest. JS/TS/JSON join scss/sass/css/less —
// catalogue files are excluded at the literal-finder level via
// `isTokenDeclarationValue` so a token's own declaration isn't
// flagged as a hardcoded usage of itself.
const SUPPORTED_LANGUAGES = TOKEN_RELEVANT_LANGUAGES;

export class HardcodedWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tokenFlow.hardcoded";

  private view: vscode.WebviewView | null = null;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly scanner: TokenScanner,
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ActiveScopeTracker,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const active = vscode.window.activeTextEditor;
        if (active && e.document === active.document) this.schedule();
      }),
      scanner.onDidChange(() => this.schedule()),
      // Re-scan on scope changes so the panel's candidate filter
      // follows the editor's scope without waiting for the next edit.
      this.scopes.onDidChange(() => this.schedule()),
    );
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) d.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")],
    };
    view.webview.html = buildWebviewHtml({
      name: "hardcoded",
      title: "Token Flow — Hardcoded values",
      webview: view.webview,
      extensionUri: this.extensionUri,
      bodyHtml: skeletonHtml(),
    });
    view.webview.onDidReceiveMessage((msg: HardcodedClientMessage) =>
      this.handleClientMessage(msg),
    );
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  // ─── Inbound ────────────────────────────────────────────────────────

  private async handleClientMessage(msg: HardcodedClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.runScan();
        return;
      case "reveal":
        await openAtLine(msg.relPath, msg.line);
        return;
      case "apply":
        await applyReplacement(msg);
        // Trigger a rescan so the panel updates without the user
        // having to refresh manually (the literal just got replaced
        // by `var(--token)`, so its row should disappear).
        this.schedule();
        return;
      case "applyBatch":
        await applyReplacementBatch(msg.edits);
        this.schedule();
        return;
    }
  }

  // ─── Scan scheduling ────────────────────────────────────────────────

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runScan();
    }, DEBOUNCE_MS);
  }

  private async runScan(): Promise<void> {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
      this.send({ type: "noActiveStylesheet" });
      return;
    }
    this.send({ type: "scanning", scanning: true });
    const matches = await aggregateHardcodedInDocument(
      this.scanner,
      editor.document,
      this.scopes.activeNames(),
    );
    this.send({
      type: "matches",
      relPath: workspaceRelative(editor.document.uri),
      matches,
      scanning: false,
    });
  }

  /** Used by the title-bar Refresh button to force a re-scan. */
  async refresh(): Promise<void> {
    await this.runScan();
  }

  private send(msg: HardcodedHostMessage): void {
    void this.view?.webview.postMessage(msg);
  }
}

// ─── Edit application ───────────────────────────────────────────────────

async function applyReplacement(msg: {
  relPath: string;
  replaceStart: number;
  replaceEndExclusive: number;
  replacement: string;
}): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, msg.relPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preserveFocus: true,
    preview: false,
  });
  const range = new vscode.Range(
    doc.positionAt(msg.replaceStart),
    doc.positionAt(msg.replaceEndExclusive),
  );
  const adjustedRange = expandRangeForJsQuotes(doc, range);
  // The replacement text itself may need adjusting too — inside a
  // CSS-in-JS backticked template the Style-Dictionary alias
  // `'{path}'` isn't valid CSS; rewrite to `${dt('path')}`.
  const adjustedText = adjustReplacementForContext(
    doc,
    adjustedRange,
    msg.replacement,
  );
  await editor.edit((b) => b.replace(adjustedRange, adjustedText));
}

/**
 * Applies N edits atomically via a single `WorkspaceEdit`. VSCode
 * computes each edit against the ORIGINAL document offsets so we can
 * pass them in any order — as long as ranges don't overlap, which is
 * guaranteed here (each hardcoded match owns a disjoint literal span).
 * Falls back to single-edit semantics when the batch is empty or has
 * only one entry, so we don't pay the WorkspaceEdit cost when the user
 * effectively did a single apply.
 */
async function applyReplacementBatch(
  edits: readonly WireHardcodedEdit[],
): Promise<void> {
  if (edits.length === 0) return;
  if (edits.length === 1) {
    await applyReplacement(edits[0]);
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;

  // Group by relPath so we open each document once and assemble its
  // TextEdit array in one shot. In the active-editor panel everything
  // is in the same file, but grouping is cheap and future-proofs us
  // for a workspace-wide variant.
  const grouped = new Map<string, WireHardcodedEdit[]>();
  for (const e of edits) {
    const list = grouped.get(e.relPath) ?? [];
    list.push(e);
    grouped.set(e.relPath, list);
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const [relPath, fileEdits] of grouped) {
    const uri = vscode.Uri.joinPath(root, relPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    for (const e of fileEdits) {
      const range = new vscode.Range(
        doc.positionAt(e.replaceStart),
        doc.positionAt(e.replaceEndExclusive),
      );
      const adjustedRange = expandRangeForJsQuotes(doc, range);
      const adjustedText = adjustReplacementForContext(
        doc,
        adjustedRange,
        e.replacement,
      );
      workspaceEdit.replace(uri, adjustedRange, adjustedText);
    }
  }
  await vscode.workspace.applyEdit(workspaceEdit);
}

async function openAtLine(relPath: string, line: number): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, relPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function workspaceRelative(uri: vscode.Uri): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return uri.path;
  const rootPath = root.path.endsWith("/") ? root.path : root.path + "/";
  return uri.path.startsWith(rootPath)
    ? uri.path.substring(rootPath.length)
    : uri.path;
}

function skeletonHtml(): string {
  // Header layout mirrors the Library panel: title strip on top, a
  // search-input + filter-icon row below. Filter button opens a small
  // dropdown panel with the kind chips. A select-all checkbox sits on
  // the left of the search row when matches are present.
  // The bulk footer is rendered absolutely-positioned and only
  // becomes visible when at least one row is checked.
  return /* html */ `
<header class="hardcoded-header">
  <div class="hardcoded-header__top">
    <h2 id="hardcoded-title">Hardcoded values</h2>
    <button id="hardcoded-refresh" type="button" class="ghost-btn" title="Re-scan the active file">Refresh</button>
  </div>
  <div class="hardcoded-header__row">
    <label id="hardcoded-select-all-wrap" class="select-all" title="Select all visible rows" hidden>
      <input id="hardcoded-select-all" type="checkbox">
    </label>
    <input id="hardcoded-search" type="search" placeholder="Search by literal or token name…" autocomplete="off">
    <div class="filter-wrap">
      <button id="hardcoded-filter-btn" class="filter-btn" type="button" title="Filter by kind" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z"/></svg>
        <span id="hardcoded-filter-count" class="filter-btn__count" hidden>0</span>
      </button>
      <div id="hardcoded-filter-panel" class="filter-panel" hidden role="dialog" aria-label="Filter hardcoded values">
        <div class="filter-panel__section">
          <h4 class="filter-panel__title">Kinds</h4>
          <div id="hardcoded-kind-chips" class="chips"></div>
        </div>
      </div>
    </div>
  </div>
</header>
<main id="hardcoded-body">
  <p class="hardcoded-empty">Open a stylesheet file to see its hardcoded values.</p>
</main>
<footer id="hardcoded-bulk-bar" class="bulk-bar" hidden>
  <span id="hardcoded-bulk-count" class="bulk-bar__count">0 selected</span>
  <span class="bulk-bar__spacer"></span>
  <button id="hardcoded-bulk-clear" type="button" class="ghost-btn">Clear</button>
  <button id="hardcoded-bulk-apply" type="button" class="primary-btn">Apply selected</button>
</footer>`;
}

// We need to update analyseWebviewPanel.ts (workspace-wide call) — keep
// the import path stable by re-exporting the workspace-wide aggregator
// from this provider's neighbouring module. The Analyse panel imports
// `aggregateHardcodedAcrossWorkspace` directly from `scanner/hardcodedAggregator`,
// so no change needed here.
