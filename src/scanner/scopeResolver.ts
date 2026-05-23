// Mirror of `ScopeResolver.kt`. Given a file URI, returns the scopes
// that apply when editing it:
//
//   • every common scope (empty `rootPath`)
//   • plus the **deepest** specific scope whose `rootPath` (or one of
//     its `sourcePaths`) contains the file. Picking the deepest match
//     prevents a generic scope (`bo/src`) from masking a more specific
//     one (`bo/src/app/feature-x`) when both contain the file.
//
// When the file is null (no active editor) — return every configured
// scope. Consumers that want a strict "only-active" filter should
// therefore guard on the active editor themselves.

import * as vscode from "vscode";
import {
  ConfiguredScope,
  COMMON_SCOPE_NAME,
  readScopes,
} from "../settings/scopes";

export interface ScopeResolution {
  /** The full list of configured scopes (handy for picker UIs). */
  readonly all: readonly ConfiguredScope[];
  /** Scopes whose tokens are visible from the active editor. */
  readonly active: readonly ConfiguredScope[];
  /** The single non-common scope picked by the deepest-match rule, if any. */
  readonly specific: ConfiguredScope | null;
}

export function resolveScopes(fileUri: vscode.Uri | null): ScopeResolution {
  const all = readScopes();
  if (!fileUri) {
    return { all, active: all, specific: null };
  }
  const filePath = fileUri.path;

  const commons: ConfiguredScope[] = [];
  // Each candidate keeps the depth (= length of the matching prefix) so
  // we can pick the deepest one. Using `filePath.length` for sourcePath
  // matches biases toward those — if a file appears under a scope's
  // explicit sourcePath AND a different scope's rootPath, the
  // sourcePath wins, mirroring the IntelliJ rule.
  const specifics: { scope: ConfiguredScope; depth: number }[] = [];

  for (const scope of all) {
    if (scope.isCommon) {
      commons.push(scope);
      continue;
    }
    let matched = false;
    // Source-path match takes precedence (explicit declaration > root).
    for (const src of scope.sourcePaths) {
      const abs = absolutize(src);
      if (abs && (filePath === abs || filePath.startsWith(abs + "/"))) {
        specifics.push({ scope, depth: filePath.length });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const rootAbs = absolutize(scope.rootPath);
    if (rootAbs && (filePath === rootAbs || filePath.startsWith(rootAbs + "/"))) {
      specifics.push({ scope, depth: rootAbs.length });
    }
  }

  specifics.sort((a, b) => b.depth - a.depth);
  const deepest = specifics[0]?.scope ?? null;
  const active = deepest ? [...commons, deepest] : commons;
  return { all, active, specific: deepest };
}

/**
 * Workspace-relative paths are turned into absolute filesystem-style
 * paths so they can be matched against `vscode.Uri.path`. Absolute
 * inputs are passed through unchanged. Returns null when no workspace
 * is open or when the input is blank.
 */
function absolutize(stored: string): string | null {
  if (!stored.trim()) return null;
  if (stored.startsWith("/")) return stored;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return null;
  const base = root.path.replace(/\/$/, "");
  return `${base}/${stored.replace(/^\//, "")}`;
}

/** Convenience for the common case of "is the common scope the only one active?". */
export function isOnlyCommon(resolution: ScopeResolution): boolean {
  return (
    resolution.specific === null &&
    resolution.active.every((s) => s.name === COMMON_SCOPE_NAME || s.isCommon)
  );
}
