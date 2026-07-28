// Named-scope configuration — pure data layer. Each scope owns three
// kinds of path lists, mirroring the IntelliJ tool window's
// master-detail UI:
//
//   sourcePaths    — files / folders that DECLARE the scope's tokens.
//                    Scanned for token declarations and indexed under
//                    the scope's name.
//   whitelistPaths — files whose tokens are "external/known" (e.g. a
//                    bundled library's `_variables.scss`). Their tokens
//                    ARE indexed (so hover and completion still work
//                    on them) but flagged `external: true` so the
//                    Hardcoded panel won't offer them as replacement
//                    candidates and Analyse won't count them in
//                    project-health metrics.
//   excludedPaths  — folders/files INSIDE the scope's rootPath that
//                    analysis should skip entirely (e.g. unrelated
//                    sub-modules accidentally caught by a wide root).
//                    Hardcoded scans and Analyse aggregations skip
//                    files whose path is inside any excluded path.
//
// Back-compat: when `tokenFlow.scopes` is empty, the legacy
// `tokenFlow.sourcePaths` setting is wrapped into a single implicit
// "common" scope with empty whitelist + excludes.

import * as vscode from "vscode";

export interface ConfiguredScope {
  readonly name: string;
  readonly rootPath: string;
  readonly sourcePaths: readonly string[];
  readonly whitelistPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  /**
   * CSS-var name prefixes that originate from external/runtime sources
   * (Material `--mdc-`, PrimeNG `--p-`, VS Code's webview `--vscode-`).
   * References matching any of these prefixes are treated as known —
   * neither broken nor counted as project tokenisation — by Analyse.
   * Mirrors `Scope.externalPrefixes` on the IntelliJ side.
   */
  readonly externalPrefixes: readonly string[];
  readonly isCommon: boolean;
}

/** Reserved name for the implicit / explicit common scope. */
export const COMMON_SCOPE_NAME = "common";

interface RawScopeConfig {
  readonly name?: string;
  readonly rootPath?: string;
  readonly sourcePaths?: readonly string[];
  readonly whitelistPaths?: readonly string[];
  readonly excludedPaths?: readonly string[];
  readonly externalPrefixes?: readonly string[];
}

export function readScopes(): readonly ConfiguredScope[] {
  const cfg = vscode.workspace.getConfiguration("tokenFlow");
  const raw = cfg.get<readonly RawScopeConfig[]>("scopes", []);

  if (raw.length === 0) {
    const legacy = cfg.get<readonly string[]>("sourcePaths", []);
    return [
      {
        name: COMMON_SCOPE_NAME,
        rootPath: "",
        sourcePaths: legacy,
        whitelistPaths: [],
        excludedPaths: [],
        externalPrefixes: [],
        isCommon: true,
      },
    ];
  }

  return raw.map((s) => ({
    name: (s.name ?? "").trim() || "(unnamed)",
    rootPath: (s.rootPath ?? "").trim(),
    sourcePaths: s.sourcePaths ?? [],
    whitelistPaths: s.whitelistPaths ?? [],
    excludedPaths: s.excludedPaths ?? [],
    externalPrefixes: s.externalPrefixes ?? [],
    isCommon: !(s.rootPath ?? "").trim(),
  }));
}

/**
 * Reads the project-wide `tokenFlow.externalPrefixes` setting — the
 * global tier of the option. Covers the common case (a framework
 * injecting `--p-` / `--ion-` / `--mat-` variables everywhere) without
 * forcing the user to repeat itself in every scope.
 */
export function readGlobalExternalPrefixes(): readonly string[] {
  return vscode.workspace
    .getConfiguration("tokenFlow")
    .get<readonly string[]>("externalPrefixes", []);
}

/**
 * Effective prefix set for an analysis run: the global setting unioned
 * with every active scope's own `externalPrefixes`, trimmed and
 * deduplicated. Same union rule as the IntelliJ side, which only has
 * the per-scope tier.
 */
export function effectiveExternalPrefixes(
  activeScopes: readonly ConfiguredScope[],
): readonly string[] {
  const set = new Set<string>();
  const add = (raw: string): void => {
    const p = raw.trim();
    if (p) set.add(p);
  };
  for (const p of readGlobalExternalPrefixes()) add(p);
  for (const s of activeScopes) for (const p of s.externalPrefixes) add(p);
  return [...set];
}

/**
 * Mirror of `ScopeResolver.activeScopesFor` (IntelliJ). Returns scopes
 * applicable when editing [filePath]:
 *   • every common scope (empty rootPath),
 *   • plus the deepest non-common scope that owns the file via either
 *     a sourcePaths entry or its rootPath.
 *
 * When [filePath] is null, returns all configured scopes (whole-project
 * analysis).
 */
export function activeScopesFor(
  scopes: readonly ConfiguredScope[],
  workspaceRoot: string | null,
  filePath: string | null,
): readonly ConfiguredScope[] {
  if (scopes.length === 0) return [];
  if (filePath === null) return scopes;

  const commons: ConfiguredScope[] = [];
  const specifics: { scope: ConfiguredScope; depth: number }[] = [];
  const absolutize = (rel: string): string | null => {
    if (!rel.trim()) return null;
    if (rel.startsWith("/")) return rel;
    if (!workspaceRoot) return null;
    const base = workspaceRoot.replace(/\/$/, "");
    return `${base}/${rel.replace(/^\//, "")}`;
  };

  for (const scope of scopes) {
    if (scope.isCommon) {
      commons.push(scope);
      continue;
    }
    const sourceMatch = scope.sourcePaths.some((src) => {
      const abs = absolutize(src);
      return (
        abs !== null && (filePath === abs || filePath.startsWith(abs + "/"))
      );
    });
    if (sourceMatch) {
      specifics.push({ scope, depth: filePath.length });
      continue;
    }
    const rootAbs = absolutize(scope.rootPath);
    if (rootAbs && (filePath === rootAbs || filePath.startsWith(rootAbs + "/"))) {
      specifics.push({ scope, depth: rootAbs.length });
    }
  }

  let deepest: ConfiguredScope | null = null;
  let deepestDepth = -1;
  for (const s of specifics) {
    if (s.depth > deepestDepth) {
      deepestDepth = s.depth;
      deepest = s.scope;
    }
  }
  return deepest !== null ? [...commons, deepest] : commons;
}

/** Membership test used by every scope-aware consumer (hover, completion, …). */
export function isInActiveScopes(
  tokenScope: string,
  activeScopes: readonly ConfiguredScope[],
): boolean {
  for (const s of activeScopes) {
    if (s.name === tokenScope) return true;
  }
  return false;
}

/**
 * Returns true when [filePath] (absolute) sits under any of the scope's
 * excluded paths. Used by the Hardcoded panel + Analyse aggregator to
 * skip whole sub-modules carved out of a wide rootPath.
 */
export function isFileExcluded(
  filePath: string,
  scope: ConfiguredScope,
  workspaceRoot: string | null,
): boolean {
  if (scope.excludedPaths.length === 0 || !workspaceRoot) return false;
  const base = workspaceRoot.replace(/\/$/, "");
  for (const rel of scope.excludedPaths) {
    if (!rel.trim()) continue;
    const abs = rel.startsWith("/") ? rel : `${base}/${rel.replace(/^\//, "")}`;
    if (filePath === abs || filePath.startsWith(abs + "/")) return true;
  }
  return false;
}
