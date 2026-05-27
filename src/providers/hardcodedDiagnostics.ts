// Live hardcoded-value diagnostics. Scans the active stylesheet document
// for literal values (`14px`, `#fff`, `rgba(…)`) that already exist as
// design tokens, and surfaces them as VSCode diagnostics with severity
// `Hint` (lowest noise — yellow underline only on hover).
//
// The matching tokens (candidates) are attached to each diagnostic via
// the `code` field so the companion CodeActionProvider can build
// "Replace with `var(--token)`" quick-fixes without re-scanning.
//
// Mirrors the IntelliJ `HardcodedValueInspection` MVP behaviour. Skipped
// vs. Kotlin: cross-property suggestion smartness (the IntelliJ
// `SuggestionEngine` re-ranks candidates based on the surrounding CSS
// property — too much complexity for a v0.x VSCode side; alphabetical
// candidate order is the same default as the recent IntelliJ shift away
// from `CandidateSorter`).

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { findLiterals, Hit } from "../scanner/literalFinder";
import { DesignToken } from "../model/designToken";
import { ActiveScopeTracker } from "../services/activeScopeTracker";
import { isFileExcluded, readScopes } from "../settings/scopes";
import { getExpectedRoleForProperty } from "../model/semantics";
import { findSuggestions, TokenSuggestion } from "../scanner/findSuggestions";

const SUPPORTED_LANGUAGES = ["scss", "sass", "css", "less"] as const;

/** Documents/changes are coalesced within this window before re-running the scan. */
const DEBOUNCE_MS = 250;

export class HardcodedDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(
    "tokenFlow",
  );
  private readonly debouncers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly scanner: TokenScanner,
    private readonly scopes: ActiveScopeTracker,
  ) {
    // Initial pass over already-open editors so the user sees diagnostics
    // immediately (otherwise they'd have to type a character to trigger
    // the change listener).
    for (const ed of vscode.window.visibleTextEditors) this.schedule(ed.document);

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.collection.delete(doc.uri);
      }),
      // When the token index is invalidated (file change elsewhere, settings
      // update, refresh command), every open document might have new
      // matches — re-scan them all.
      scanner.onDidChange(() => {
        for (const ed of vscode.window.visibleTextEditors) this.schedule(ed.document);
      }),
      // Active scope change → candidate filter changes → re-scan
      // every visible document so diagnostics reflect the new scope.
      this.scopes.onDidChange(() => {
        for (const ed of vscode.window.visibleTextEditors) this.schedule(ed.document);
      }),
    );
  }

  dispose(): void {
    this.collection.dispose();
    for (const t of this.debouncers.values()) clearTimeout(t);
    this.debouncers.clear();
    for (const d of this.disposables) d.dispose();
  }

  /** Coalesces rapid typing into a single scan per document. */
  private schedule(doc: vscode.TextDocument): void {
    if (!isSupported(doc)) return;
    const key = doc.uri.toString();
    const existing = this.debouncers.get(key);
    if (existing) clearTimeout(existing);
    this.debouncers.set(
      key,
      setTimeout(() => {
        this.debouncers.delete(key);
        void this.scanDocument(doc);
      }, DEBOUNCE_MS),
    );
  }

  private async scanDocument(doc: vscode.TextDocument): Promise<void> {
    // Skip documents the user has explicitly excluded from analysis —
    // matches the IntelliJ "analysisExcludedPaths" behaviour.
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.path ?? null;
    if (readScopes().some((s) => isFileExcluded(doc.uri.path, s, rootPath))) {
      this.collection.delete(doc.uri);
      return;
    }
    const index = await this.scanner.getValueIndex();
    const allTokens = await this.scanner.scan();
    const text = doc.getText();
    const hits = findLiterals(text);
    // Active-scope membership keeps the suggestions honest about which
    // tokens resolve in this file. `findSuggestions` already filters
    // `external` tokens via the `excludeExternal` flag.
    const active = this.scopes.activeNames();
    const scopedTokens = allTokens.filter((t) => active.has(t.scope));

    const diagnostics: vscode.Diagnostic[] = [];
    for (const hit of hits) {
      const expectedRole = hit.cssProperty
        ? getExpectedRoleForProperty(hit.cssProperty)
        : null;
      const suggestions = findSuggestions(hit, index, scopedTokens, {
        expectedRole,
        excludeExternal: true,
      });
      if (suggestions.length === 0) continue;
      diagnostics.push(buildDiagnostic(doc, hit, suggestions));
    }
    this.collection.set(doc.uri, diagnostics);
  }
}

function buildDiagnostic(
  doc: vscode.TextDocument,
  hit: Hit,
  suggestions: readonly TokenSuggestion[],
): vscode.Diagnostic {
  const matches = suggestions.map((s) => s.token);
  // Highlight the inner literal (the part the user actually typed) — even
  // when the replace range covers a wrapper like `rem-calc(14px)`. The
  // wrapper expansion stays available on the diagnostic via `code` so the
  // quick-fix can still swap the whole call.
  const range = new vscode.Range(
    doc.positionAt(hit.startOffset),
    doc.positionAt(hit.endOffsetExclusive),
  );
  const top = matches[0];
  const moreSuffix = matches.length > 1 ? ` (+${matches.length - 1} more)` : "";
  const diag = new vscode.Diagnostic(
    range,
    `Matches design token \`${top.name}\`${moreSuffix} — consider using it instead.`,
    vscode.DiagnosticSeverity.Hint,
  );
  diag.source = "Token Flow";
  diag.tags = [vscode.DiagnosticTag.Unnecessary];
  // Carry the metadata the CodeActionProvider needs so it doesn't have to
  // re-run the literal finder or the index lookup. We attach a custom
  // shape under `code` (allowed by the API; VSCode renders the `value`
  // field in the Problems panel).
  diag.code = {
    value: top.name,
    target: vscode.Uri.parse("https://github.com/robinlopez/token-flow"),
  };
  // Stash the full match list + hit metadata on a non-API field so the
  // CodeActionProvider can pick it up via the diagnostic reference.
  (diag as unknown as { _tokenFlow: HardcodedHitMeta })._tokenFlow = {
    hit,
    matches,
  };
  return diag;
}

export interface HardcodedHitMeta {
  readonly hit: Hit;
  readonly matches: readonly DesignToken[];
}

/** Extract the metadata stashed by [buildDiagnostic]; returns `null` for foreign diagnostics. */
export function getHitMeta(diag: vscode.Diagnostic): HardcodedHitMeta | null {
  const meta = (diag as unknown as { _tokenFlow?: HardcodedHitMeta })._tokenFlow;
  return meta ?? null;
}

function isSupported(doc: vscode.TextDocument): boolean {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(doc.languageId);
}
