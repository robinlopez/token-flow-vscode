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
import {
  copyTokenValue,
  copyText,
  copyValueEnabled,
  findTokenAtCursor,
} from "./actions/copyTokenValue";
import { registerAlternativesCompletion } from "./views/alternativesCompletion";
import { ActiveScopeTracker } from "./services/activeScopeTracker";
import { DesignToken } from "./model/designToken";
import { DynamicCssVarIndex } from "./scanner/dynamicCssVarIndex";
import { readScopes } from "./settings/scopes";

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
  // The watcher used to fire on every `.ts/.tsx/.js/.jsx` save anywhere
  // in the workspace — under the assumption that token files might live
  // there. On a real React/TS project that meant a full re-scan on every
  // component save, which is the documented cause of the
  // 98%-CPU-extension-host freezes (see the "UNRESPONSIVE extension
  // host" log lines in v0.1.2).
  //
  // We now split the watching into two layers:
  //   • Stylesheets — always watched broadly. Stylesheet files are
  //     typically far less numerous than TS files, and token
  //     declarations there can live anywhere (legacy code, app-level
  //     overrides, theme partials). Cost stays bounded.
  //   • JS/TS/JSON — watched ONLY inside the file sets each configured
  //     scope claims via `sourcePaths` / `rootPath` / `whitelistPaths`.
  //     Saving an unrelated component file does NOT invalidate the
  //     token index. When no scope is configured (legacy implicit
  //     common scope), the watcher is wired to nothing — a manual
  //     "Refresh index" command still works.
  //
  // All invalidation paths go through a 300ms debouncer so a save-all
  // burst (formatter, multi-file refactor) collapses into one rescan.

  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleInvalidate = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanner.invalidate();
    }, 300);
  };

  const stylesheetWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{scss,sass,css,less}",
  );
  stylesheetWatcher.onDidChange(scheduleInvalidate);
  stylesheetWatcher.onDidCreate(scheduleInvalidate);
  stylesheetWatcher.onDidDelete(scheduleInvalidate);
  context.subscriptions.push(stylesheetWatcher);

  // JS/TS/JSON watchers are rebuilt every time the scope config
  // changes, so they always reflect the active set of token-source
  // paths. Tracked here so we can dispose them before re-creating.
  let jsWatchers: vscode.Disposable[] = [];
  const rewireJsWatchers = (): void => {
    for (const w of jsWatchers) w.dispose();
    jsWatchers = [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const patterns = collectJsWatchPatterns(root);
    for (const pattern of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidChange(scheduleInvalidate);
      w.onDidCreate(scheduleInvalidate);
      w.onDidDelete(scheduleInvalidate);
      jsWatchers.push(w);
    }
  };
  rewireJsWatchers();
  context.subscriptions.push({
    dispose: () => {
      for (const w of jsWatchers) w.dispose();
    },
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("tokenFlow")) return;
      // Scope changes alter which JS/TS files we should be watching.
      // Rewire before invalidating so the next scan sees the new set.
      rewireJsWatchers();
      scheduleInvalidate();
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

    // Alt+V — Copy Token Value. Dropdown of resolved value + colour
    // alternates + token name for the reference under the caret.
    vscode.commands.registerCommand("tokenFlow.copyTokenValue", () =>
      copyTokenValue(scanner, scopeTracker),
    ),

    // Hidden — backs the hover copy links. Args carry a single string:
    // the text to put on the clipboard.
    vscode.commands.registerCommand(
      "tokenFlow.copyText",
      async (value: unknown) => {
        if (typeof value === "string") await copyText(value);
      },
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

  // ─── Copy Token Value — `onTokenReference` context key ────────────────
  // Drives the `Alt+V` keybinding + editor context-menu entry: both are
  // gated on `tokenFlow.onTokenReference` so they stay inert outside a
  // copyable token (and don't shadow `alt+v` elsewhere). The check is
  // debounced and scan-backed — the key only flips true when a reference
  // under the caret resolves to a real token in the active scope, so the
  // menu item never appears on an arbitrary `a.b.c` property access.
  const COPY_LANGS = new Set([
    "scss",
    "sass",
    "css",
    "less",
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
    "json",
    "jsonc",
  ]);
  let ctxTimer: NodeJS.Timeout | null = null;
  const refreshOnTokenReference = (): void => {
    if (ctxTimer) clearTimeout(ctxTimer);
    ctxTimer = setTimeout(async () => {
      ctxTimer = null;
      const editor = vscode.window.activeTextEditor;
      let on = false;
      if (
        editor &&
        copyValueEnabled() &&
        COPY_LANGS.has(editor.document.languageId)
      ) {
        on = (await findTokenAtCursor(editor, scanner, scopeTracker)) !== null;
      }
      void vscode.commands.executeCommand(
        "setContext",
        "tokenFlow.onTokenReference",
        on,
      );
    }, 200);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(refreshOnTokenReference),
    vscode.window.onDidChangeActiveTextEditor(refreshOnTokenReference),
    { dispose: () => ctxTimer && clearTimeout(ctxTimer) },
  );
  refreshOnTokenReference();

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

/**
 * Builds the list of `RelativePattern`s the JS/TS/JSON watcher should
 * cover, derived from every configured scope's `sourcePaths`,
 * `rootPath` and `whitelistPaths`.
 *
 * A scope-less workspace (or one whose paths point only at .scss
 * directories) yields zero patterns — the stylesheet watcher handles
 * those, and JS files in unconfigured scopes aren't token sources to
 * begin with.
 *
 * Each path resolves to a file-or-directory entry. Directories use the
 * recursive `**\/*.{ts,tsx,js,jsx,mjs,cjs,json}` glob; individual files
 * use a literal-name pattern so renaming or deleting the file still
 * fires `onDidDelete`.
 */
function collectJsWatchPatterns(root: vscode.Uri): vscode.RelativePattern[] {
  const JS_EXTS = "{ts,tsx,js,jsx,mjs,cjs,json}";
  const patterns: vscode.RelativePattern[] = [];
  const seen = new Set<string>();
  const addDir = (rel: string): void => {
    const key = `dir:${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    const base = rel.trim() ? vscode.Uri.joinPath(root, rel) : root;
    patterns.push(new vscode.RelativePattern(base, `**/*.${JS_EXTS}`));
  };
  const addPath = (rel: string): void => {
    const cleaned = rel.replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    // We can't synchronously stat here (this function is called from
    // configuration-change listeners) — pessimistically register BOTH
    // a directory recursive pattern AND a literal-name pattern. The
    // VSCode FS-watcher dedupes events naturally so this only costs
    // an extra watch descriptor on the OS side.
    addDir(cleaned);
    const dirKey = `file:${cleaned}`;
    if (!seen.has(dirKey)) {
      seen.add(dirKey);
      // Only emits when the exact filename appears under root —
      // covers the case where a sourcePath points at a single file.
      const idx = cleaned.lastIndexOf("/");
      const parent = idx >= 0 ? cleaned.substring(0, idx) : "";
      const name = idx >= 0 ? cleaned.substring(idx + 1) : cleaned;
      const base = parent ? vscode.Uri.joinPath(root, parent) : root;
      patterns.push(new vscode.RelativePattern(base, name));
    }
  };
  for (const scope of readScopes()) {
    for (const p of scope.sourcePaths) addPath(p);
    for (const p of scope.whitelistPaths) addPath(p);
    if (scope.rootPath) addDir(scope.rootPath);
  }
  return patterns;
}

export function deactivate(): void {
  // Nothing to clean up beyond what `context.subscriptions` already disposes.
}
