// Centralises the "active scope" answer so every consumer
// (Library / Hardcoded / Hover / Completion / Alternatives / status
// bar) reads from a single mutable cell instead of re-running the
// resolver on every event. The tracker:
//
//   • listens to active-editor changes,
//   • listens to settings changes (`tokenFlow.scopes` /
//     `tokenFlow.sourcePaths`) so a config edit re-resolves
//     immediately without waiting for the user to switch files,
//   • emits `onDidChange` only when the resolved active-scope
//     identity actually changes (file → file moves that stay in the
//     same scope are no-ops).
//
// The token scanner is invalidated by extension.ts on settings
// changes — not from here — because the scope membership of a token
// only changes when its source file moves between scopes; otherwise
// the existing index stays valid and we just re-filter at read time.

import * as vscode from "vscode";
import { ConfiguredScope } from "../settings/scopes";
import { ScopeResolution, resolveScopes } from "../scanner/scopeResolver";

export class ActiveScopeTracker implements vscode.Disposable {
  private current: ScopeResolution;
  private readonly _onDidChange = new vscode.EventEmitter<ScopeResolution>();
  readonly onDidChange = this._onDidChange.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.current = resolveScopes(activeEditorUri());
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("tokenFlow.scopes") ||
          e.affectsConfiguration("tokenFlow.sourcePaths")
        ) {
          this.refresh(/* force */ true);
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this._onDidChange.dispose();
  }

  get(): ScopeResolution {
    return this.current;
  }

  /** Returns the names of the currently-active scopes, useful as a `Set`-friendly view. */
  activeNames(): Set<string> {
    return new Set(this.current.active.map((s) => s.name));
  }

  /** Convenience: the deepest non-common scope, if one is active. */
  specific(): ConfiguredScope | null {
    return this.current.specific;
  }

  private refresh(force = false): void {
    const next = resolveScopes(activeEditorUri());
    if (!force && sameResolution(this.current, next)) return;
    this.current = next;
    this._onDidChange.fire(next);
  }
}

function activeEditorUri(): vscode.Uri | null {
  return vscode.window.activeTextEditor?.document.uri ?? null;
}

/**
 * Single source of truth for "which active-editor languages should
 * count as 'token-relevant' for in-panel UI gates" (scope strip,
 * status bar, scope-aware idle states). The scanner itself is
 * language-agnostic — it walks whatever the scope's sourcePaths
 * say. This list is purely for surface UX.
 *
 * Includes every language the parsers currently ingest:
 *   • CSS family — stylesheets where `--`/`$` declarations live
 *   • TS/JS family — files that may carry Style-Dictionary presets,
 *     runtime themes, or callable helpers
 *   • JSON — Style-Dictionary token-source files (`tokens.json`)
 */
export const TOKEN_RELEVANT_LANGUAGES: ReadonlySet<string> = new Set([
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

export function isTokenRelevantLanguage(languageId: string): boolean {
  return TOKEN_RELEVANT_LANGUAGES.has(languageId);
}

function sameResolution(a: ScopeResolution, b: ScopeResolution): boolean {
  if (a.active.length !== b.active.length) return false;
  for (let i = 0; i < a.active.length; i++) {
    if (a.active[i].name !== b.active[i].name) return false;
  }
  return a.specific?.name === b.specific?.name;
}
