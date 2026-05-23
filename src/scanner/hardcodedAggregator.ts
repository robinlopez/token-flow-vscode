// Two aggregation modes for hardcoded literals:
//
//   • aggregateHardcodedInDocument(scanner, document)
//       Used by the **Hardcoded sidebar panel**. Scans only the active
//       file, mirroring the IntelliJ panel that follows the current
//       editor. Produces rich `WireHardcodedMatch` records with
//       per-candidate replacement strings and color swatches so the
//       webview can render Apply/Jump buttons + inline pastilles.
//
//   • aggregateHardcodedAcrossWorkspace(scanner)
//       Used by the **Analyse dashboard**. Same matching logic, but
//       returns lighter records (no per-candidate replacement string —
//       Analyse only surfaces aggregated counts, never offers a
//       replacement action).
//
// Both share the same exclusion rules via `findLiterals` + the value
// index lookup; the difference is the I/O scope and the wire payload.

import * as vscode from "vscode";
import { TokenScanner } from "./tokenScanner";
import { findLiterals, LiteralKind } from "./literalFinder";
import { helperSuggestionsFor } from "./helperSuggestions";
import { DesignToken, TokenCategory, tokenExpression } from "../model/designToken";
import { parseColor, rgbaToCacheKey } from "../ui/colorParser";
import {
  WireHardcodedCandidate,
  WireHardcodedMatch,
} from "../webview/shared/protocol";
import { isFileExcluded, readScopes } from "../settings/scopes";
import { isTokenRelevantLanguage } from "../services/activeScopeTracker";

const GLOB = "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json}";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// LENGTH literals (`16px`) should also surface SIZING / BORDER /
// LAYOUT token candidates — those are the buckets the categoriser
// drops length-dimensioned non-spacing tokens into.
const KIND_TO_CATEGORIES: Record<LiteralKind, readonly TokenCategory[]> = {
  COLOR: ["COLOR"],
  LENGTH: ["SPACING", "RADIUS", "TYPOGRAPHY", "SIZING", "BORDER", "LAYOUT"],
  DURATION: ["DURATION"],
};

// ─── Per-document mode (Hardcoded sidebar panel) ────────────────────────

/**
 * Builds the rich match list shown in the Hardcoded panel for a single
 * document. `document.getText()` is preferred over reading from disk so
 * unsaved edits are reflected immediately.
 */
export async function aggregateHardcodedInDocument(
  scanner: TokenScanner,
  document: vscode.TextDocument,
  activeScopeNames: ReadonlySet<string>,
): Promise<WireHardcodedMatch[]> {
  if (!isTokenRelevantLanguage(document.languageId)) return [];

  // If the document is inside the excluded paths of every scope it'd
  // otherwise belong to, return immediately — same UX as the IntelliJ
  // panel: an excluded file shows zero hits even though the underlying
  // literals exist.
  if (isDocumentExcluded(document.uri)) return [];

  const index = await scanner.getValueIndex();
  // All-tokens snapshot — needed to synthesise helper-call candidates
  // (`spacing(2)` for a hardcoded `16px`). Cheap: the scanner caches
  // this list and `lookupAcross` already triggered the scan.
  const allTokens = await scanner.scan();
  const text = document.getText();
  const relPath = workspaceRelative(document.uri);

  const out: WireHardcodedMatch[] = [];
  for (const hit of findLiterals(text)) {
    // Two filters layered: active-scope membership (the rest of the
    // plugin already enforces this) and external-token exclusion
    // (whitelisted external tokens are reference-only — we shouldn't
    // suggest replacing user code with a third-party library's token).
    const exact = index
      .lookupAcross(hit.text, KIND_TO_CATEGORIES[hit.kind])
      .filter((t) => activeScopeNames.has(t.scope) && !t.external);
    // Synthetic `spacing(N)` calls — only filter on scope+external,
    // not on the value index (the helper itself is the indexed token,
    // its call expression is generated on the fly).
    const helperCalls = helperSuggestionsFor(hit.text, hit.kind, allTokens)
      .filter((t) => activeScopeNames.has(t.scope) && !t.external);
    const matches = [...exact, ...helperCalls];
    if (matches.length === 0) continue;
    out.push({
      relPath,
      line: lineNumberAt(text, hit.startOffset),
      literal: hit.text,
      kind: hit.kind,
      hex: hexOf(hit.text, hit.kind),
      replaceStart: hit.replaceStart,
      replaceEndExclusive: hit.replaceEndExclusive,
      candidates: matches.map(toWireCandidate),
    });
  }
  return out;
}

/** Returns true when the URI lives under the `excludedPaths` of at least one scope. */
function isDocumentExcluded(uri: vscode.Uri): boolean {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.path ?? null;
  for (const scope of readScopes()) {
    if (isFileExcluded(uri.path, scope, root)) return true;
  }
  return false;
}

function toWireCandidate(token: DesignToken): WireHardcodedCandidate {
  return {
    name: token.name,
    replacement: tokenExpression(token),
    hex: token.category === "COLOR" ? canonicalHex(token.resolvedValue) : null,
  };
}

// ─── Workspace-wide mode (Analyse dashboard) ────────────────────────────

/**
 * Lightweight matches across every stylesheet in the workspace. Returns
 * a single representative per (file, literal, line) tuple. Used by the
 * Analyse dashboard's "top hardcoded values" block, where individual
 * replace actions don't make sense.
 */
export async function aggregateHardcodedAcrossWorkspace(
  scanner: TokenScanner,
): Promise<WireHardcodedMatch[]> {
  const index = await scanner.getValueIndex();
  const allTokens = await scanner.scan();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return [];

  const sourcePaths = vscode.workspace
    .getConfiguration("tokenFlow")
    .get<string[]>("sourcePaths", []);
  const files =
    sourcePaths.length === 0
      ? await vscode.workspace.findFiles(GLOB, "**/node_modules/**")
      : await resolveScopedFiles(root, sourcePaths);

  const matches: WireHardcodedMatch[] = [];
  // Pre-compute scope-level exclusion against the active workspace root
  // once per call so the inner loop stays cheap.
  const scopes = readScopes();
  const rootPath = root.path;

  for (const uri of files) {
    if (scopes.some((s) => isFileExcluded(uri.path, s, rootPath))) continue;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      const relPath = workspaceRelative(uri);
      for (const hit of findLiterals(text)) {
        const exact = index
          .lookupAcross(hit.text, KIND_TO_CATEGORIES[hit.kind])
          .filter((t) => !t.external);
        const helperCalls = helperSuggestionsFor(hit.text, hit.kind, allTokens)
          .filter((t) => !t.external);
        const candidates = [...exact, ...helperCalls];
        if (candidates.length === 0) continue;
        matches.push({
          relPath,
          line: lineNumberAt(text, hit.startOffset),
          literal: hit.text,
          kind: hit.kind,
          hex: hexOf(hit.text, hit.kind),
          replaceStart: hit.replaceStart,
          replaceEndExclusive: hit.replaceEndExclusive,
          candidates: candidates.map(toWireCandidate),
        });
      }
    } catch {
      // Unreadable file — skip silently.
    }
  }
  return matches;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function resolveScopedFiles(
  root: vscode.Uri,
  paths: string[],
): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  for (const rel of paths) {
    const uri = vscode.Uri.joinPath(root, rel);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(uri, GLOB),
        );
        out.push(...found);
      } else {
        out.push(uri);
      }
    } catch {
      // Path doesn't exist — skip.
    }
  }
  return out;
}

function workspaceRelative(uri: vscode.Uri): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return uri.path;
  const rootPath = root.path.endsWith("/") ? root.path : root.path + "/";
  return uri.path.startsWith(rootPath)
    ? uri.path.substring(rootPath.length)
    : uri.path;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++; //                       LF
  }
  return line;
}

/** Inline pastille hex for the row's left swatch — only for COLOR hits. */
function hexOf(literal: string, kind: LiteralKind): string | null {
  if (kind !== "COLOR") return null;
  return canonicalHex(literal);
}

function canonicalHex(value: string): string | null {
  const rgba = parseColor(value);
  if (!rgba) return null;
  const key = rgbaToCacheKey(rgba);
  return rgba.a === 255 ? "#" + key.substring(0, 6) : "#" + key;
}

