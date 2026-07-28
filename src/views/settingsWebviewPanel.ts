// Settings webview — the user-facing equivalent of the IntelliJ tool
// window's master-detail "Scopes" panel. Sidesteps VSCode's native
// settings UI entirely so the User-vs-Workspace toggle that confused
// the user disappears: everything we write here goes to **workspace
// settings**, which is the right target for project-specific scope
// configuration anyway.
//
// Architecture: a singleton `WebviewPanel` (full-tab) like the Analyse
// dashboard. The host owns the read/write loop against
// `vscode.workspace.getConfiguration("tokenFlow").update("scopes",
// ConfigurationTarget.Workspace)`. The client is purely declarative
// — receives the current scopes snapshot, emits user-driven actions.
//
// File pickers (root path, sources, whitelist, excludes) can't be
// opened from the webview iframe — the client posts a `pickRootPath`
// or `addPath` message; the host opens `showOpenDialog`, computes
// workspace-relative paths and writes them back.

import * as vscode from "vscode";
import {
  ScopePathField,
  SettingsClientMessage,
  SettingsHostMessage,
  WirePreferences,
  WireScope,
} from "../webview/shared/protocol";
import {
  ConfiguredScope,
  readGlobalExternalPrefixes,
} from "../settings/scopes";
import {
  exportScopes as serialiseScopes,
  importScopes as parseScopes,
  ImportError,
  mergeScopes,
} from "../settings/scopeConfigIO";
import { buildWebviewHtml } from "./webviewHtml";
import { detectScopes } from "../settings/autoScopeDetector";

/**
 * A prefix is a variable-name *stem*, so it accepts everything a name
 * accepts minus the requirement to be complete: an optional `--` / `$`
 * sigil, then an identifier that may end on a dash (`--ui-slider-`).
 * Same pattern as `package.json`'s `tokenFlow.externalPrefixes` schema —
 * keep the two in sync.
 */
const PREFIX_RE = /^(--|\$)?[A-Za-z_][A-Za-z0-9_-]*$/;

/** Trims and validates a user-typed prefix; returns null when unusable. */
function normalisePrefix(raw: string): string | null {
  const value = raw.trim();
  return PREFIX_RE.test(value) ? value : null;
}

interface MutableScope {
  name: string;
  rootPath: string;
  sourcePaths: string[];
  whitelistPaths: string[];
  excludedPaths: string[];
  externalPrefixes: string[];
}

let currentPanel: SettingsPanel | null = null;

export function openSettingsPanel(extensionUri: vscode.Uri): void {
  if (currentPanel) {
    currentPanel.reveal();
    void currentPanel.refresh();
    return;
  }
  currentPanel = new SettingsPanel(extensionUri);
}

class SettingsPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Serialises settings writes so rapid clicks don't race. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "tokenFlow.settings",
      "Token Flow — Settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      },
    );
    this.panel.webview.html = buildWebviewHtml({
      name: "settings",
      title: "Token Flow — Settings",
      webview: this.panel.webview,
      extensionUri,
      bodyHtml: skeletonHtml(),
    });
    this.panel.webview.onDidReceiveMessage((msg: SettingsClientMessage) =>
      this.handleClientMessage(msg),
    );
    this.panel.onDidDispose(() => {
      currentPanel = null;
      for (const d of this.disposables) d.dispose();
    });
    // Auto-refresh when settings change from outside (e.g. user edits
    // settings.json directly, or another VSCode window writes to the
    // same workspace).
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("tokenFlow.scopes") ||
          e.affectsConfiguration("tokenFlow.sourcePaths") ||
          e.affectsConfiguration("tokenFlow.externalPrefixes") ||
          e.affectsConfiguration("tokenFlow.alternatives.pickerStyle") ||
          e.affectsConfiguration("tokenFlow.hover.enabled")
        ) {
          void this.refresh();
        }
      }),
    );
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  async refresh(): Promise<void> {
    this.send({
      type: "config",
      scopes: this.readScopesRaw(),
      preferences: this.readPreferences(),
      globalExternalPrefixes: [...readGlobalExternalPrefixes()],
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
      noWorkspace: !vscode.workspace.workspaceFolders?.length,
    });
  }

  // ─── Inbound ────────────────────────────────────────────────────────

  private async handleClientMessage(msg: SettingsClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refresh();
        return;
      case "addScope":
        await this.mutate((scopes) => {
          scopes.push({
            name: `scope-${scopes.length + 1}`,
            rootPath: "",
            sourcePaths: [],
            whitelistPaths: [],
            excludedPaths: [],
            externalPrefixes: [],
          });
        });
        return;
      case "exportScopes":
        await this.exportToFile();
        return;
      case "importScopes":
        await this.importFromFile();
        return;
      case "removeScope":
        await this.mutate((scopes) => {
          scopes.splice(msg.index, 1);
        });
        return;
      case "updateScopeField":
        await this.mutate((scopes) => {
          const s = scopes[msg.index];
          if (!s) return;
          if (msg.field === "name") s.name = msg.value;
          else s.rootPath = msg.value;
        });
        return;
      case "pickRootPath": {
        const picked = await this.pickFolder(
          "Select the root folder of this scope",
        );
        if (!picked) return;
        const rel = this.workspaceRelative(picked);
        await this.mutate((scopes) => {
          const s = scopes[msg.index];
          if (s) s.rootPath = rel;
        });
        return;
      }
      case "addPath": {
        const picked = await this.pickFilesOrFolders(msg.field);
        if (!picked || picked.length === 0) return;
        const rels = picked.map((u) => this.workspaceRelative(u));
        await this.mutate((scopes) => {
          const s = scopes[msg.index];
          if (!s) return;
          for (const rel of rels) {
            if (!s[msg.field].includes(rel)) s[msg.field].push(rel);
          }
        });
        return;
      }
      case "removePath":
        await this.mutate((scopes) => {
          const s = scopes[msg.index];
          if (!s) return;
          s[msg.field].splice(msg.pathIndex, 1);
        });
        return;
      case "addExternalPrefix": {
        const prefix = normalisePrefix(msg.value);
        if (!prefix) {
          vscode.window.showWarningMessage(
            "Token Flow: a prefix must look like a variable name — `--p-`, `--ui-slider-`, `$legacy-`.",
          );
          return;
        }
        if (msg.scopeIndex === null) {
          await this.writeGlobalPrefixes((list) => {
            if (!list.includes(prefix)) list.push(prefix);
          });
          return;
        }
        const scopeIndex = msg.scopeIndex;
        await this.mutate((scopes) => {
          const s = scopes[scopeIndex];
          if (!s) return;
          if (!s.externalPrefixes.includes(prefix)) {
            s.externalPrefixes.push(prefix);
          }
        });
        return;
      }
      case "removeExternalPrefix": {
        if (msg.scopeIndex === null) {
          await this.writeGlobalPrefixes((list) => {
            list.splice(msg.prefixIndex, 1);
          });
          return;
        }
        const scopeIndex = msg.scopeIndex;
        await this.mutate((scopes) => {
          const s = scopes[scopeIndex];
          if (!s) return;
          s.externalPrefixes.splice(msg.prefixIndex, 1);
        });
        return;
      }
      case "updatePreference":
        await this.writePreference(msg.key, msg.value);
        return;
      case "autoDetectScopes":
        await this.runAutoDetect();
        return;
      case "openKeybindings":
        // The `@ext:` query targets all commands contributed by our
        // extension id — same syntax as the search box in the Keyboard
        // Shortcuts editor. Keep it in sync with `package.json`'s
        // `publisher.name`: tokenFlow ships as `robinlopez.token-flow`.
        await vscode.commands.executeCommand(
          "workbench.action.openGlobalKeybindings",
          "@ext:robinlopez.token-flow",
        );
        return;
    }
  }

  // ─── Import / Export ─────────────────────────────────────────────────

  private async exportToFile(): Promise<void> {
    const scopes = this.readScopesAsConfigured();
    if (scopes.length === 0) {
      vscode.window.showWarningMessage(
        "Token Flow: there is no scope to export. Add one first.",
      );
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = ws
      ? vscode.Uri.joinPath(ws, "token-flow-scopes.json")
      : vscode.Uri.file("token-flow-scopes.json");
    const target = await vscode.window.showSaveDialog({
      title: "Export Token Flow Config",
      defaultUri,
      filters: { JSON: ["json"] },
    });
    if (!target) return;
    try {
      const json = serialiseScopes(scopes);
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
      vscode.window.showInformationMessage(
        `Token Flow: exported ${scopes.length} scope(s) to ${vscode.workspace.asRelativePath(target)}.`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        `Token Flow: could not write ${vscode.workspace.asRelativePath(target)}: ${(e as Error).message}`,
      );
    }
  }

  private async importFromFile(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picked = await vscode.window.showOpenDialog({
      title: "Import Token Flow Config",
      defaultUri: ws,
      canSelectMany: false,
      filters: { JSON: ["json"] },
    });
    if (!picked || picked.length === 0) return;
    const uri = picked[0];
    let incoming;
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      incoming = parseScopes(text);
    } catch (e) {
      const msg =
        e instanceof ImportError
          ? e.message
          : `Could not read ${vscode.workspace.asRelativePath(uri)}: ${(e as Error).message}`;
      vscode.window.showErrorMessage(`Token Flow: ${msg}`);
      return;
    }

    const current = this.readScopesAsConfigured();
    // When the user has no scopes yet there's no destructive choice to
    // make — just apply. Otherwise mirror the IntelliJ 3-button modal:
    // Replace / Merge / Cancel. Replace clears the current list; Merge
    // overwrites only scopes whose name matches (case-insensitive).
    let mode: "replace" | "merge" | "cancel";
    if (current.length === 0) {
      mode = "replace";
    } else {
      const choice = await vscode.window.showInformationMessage(
        `Found ${incoming.length} scope(s) in ${vscode.workspace.asRelativePath(uri)}. ` +
          `Replace clears the current list. Merge keeps existing scopes and overwrites only those whose name matches.`,
        { modal: true },
        "Replace",
        "Merge",
      );
      mode = choice === "Replace" ? "replace" : choice === "Merge" ? "merge" : "cancel";
    }
    if (mode === "cancel") return;
    const next = mode === "replace" ? incoming : mergeScopes(current, incoming);

    await this.mutate((scopes) => {
      scopes.length = 0;
      for (const s of next) {
        scopes.push({
          name: s.name,
          rootPath: s.rootPath,
          sourcePaths: [...s.sourcePaths],
          whitelistPaths: [...s.whitelistPaths],
          excludedPaths: [...s.excludedPaths],
          externalPrefixes: [...s.externalPrefixes],
        });
      }
    });
    vscode.window.showInformationMessage(
      `Token Flow: imported ${incoming.length} scope(s) from ${vscode.workspace.asRelativePath(uri)}.`,
    );
  }

  // ─── Auto-detect ─────────────────────────────────────────────────────

  /**
   * Heuristic scope detection. Always confirms via a modal before
   * touching settings — auto-detection is opinionated and the user must
   * know they're getting a "best effort" result they should review.
   * Merges by scope name (case-insensitive); never removes user scopes.
   */
  private async runAutoDetect(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) {
      this.send({ type: "autoDetectFailed", reason: "No workspace folder open." });
      return;
    }
    const confirm = await vscode.window.showInformationMessage(
      "Auto-scope detect",
      {
        modal: true,
        detail:
          "Token Flow will scan your workspace and add a scope per UI project " +
          "it finds (one per package.json with a frontend framework), pointing " +
          "at the design-token files inside.\n\n" +
          "Tip — a quick review of the result usually adds or removes a couple of " +
          "paths and noticeably sharpens later scans.",
      },
      "Run detection",
    );
    if (confirm !== "Run detection") {
      this.send({ type: "autoDetectFailed", reason: "Cancelled." });
      return;
    }

    let detected;
    try {
      detected = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Token Flow: detecting scopes…",
          cancellable: false,
        },
        () => detectScopes(ws),
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      vscode.window.showErrorMessage(`Token Flow: auto-detect failed — ${msg}`);
      this.send({ type: "autoDetectFailed", reason: msg });
      return;
    }

    if (detected.length === 0) {
      vscode.window.showInformationMessage(
        "Token Flow: no token files detected. Add a scope manually to point " +
          "at your design-tokens source.",
      );
      this.send({ type: "autoDetectResult", detected: 0, added: 0, merged: 0 });
      return;
    }

    let added = 0;
    let merged = 0;
    await this.mutate((scopes) => {
      for (const d of detected) {
        const existing = scopes.find(
          (s) => s.name.toLowerCase() === d.name.toLowerCase(),
        );
        if (existing) {
          for (const p of d.sourcePaths) {
            if (!existing.sourcePaths.includes(p)) existing.sourcePaths.push(p);
          }
          for (const p of d.excludedPaths) {
            if (!existing.excludedPaths.includes(p)) existing.excludedPaths.push(p);
          }
          // Only fill in rootPath when the user left it blank — never
          // override an explicit choice.
          if (!existing.rootPath && d.rootPath) existing.rootPath = d.rootPath;
          merged++;
        } else {
          scopes.push({
            name: d.name,
            rootPath: d.rootPath,
            sourcePaths: [...d.sourcePaths],
            whitelistPaths: [...d.whitelistPaths],
            excludedPaths: [...d.excludedPaths],
            externalPrefixes: [],
          });
          added++;
        }
      }
    });

    this.send({
      type: "autoDetectResult",
      detected: detected.length,
      added,
      merged,
    });
    vscode.window.showInformationMessage(
      `Token Flow: detected ${detected.length} scope(s) — ${added} added, ${merged} merged. ` +
        "Please review the result.",
    );
  }

  /**
   * Reads the raw scopes settings as `ConfiguredScope[]` (with computed
   * `isCommon`). Used by import/export so the IO module operates on
   * the canonical scope type rather than the wire DTO.
   */
  private readScopesAsConfigured(): ConfiguredScope[] {
    return this.readScopesRaw().map((s) => ({
      name: s.name,
      rootPath: s.rootPath,
      sourcePaths: s.sourcePaths,
      whitelistPaths: s.whitelistPaths,
      excludedPaths: s.excludedPaths,
      externalPrefixes: s.externalPrefixes ?? [],
      isCommon: !s.rootPath,
    }));
  }

  // ─── Mutation pipeline ──────────────────────────────────────────────

  /**
   * Reads the current scopes, hands a mutable copy to [mutator], writes
   * the result back to workspace settings and re-broadcasts to the
   * webview. Writes are serialised via a Promise chain so a burst of
   * UI clicks doesn't issue overlapping `update()` calls (which VSCode
   * doesn't define an order for).
   */
  private async mutate(
    mutator: (scopes: MutableScope[]) => void,
  ): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const current = this.readScopesRaw().map((s) => ({
        name: s.name,
        rootPath: s.rootPath,
        sourcePaths: [...s.sourcePaths],
        whitelistPaths: [...s.whitelistPaths],
        excludedPaths: [...s.excludedPaths],
        externalPrefixes: [...(s.externalPrefixes ?? [])],
      }));
      mutator(current);
      await vscode.workspace
        .getConfiguration("tokenFlow")
        .update(
          "scopes",
          current,
          vscode.ConfigurationTarget.Workspace,
        );
      // No need to manually re-send; onDidChangeConfiguration will fire
      // and refresh() will pick it up. We send anyway so the UI feels
      // instant even if VSCode coalesces multiple changes.
      await this.refresh();
    });
    return this.writeChain;
  }

  // ─── File pickers ───────────────────────────────────────────────────

  private async pickFolder(title: string): Promise<vscode.Uri | null> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picked = await vscode.window.showOpenDialog({
      title,
      defaultUri: ws,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    return picked?.[0] ?? null;
  }

  private async pickFilesOrFolders(
    field: ScopePathField,
  ): Promise<vscode.Uri[] | null> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    // Excludes are folder-typically (skip whole sub-modules); sources +
    // whitelist often point at individual `_variables.scss` files. The
    // dialog supports both either way, but the title nudges users to
    // the expected granularity.
    const titles: Record<ScopePathField, string> = {
      sourcePaths: "Add source files or folders (declares the scope's tokens)",
      whitelistPaths:
        "Add whitelist files or folders (external/known tokens)",
      excludedPaths:
        "Add excluded folders or files (skipped during analysis)",
    };
    const picked = await vscode.window.showOpenDialog({
      title: titles[field],
      defaultUri: ws,
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
    });
    return picked ?? null;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Reads the raw scopes from settings without expanding the
   * back-compat `sourcePaths` fallback — the editing UI deliberately
   * shows an empty list when no scopes are configured, with a banner
   * suggesting the user create their first one.
   */
  /**
   * Reads the general (non-scope) preferences. Falls back to the
   * package.json defaults if the user has never set them. Unknown
   * picker-style values are coerced to "webviewBeside" so a stale
   * settings.json from a future version doesn't leave the radio
   * group in an undefined state.
   */
  private readPreferences(): WirePreferences {
    const cfg = vscode.workspace.getConfiguration("tokenFlow");
    const rawStyle = cfg.get<string>(
      "alternatives.pickerStyle",
      "webviewBeside",
    );
    const pickerStyle =
      rawStyle === "completion" ? "completion" : "webviewBeside";
    return {
      pickerStyle,
      hoverEnabled: cfg.get<boolean>("hover.enabled", true),
    };
  }

  /**
   * Writes a single preference. Targets `Workspace` to match the scope
   * editor's storage location — a single mental model ("Token Flow
   * settings live with the project"). Values are narrowed here so a
   * malformed webview message can't write garbage.
   */
  private async writePreference(
    key: keyof WirePreferences,
    value: string | boolean,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("tokenFlow");
    if (key === "pickerStyle") {
      if (value !== "webviewBeside" && value !== "completion") return;
      await cfg.update(
        "alternatives.pickerStyle",
        value,
        vscode.ConfigurationTarget.Workspace,
      );
      return;
    }
    if (key === "hoverEnabled") {
      if (typeof value !== "boolean") return;
      await cfg.update(
        "hover.enabled",
        value,
        vscode.ConfigurationTarget.Workspace,
      );
      return;
    }
  }

  /**
   * Read-modify-write of the project-wide prefix list, serialised on the
   * same chain as the scope writes so a burst of UI clicks can't race.
   */
  private async writeGlobalPrefixes(
    mutator: (list: string[]) => void,
  ): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const current = [...readGlobalExternalPrefixes()];
      mutator(current);
      await vscode.workspace
        .getConfiguration("tokenFlow")
        .update(
          "externalPrefixes",
          current,
          vscode.ConfigurationTarget.Workspace,
        );
      await this.refresh();
    });
    return this.writeChain;
  }

  private readScopesRaw(): WireScope[] {
    const raw = vscode.workspace
      .getConfiguration("tokenFlow")
      .get<WireScope[]>("scopes", []);
    return raw.map((s) => ({
      name: s.name ?? "",
      rootPath: s.rootPath ?? "",
      sourcePaths: s.sourcePaths ?? [],
      whitelistPaths: s.whitelistPaths ?? [],
      excludedPaths: s.excludedPaths ?? [],
      externalPrefixes: s.externalPrefixes ?? [],
    }));
  }

  private workspaceRelative(uri: vscode.Uri): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return uri.fsPath;
    const rootPath = root.path.endsWith("/") ? root.path : root.path + "/";
    return uri.path.startsWith(rootPath)
      ? uri.path.substring(rootPath.length)
      : uri.fsPath;
  }

  private send(msg: SettingsHostMessage): void {
    void this.panel.webview.postMessage(msg);
  }
}

function skeletonHtml(): string {
  return /* html */ `
<div id="settings-root">
  <p class="settings-empty">Loading…</p>
</div>`;
}
