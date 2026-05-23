// Extension entry point. Wires up:
//   - the in-memory `TokenScanner` (lazy on first request, invalidated on
//     workspace changes and on relevant settings updates),
//   - a `HoverProvider` and a `CompletionItemProvider` for stylesheets,
//   - the **Library** sidebar webview (Token Flow activity-bar entry),
//   - hardcoded-value diagnostics + Replace-with-token quick-fix,
//   - convenience commands.
//
// Library + Hardcoded panel + Analyse dashboard are all webviews so the
// UI is richer (inline color swatches, embedded filters, etc.) than the
// previous TreeView could express. Each webview owns its own filter
// state and its own client bundle in `out/webview/<name>.js`.

import * as vscode from "vscode";
import { TokenScanner } from "./scanner/tokenScanner";
import { TokenHoverProvider } from "./providers/hoverProvider";
import { TokenCompletionProvider } from "./providers/completionProvider";
import { HardcodedDiagnostics } from "./providers/hardcodedDiagnostics";
import { HardcodedCodeActions } from "./providers/hardcodedCodeActions";
import { TokenDefinitionProvider } from "./providers/tokenDefinitionProvider";
import { TokenDropEditProvider } from "./providers/tokenDropProvider";
import { LibraryWebviewProvider } from "./views/libraryWebviewProvider";
import { HardcodedWebviewProvider } from "./views/hardcodedWebviewProvider";
import { openAnalyse } from "./views/analyseWebviewPanel";
import { openSettingsPanel } from "./views/settingsWebviewPanel";
import { createScopeStatusBar } from "./views/scopeStatusBar";
import { showAlternatives } from "./actions/showAlternatives";
import { registerAlternativesCompletion } from "./views/alternativesCompletion";
import { ActiveScopeTracker } from "./services/activeScopeTracker";
import { DesignToken } from "./model/designToken";
import { DynamicCssVarIndex } from "./scanner/dynamicCssVarIndex";

export function activate(context: vscode.ExtensionContext): void {
  const scanner = new TokenScanner();
  const dynamicCssVarIndex = new DynamicCssVarIndex();
  context.subscriptions.push(dynamicCssVarIndex);
  // The scope tracker is the single source of truth for "which scopes
  // are visible from the active editor?". It listens to active-editor
  // and settings changes and only fires `onDidChange` when the
  // resolved set actually moves — every downstream consumer subscribes
  // and re-filters in place. The token index itself doesn't need to
  // re-scan: scope membership lives on the token, only the read-time
  // filter changes.
  const scopeTracker = new ActiveScopeTracker();
  context.subscriptions.push(scopeTracker);

  // ─── Hover + completion ───────────────────────────────────────────────
  const stylesheetSelector: vscode.DocumentSelector = [
    { language: "scss", scheme: "file" },
    { language: "sass", scheme: "file" },
    { language: "css", scheme: "file" },
    { language: "less", scheme: "file" },
  ];
  // Go-to-Definition surface — same language set as Alt+T, since the
  // user expects to navigate from any file that can reference a
  // token. TS/JS/JSON join in to support `'{a.b.c}'` aliases and
  // `colors.PRIMARY_500` property accesses inside theme files.
  const definitionSelector: vscode.DocumentSelector = [
    ...(stylesheetSelector as { language: string; scheme: string }[]),
    { language: "typescript", scheme: "file" },
    { language: "typescriptreact", scheme: "file" },
    { language: "javascript", scheme: "file" },
    { language: "javascriptreact", scheme: "file" },
    { language: "json", scheme: "file" },
    { language: "jsonc", scheme: "file" },
  ];
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      stylesheetSelector,
      new TokenHoverProvider(scanner, scopeTracker),
    ),
    // Native "Go to Definition" — Ctrl+Click / Cmd+Click / F12 /
    // Ctrl+Shift+Click (Open to the Side) / Peek on a token reference
    // jumps to its declaration. Scope-aware: a name shared across
    // catalogues only jumps within the active scope.
    vscode.languages.registerDefinitionProvider(
      definitionSelector,
      new TokenDefinitionProvider(scanner, scopeTracker),
    ),
    // Drop-edit provider — rewrites Style-Dictionary alias drops
    // (`'{a.b.c}'`) inside backticked template literals to the
    // PrimeUIX-style `${dt('a.b.c')}` call interpolation. Falls
    // through silently outside templates, so plain JS object drops
    // keep their original payload.
    vscode.languages.registerDocumentDropEditProvider(
      [
        { language: "typescript", scheme: "file" },
        { language: "typescriptreact", scheme: "file" },
        { language: "javascript", scheme: "file" },
        { language: "javascriptreact", scheme: "file" },
      ],
      new TokenDropEditProvider(),
    ),
  );

  const completion = new TokenCompletionProvider(scanner, scopeTracker);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [
        { language: "scss", scheme: "file" },
        { language: "sass", scheme: "file" },
      ],
      completion,
      "$",
      "-",
    ),
    vscode.languages.registerCompletionItemProvider(
      [
        { language: "css", scheme: "file" },
        { language: "less", scheme: "file" },
      ],
      completion,
      "(",
      "-",
    ),
  );

  // ─── Hardcoded-value diagnostics + quick-fix ──────────────────────────
  const hardcoded = new HardcodedDiagnostics(scanner, scopeTracker);
  context.subscriptions.push(hardcoded);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      stylesheetSelector,
      new HardcodedCodeActions(),
      { providedCodeActionKinds: HardcodedCodeActions.kinds },
    ),
  );

  // ─── Library webview ──────────────────────────────────────────────────
  // The provider owns the filter state (in-memory, resets on reload —
  // same UX rule as a native TreeView filter) and surfaces it via
  // `isFilterActive` / `describeFilter()` so the title-bar context key
  // and the "Clear Filters" button stay in sync.
  const library = new LibraryWebviewProvider(
    scanner,
    context.extensionUri,
    scopeTracker,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LibraryWebviewProvider.viewType,
      library,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  library.onDidChangeFilter(() => {
    void vscode.commands.executeCommand(
      "setContext",
      "tokenFlow.library.hasFilters",
      library.isFilterActive,
    );
  });

  // ─── Hardcoded webview ────────────────────────────────────────────────
  // Workspace-wide aggregator; refreshes itself on scanner.onDidChange
  // (already wired inside the provider). retainContextWhenHidden lets
  // users toggle the panel without losing the last scan result.
  const hardcodedView = new HardcodedWebviewProvider(
    scanner,
    context.extensionUri,
    scopeTracker,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HardcodedWebviewProvider.viewType,
      hardcodedView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ─── Index invalidation ───────────────────────────────────────────────
  // Glob covers every file type the scanner can ingest. JS/TS/JSON join
  // the watch list here in Phase 1 so the index re-runs the moment a
  // token catalogue file changes, even though their parser modules are
  // still no-ops — they'll start emitting tokens in Phase 2 without any
  // additional wiring on this side.
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json}",
  );
  watcher.onDidChange(() => scanner.invalidate());
  watcher.onDidCreate(() => scanner.invalidate());
  watcher.onDidDelete(() => scanner.invalidate());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tokenFlow")) scanner.invalidate();
    }),
  );

  // ─── Commands ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenFlow.refreshIndex", async () => {
      scanner.invalidate();
      const tokens = await scanner.scan();
      vscode.window.showInformationMessage(
        `Token Flow: indexed ${tokens.length} tokens.`,
      );
    }),

    vscode.commands.registerCommand("tokenFlow.showAllTokens", async () => {
      const tokens = await scanner.scan();
      const items = tokens.map((t) => ({
        label: t.name,
        description: t.resolvedValue,
        detail: `${t.category.toLowerCase()} · ${t.variants.length} variants`,
        token: t,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a token to jump to its declaration",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) await revealToken(pick.token);
    }),

    // Hidden — used by the webview when a token row is clicked.
    vscode.commands.registerCommand(
      "tokenFlow.revealDeclaration",
      async (token: DesignToken) => {
        if (!token?.filePath) return;
        await revealToken(token);
      },
    ),

    // Alt+T — Quick Pick of sibling tokens (caret-driven).
    vscode.commands.registerCommand("tokenFlow.showAlternatives", () =>
      showAlternatives(scanner, dynamicCssVarIndex, scopeTracker, context),
    ),

    // Wires the native-suggest variant of the Alt+T picker. Idle when
    // the user is on the webview style — the provider only emits items
    // while `openAlternativesAsCompletion` is in flight.
    registerAlternativesCompletion(context),

    // Hidden — surfaced by the Library webview's "Show alternatives"
    // row-hover button (not yet wired in the v1 UI; reserved). The
    // implementation runs the same picker as the keybinding-driven
    // command, but starts from a known token name rather than the
    // caret position.
    vscode.commands.registerCommand(
      "tokenFlow.showAlternativesForToken",
      async (_name: string) => {
        // Until row-level alternative buttons land, defer to the
        // caret-driven flow so users still get something useful.
        await showAlternatives(scanner, dynamicCssVarIndex, scopeTracker, context);
      },
    ),

    // Surfaced as the only Library title-bar button (besides Refresh).
    // The webview owns its own search field + chip filters; this is
    // a one-click escape hatch back to the unfiltered view.
    vscode.commands.registerCommand("tokenFlow.clearFilters", () => {
      library.clearFilters();
    }),

    // Hardcoded view title-bar refresh button — a manual nudge in case
    // a workspace-wide rescan is needed (we already re-aggregate on
    // scanner.onDidChange, but the panel doesn't observe every file
    // mutation directly).
    vscode.commands.registerCommand("tokenFlow.refreshHardcoded", () =>
      hardcodedView.refresh(),
    ),

    // Open (or focus) the Analyse dashboard tab — surfaced as the first
    // title-bar button on the Library view AND in the command palette.
    vscode.commands.registerCommand("tokenFlow.openAnalyse", () =>
      openAnalyse(scanner, dynamicCssVarIndex, context.extensionUri),
    ),

    // Status-bar click target — opens the dedicated Settings webview
    // with a master-detail editor for scopes (sources / whitelist /
    // excludes) and native file pickers. Saves to workspace settings
    // so the User-vs-Workspace toggle of the built-in settings UI is
    // sidestepped entirely.
    vscode.commands.registerCommand("tokenFlow.openSettings", () =>
      openSettingsPanel(context.extensionUri),
    ),
  );

  // ─── Status bar ───────────────────────────────────────────────────────
  createScopeStatusBar(scopeTracker, context);
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

export function deactivate(): void {
  // Nothing to clean up beyond what `context.subscriptions` already disposes.
}
