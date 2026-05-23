// Port of `ScopeConfigIO.kt`. JSON import/export for the scope list so
// a Lead Designer can hand the file to a teammate, commit it next to a
// project, or diff it across branches. The wrapper carries a `version`
// tag so a future schema bump can refuse — or migrate — incompatible
// files instead of crashing on missing fields.
//
// Field-name alignment with the IntelliJ format:
//   • `excludedPaths`        — files/folders skipped during analysis
//                               (matches IntelliJ's `analysisExcludedPaths`
//                               semantically; we keep VS Code's native
//                               name on the wire since users edit it
//                               here).
//   • `whitelistPaths`       — VS Code-specific: external/cataloged
//                               tokens. IntelliJ achieves the same role
//                               through `excludedPaths` + ignored-names
//                               collection. Stays in the file under its
//                               native name for round-trip fidelity.
//   • `externalPrefixes`     — CSS var prefixes treated as external
//                               (`--vscode-`, `--p-`, `--mdc-`). Matches
//                               the IntelliJ field 1:1.

import { ConfiguredScope } from "./scopes";

export const CURRENT_VERSION = 1;

interface ScopeDto {
  readonly name: string;
  readonly rootPath: string;
  readonly sourcePaths: readonly string[];
  readonly whitelistPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly externalPrefixes: readonly string[];
}

interface ScopeConfigFile {
  readonly version: number;
  readonly generator: string;
  readonly scopes: readonly ScopeDto[];
}

export class ImportError extends Error {}

/** Serialises [scopes] to the pretty-printed JSON the file dialog writes. */
export function exportScopes(scopes: readonly ConfiguredScope[]): string {
  const payload: ScopeConfigFile = {
    version: CURRENT_VERSION,
    generator: "Token Flow (VS Code)",
    scopes: scopes.map((s) => ({
      name: s.name,
      rootPath: s.rootPath,
      sourcePaths: [...s.sourcePaths],
      whitelistPaths: [...s.whitelistPaths],
      excludedPaths: [...s.excludedPaths],
      externalPrefixes: [...s.externalPrefixes],
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parses a config file. Throws [ImportError] with a user-readable
 * message — the host can surface that directly via
 * `vscode.window.showErrorMessage`.
 *
 * Missing optional fields default to empty lists so older exports
 * (or hand-authored files) load cleanly.
 */
export function importScopes(json: string): ConfiguredScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ImportError(
      `Invalid JSON: ${(e as Error).message ?? "could not parse file"}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ImportError("Expected a JSON object at the root.");
  }
  const root = parsed as Partial<ScopeConfigFile>;
  if (
    typeof root.version === "number" &&
    root.version > CURRENT_VERSION
  ) {
    throw new ImportError(
      `Config file version ${root.version} is newer than this plugin (supported: ${CURRENT_VERSION}). Update Token Flow.`,
    );
  }
  if (!Array.isArray(root.scopes)) {
    throw new ImportError(`Missing "scopes" array.`);
  }
  return root.scopes.map((s) => normaliseImported(s));
}

function normaliseImported(raw: unknown): ConfiguredScope {
  if (!raw || typeof raw !== "object") {
    throw new ImportError("Each scope must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const name = stringOr(obj.name, "").trim() || "(unnamed)";
  const rootPath = stringOr(obj.rootPath, "").trim();
  return {
    name,
    rootPath,
    sourcePaths: stringArrayOr(obj.sourcePaths),
    whitelistPaths: stringArrayOr(obj.whitelistPaths),
    excludedPaths: stringArrayOr(obj.excludedPaths),
    externalPrefixes: stringArrayOr(obj.externalPrefixes),
    isCommon: !rootPath,
  };
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function stringArrayOr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Merges [incoming] into [current]: a scope whose name matches an
 * existing one (case-insensitive, trimmed) replaces it; otherwise the
 * new scope is appended. Mirrors `mergeScopes` on the IntelliJ side
 * so a config file exported from either editor merges the same way.
 */
export function mergeScopes(
  current: readonly ConfiguredScope[],
  incoming: readonly ConfiguredScope[],
): ConfiguredScope[] {
  const keyFor = (s: ConfiguredScope) => s.name.trim().toLowerCase();
  const out = [...current];
  const indexByKey = new Map<string, number>();
  out.forEach((s, i) => indexByKey.set(keyFor(s), i));
  for (const next of incoming) {
    const key = keyFor(next);
    const at = indexByKey.get(key);
    if (at != null) {
      out[at] = next;
    } else {
      indexByKey.set(key, out.length);
      out.push(next);
    }
  }
  return out;
}
