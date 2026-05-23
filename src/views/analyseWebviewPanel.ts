// Analyse dashboard. Full-tab WebviewPanel (not a sidebar view) because
// the report needs horizontal real estate: gauge + sub-score grid,
// followed by collapsible accordion sections for hardcoded clusters,
// broken references, unused tokens, duplicates, semantic incoherences
// and per-source coverage.
//
// Opened via the `tokenFlow.openAnalyse` command. The panel is a
// **singleton** within a workspace — re-running the command on an
// already-open panel just reveals it, instead of opening a duplicate.

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import {
  AnalysisReport,
  analyzeDesignSystem,
  BrokenReference,
  DuplicateCluster,
  HardcodedCluster,
  Incoherence,
  TokenSourceUsage,
} from "../scanner/designSystemAnalyzer";
import { DesignToken } from "../model/designToken";
import { readScopes } from "../settings/scopes";
import {
  AnalyseClientMessage,
  AnalyseHostMessage,
  WireAnalysisReport,
  WireBrokenReference,
  WireDuplicateCluster,
  WireHardcodedCluster,
  WireIncoherence,
  WireScopeOption,
  WireScopeState,
  WireTokenLocation,
  WireTokenSourceUsage,
} from "../webview/shared/protocol";
import { buildWebviewHtml } from "./webviewHtml";

let currentPanel: AnalysePanel | null = null;

/**
 * Singleton-aware launcher. Re-uses an existing panel when one is
 * already open in the same window — same UX as VSCode's built-in
 * "Open Walkthrough" entries.
 */
export function openAnalyse(
  scanner: TokenScanner,
  extensionUri: vscode.Uri,
): void {
  if (currentPanel) {
    try {
      currentPanel.reveal();
      void currentPanel.refresh();
    } catch {
      // The stored panel is no longer alive (e.g. its tab was closed
      // without `onDidDispose` clearing the singleton for some reason).
      // Drop it and fall through to construct a fresh one.
      currentPanel = null;
    }
    if (currentPanel) return;
  }
  try {
    currentPanel = new AnalysePanel(scanner, extensionUri);
  } catch (err) {
    // Any failure during construction (HTML build, listener wiring,
    // file-watcher creation, …) would otherwise leave the user with
    // nothing happening on click — surface the error so they can
    // report it instead of staring at a silent failure.
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Token Flow: failed to open Analyse — ${msg}`);
    console.error("Token Flow: AnalysePanel construction failed", err);
  }
}

/** Default selection — re-resolved per refresh. */
const SCOPE_ALL = "all";
const SCOPE_ACTIVE = "active";
const SCOPE_PREFIX = "scope:";

class AnalysePanel {
  private readonly panel: vscode.WebviewPanel;
  /**
   * Currently-selected scope option id. Starts as "active" so the panel
   * mirrors the IntelliJ default (pick the deepest scope containing the
   * editor's file when one is open).
   */
  private selectedScopeId: string = SCOPE_ACTIVE;
  /**
   * Paths the last report depends on (broken-ref locations + token
   * source files). When any of these change on disk the panel surfaces
   * a "stale" banner rather than auto-rerunning — same as IntelliJ.
   * Empty until the first analysis lands.
   */
  private watchedPaths = new Set<string>();
  private hasReport = false;

  constructor(
    private readonly scanner: TokenScanner,
    extensionUri: vscode.Uri,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "tokenFlow.analyse",
      "Token Flow — Analyse",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      },
    );
    this.panel.webview.html = buildWebviewHtml({
      name: "analyse",
      title: "Token Flow — Analyse",
      webview: this.panel.webview,
      extensionUri,
      bodyHtml: skeletonHtml(),
    });
    this.panel.webview.onDidReceiveMessage((msg: AnalyseClientMessage) =>
      this.handleClientMessage(msg),
    );
    this.panel.onDidDispose(() => {
      currentPanel = null;
    });
    // IntelliJ parity: do NOT auto-refresh on every scanner / editor
    // tick. A full analysis is expensive — silently re-running it
    // while the user types is jarring and burns CPU. Instead, flip a
    // "stale" banner the next time something in the watched set
    // changes, and let the user click Re-run when ready.
    const scannerSub = scanner.onDidChange(() => this.markStale());
    this.panel.onDidDispose(() => scannerSub.dispose());

    // File-system watcher for project files — flips the banner when a
    // file the last report referenced is saved / created / deleted.
    // Best-effort: a failure here (no workspace, glob pattern not
    // supported by the host, …) shouldn't block the panel from opening.
    // The scanner.onDidChange subscription above already covers the
    // common "settings or tokens changed" case.
    try {
      const fsWatcher = vscode.workspace.createFileSystemWatcher(
        "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json,vue}",
      );
      fsWatcher.onDidChange((uri) => this.maybeMarkStale(uri));
      fsWatcher.onDidCreate((uri) => this.maybeMarkStale(uri));
      fsWatcher.onDidDelete((uri) => this.maybeMarkStale(uri));
      this.panel.onDidDispose(() => fsWatcher.dispose());
    } catch (err) {
      console.warn("Token Flow: file-system watcher init failed", err);
    }

    // Rebuild the scope combo when the active editor moves so the
    // "Active editor (filename)" entry stays accurate. This is a
    // cheap state-only push — no analysis re-runs.
    const editorSub = vscode.window.onDidChangeActiveTextEditor(() => {
      void this.pushScopeState();
    });
    this.panel.onDidDispose(() => editorSub.dispose());
  }

  private maybeMarkStale(uri: vscode.Uri): void {
    if (!this.hasReport) return;
    if (this.watchedPaths.has(uri.fsPath) || this.watchedPaths.has(uri.path)) {
      this.markStale();
    }
  }

  private markStale(): void {
    if (!this.hasReport) return;
    this.send({ type: "stale", stale: true });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  async refresh(): Promise<void> {
    const scopeState = this.buildScopeState();
    this.send({ type: "analysing", scope: scopeState });
    const scopeFile = this.resolveScopeFile();
    const scopeLabel =
      scopeState.options.find((o) => o.id === scopeState.selectedId)?.label ??
      "All project";
    const report = await analyzeDesignSystem(this.scanner, { scopeFile });
    this.rebuildWatchedPaths(report);
    this.hasReport = true;
    this.send({
      type: "report",
      report: toWireReport(report, scopeLabel),
      scope: scopeState,
    });
  }

  private rebuildWatchedPaths(report: AnalysisReport): void {
    this.watchedPaths.clear();
    for (const b of report.brokenReferences) this.watchedPaths.add(b.filePath);
    for (const s of report.coverage.sources) this.watchedPaths.add(s.filePath);
  }

  /**
   * Lighter than `refresh()`: silently updates the scope picker without
   * touching the rendered report. Used when the active editor changes so
   * the "Active editor (filename)" label tracks the new file.
   */
  private async pushScopeState(): Promise<void> {
    this.send({ type: "scopeUpdate", scope: this.buildScopeState() });
  }

  private async handleClientMessage(msg: AnalyseClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refresh();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "selectScope":
        this.selectedScopeId = msg.id;
        await this.refresh();
        return;
      case "reveal":
        await revealAt(msg.relPath, msg.line ?? 0, msg.offset);
        return;
    }
  }

  /**
   * Builds the scope picker model. Mirrors `AnalyzePanel.rebuildScopeCombo`
   * from the IntelliJ side: always offers "All project", plus one entry
   * per configured non-common scope, plus "Active editor (filename)" when
   * an editor is open. Re-resolves the selection if the previously chosen
   * option no longer exists.
   */
  private buildScopeState(): WireScopeState {
    const scopes = readScopes();
    const namedScopes = scopes.filter((s) => !s.isCommon);
    const options: WireScopeOption[] = [{ id: SCOPE_ALL, label: "All project" }];
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
      options.push({
        id: SCOPE_ACTIVE,
        label: `Active editor (${basenameOf(activeFile)})`,
      });
    }
    for (const s of namedScopes) {
      options.push({
        id: SCOPE_PREFIX + s.name,
        label: `Scope: ${s.name || "(unnamed)"}`,
      });
    }
    // Fall back to "All project" if the previously picked option is gone
    // (e.g. user removed the scope, or closed the editor while "Active
    // editor" was selected).
    let selectedId = this.selectedScopeId;
    if (!options.some((o) => o.id === selectedId)) {
      selectedId = SCOPE_ALL;
      this.selectedScopeId = selectedId;
    }
    return { options, selectedId };
  }

  /**
   * Resolves the picker selection to a file path the analyser can use.
   * Returns `null` for the "all project" sentinel.
   *   • SCOPE_ALL      → null
   *   • SCOPE_ACTIVE   → active editor's fsPath (or null when none)
   *   • SCOPE_PREFIX… → first file under the scope's rootPath
   */
  private resolveScopeFile(): string | null {
    const id = this.selectedScopeId;
    if (id === SCOPE_ALL) return null;
    if (id === SCOPE_ACTIVE) {
      return vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
    }
    if (id.startsWith(SCOPE_PREFIX)) {
      const name = id.substring(SCOPE_PREFIX.length);
      const scope = readScopes().find((s) => s.name === name) ?? null;
      if (!scope) return null;
      // The analyser only needs a path that lands inside the scope's
      // root for `activeScopesFor` to pick it. Building rootPath +
      // "/.token-flow-anchor" is enough — the file doesn't need to
      // exist on disk; the resolver does prefix matches on strings.
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root || !scope.rootPath) return null;
      return `${root.replace(/\/$/, "")}/${scope.rootPath.replace(/^\//, "")}/.token-flow-anchor`;
    }
    return null;
  }

  private send(msg: AnalyseHostMessage): void {
    void this.panel.webview.postMessage(msg);
  }
}

// ─── Wire conversion ────────────────────────────────────────────────────

function toWireReport(
  report: AnalysisReport,
  scopeLabel: string,
): WireAnalysisReport {
  const rootPath = workspaceRootPath();
  return {
    score: report.score,
    grade: report.grade,
    subScores: report.subScores.map((s) => ({ ...s })),
    incoherences: report.incoherences.map((i) => toWireIncoherence(i, rootPath)),
    duplicateClusters: report.duplicateClusters.map((d) =>
      toWireDuplicate(d, rootPath),
    ),
    hardcodedClusters: report.hardcodedClusters.map((c) =>
      toWireHardcoded(c, rootPath),
    ),
    coverage: {
      tokenisedAssignments: report.coverage.tokenisedAssignments,
      literalAssignments: report.coverage.literalAssignments,
      ratio: report.coverage.ratio,
      sources: report.coverage.sources.map((s) =>
        toWireSourceUsage(s, rootPath),
      ),
    },
    brokenReferences: report.brokenReferences.map((b) =>
      toWireBroken(b, rootPath),
    ),
    unusedTokens: report.unusedTokens.map((t) => toWireLocation(t, rootPath)),
    totalTokens: report.totalTokens,
    scannedFiles: report.scannedFiles,
    tookMs: report.tookMs,
    scopeLabel,
  };
}

function toWireLocation(token: DesignToken, rootPath: string | null): WireTokenLocation {
  const relPath = makeRelative(token.filePath, rootPath);
  return {
    name: token.name,
    resolvedValue: token.resolvedValue,
    category: token.category,
    relPath,
    basename: basenameOf(relPath),
    offset: token.offset,
    line: 0,
  };
}

function toWireIncoherence(
  i: Incoherence,
  rootPath: string | null,
): WireIncoherence {
  return {
    token: toWireLocation(i.token, rootPath),
    rationale: i.rationale,
  };
}

function toWireDuplicate(
  d: DuplicateCluster,
  rootPath: string | null,
): WireDuplicateCluster {
  return {
    resolvedValue: d.resolvedValue,
    category: d.category,
    canonical: toWireLocation(d.suggestedCanonical, rootPath),
    tokens: d.tokens.map((t) => toWireLocation(t, rootPath)),
  };
}

function toWireHardcoded(
  c: HardcodedCluster,
  rootPath: string | null,
): WireHardcodedCluster {
  return {
    literal: c.literal,
    category: c.category,
    matchingTokenName: c.matchingTokenName,
    occurrences: c.occurrences.map((o) => {
      const relPath = makeRelative(o.filePath, rootPath);
      return {
        relPath,
        basename: basenameOf(relPath),
        parent: parentNameOf(relPath),
        offset: o.offset,
        line: o.line,
      };
    }),
  };
}

function toWireBroken(
  b: BrokenReference,
  rootPath: string | null,
): WireBrokenReference {
  const relPath = makeRelative(b.filePath, rootPath);
  return {
    name: b.name,
    relPath,
    basename: basenameOf(relPath),
    offset: b.offset,
    line: b.line,
  };
}

function toWireSourceUsage(
  s: TokenSourceUsage,
  rootPath: string | null,
): WireTokenSourceUsage {
  const relPath = makeRelative(s.filePath, rootPath);
  return {
    relPath,
    basename: basenameOf(relPath),
    declared: s.declared,
    used: s.used,
    ratio: s.ratio,
  };
}

// ─── Path helpers ───────────────────────────────────────────────────────

function workspaceRootPath(): string | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.path;
  if (!root) return null;
  return root.endsWith("/") ? root : root + "/";
}

function makeRelative(abs: string, rootPath: string | null): string {
  if (!rootPath) return abs;
  return abs.startsWith(rootPath) ? abs.substring(rootPath.length) : abs;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.substring(slash + 1) : path;
}

function parentNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "";
  const head = path.substring(0, slash);
  const prev = head.lastIndexOf("/");
  return prev >= 0 ? head.substring(prev + 1) : head;
}

// ─── Reveal ─────────────────────────────────────────────────────────────

async function revealAt(
  relPath: string,
  line: number,
  offset?: number,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, relPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const pos =
    offset != null ? doc.positionAt(offset) : new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

function skeletonHtml(): string {
  return /* html */ `
<div id="analyse-root">
  <p class="analyse-empty">Aggregating workspace data…</p>
</div>`;
}
