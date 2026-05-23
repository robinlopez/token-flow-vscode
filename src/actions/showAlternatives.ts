// Alt+T equivalent of the IntelliJ "Show Token Alternatives" action.
//
// Behaviour:
//  1. Identify what's under the caret —
//       • a token reference (`var(--x)`, `--x`, `$x`) → use that token
//         as the pivot and surface sibling tokens of the same category,
//       • a hardcoded literal (`14px`, `#fff`, …) → look it up in the
//         value index; if it matches one or more tokens, use the first
//         match as the pivot. If it doesn't match anything, fall back
//         to surfacing every token of the literal's *kind* category.
//  2. Show a `QuickPick` with the candidates, sorted alphabetically
//     (mirrors IntelliJ v0.1.2 — `CandidateSorter` removed there too).
//  3. On selection, replace the appropriate range with
//     `tokenExpression(token)`.
//
// Out of scope for the VSCode MVP: the HSL-proximity / numeric-ascending
// smart sort the IntelliJ side used to have. The user can always type
// in the QuickPick to fuzzy-filter — that's usually faster than reading
// a heavy sort.

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { findLiterals, Hit } from "../scanner/literalFinder";
import {
  DesignToken,
  TokenCategory,
  tokenExpression,
} from "../model/designToken";
import { ActiveScopeTracker } from "../services/activeScopeTracker";
import { openAlternativesPicker } from "../views/alternativesPicker";
import { openAlternativesAsCompletion } from "../views/alternativesCompletion";
import { helperSuggestionsFor } from "../scanner/helperSuggestions";
import {
  injectModeSegment,
  modeSegmentIndex,
  pathSeparator,
  rawModeSegmentOf,
  resolveReference,
} from "../scanner/tokenNameParser";
import {
  adjustReplacementForContext,
  expandRangeForJsQuotes,
} from "../scanner/replacementContext";
import { DynamicCssVarIndex } from "../scanner/dynamicCssVarIndex";
import { showContextualVarPicker } from "../views/contextualVarPicker";

type PickerStyle = "webviewBeside" | "completion";

function readPickerStyle(): PickerStyle {
  const value = vscode.workspace
    .getConfiguration("tokenFlow")
    .get<string>("alternatives.pickerStyle", "webviewBeside");
  return value === "completion" ? "completion" : "webviewBeside";
}

const KIND_TO_CATEGORIES: Record<string, readonly TokenCategory[]> = {
  COLOR: ["COLOR"],
  LENGTH: ["SPACING", "RADIUS", "TYPOGRAPHY"],
  DURATION: ["DURATION"],
};

export async function showAlternatives(
  scanner: TokenScanner,
  dynamicCssVarIndex: DynamicCssVarIndex,
  scopes: ActiveScopeTracker,
  context: vscode.ExtensionContext,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Token Flow: no active editor to inspect.",
    );
    return;
  }

  const tokenRef = referenceAt(editor.document, editor.selection.active);
  if (tokenRef && tokenRef.name.startsWith("--")) {
    await dynamicCssVarIndex.ensureReady();
    if (dynamicCssVarIndex.has(tokenRef.name)) {
      const allTokens = await scanner.scan();
      const isDesignToken = allTokens.some((t) => t.name === tokenRef.name);
      if (!isDesignToken) {
        await showContextualVarPicker(tokenRef.name, dynamicCssVarIndex);
        return;
      }
    }
  }

  const ctx = await resolveContext(editor, scanner, scopes);
  if (!ctx) {
    vscode.window.showInformationMessage(
      "Token Flow: no token reference or matching literal under the caret.",
    );
    return;
  }
  const style = readPickerStyle();
  if (style === "completion") {
    // The completion provider applies the edit itself via the
    // CompletionItem's `range` + `insertText`, so we MUST NOT call
    // `applyReplacement` afterwards — doing so would double-insert.
    await openAlternativesAsCompletion(editor, {
      candidates: ctx.candidates,
      pivot: ctx.pivot,
      replaceRange: ctx.replaceRange,
      subtitle: ctx.summary,
    });
    return;
  }
  const pick = await showPicker(ctx, context);
  if (!pick) return;
  await applyReplacement(editor, ctx, pick);
}

// ─── Context resolution ─────────────────────────────────────────────────

interface AltContext {
  /** The token whose siblings we surface. May be null when the literal under the caret has no exact match. */
  readonly pivot: DesignToken | null;
  /** Tokens to display in the picker — pre-filtered by category. */
  readonly candidates: readonly DesignToken[];
  /** Range to overwrite when the user picks a candidate. */
  readonly replaceRange: vscode.Range;
  /** Verbatim source text of [replaceRange] — shown in the picker title for confirmation. */
  readonly replaceText: string;
  /** Human-readable hint for the picker placeholder. */
  readonly summary: string;
  /**
   * Original reference name as written in source (e.g.
   * `global.modeLight.x.y`). Carries the mode segment + binding prefix
   * the indexer strips so [applyReplacement] can re-inject them when
   * rebuilding the JS_OBJECT_PATH wrapper. `null` for literal-under-
   * cursor or non-JS contexts.
   */
  readonly sourceRefName: string | null;
}

async function resolveContext(
  editor: vscode.TextEditor,
  scanner: TokenScanner,
  scopes: ActiveScopeTracker,
): Promise<AltContext | null> {
  const allTokens = await scanner.scan();
  // Restrict the candidate universe to the active scope's tokens —
  // otherwise Alt+T on `var(--mobile-primary)` would suggest desktop
  // siblings, which are inaccessible from the current file.
  const active = scopes.activeNames();
  const tokens = allTokens.filter((t) => active.has(t.scope));

  // 1. Token reference under the cursor — preferred path.
  const tokenRef = referenceAt(editor.document, editor.selection.active);
  if (tokenRef) {
    const pivot = findPivotByReference(tokens, tokenRef.name);
    if (pivot) {
      // Include the pivot itself in the candidate list so the picker
      // can preselect it. Previously we passed `pivot.name` as
      // `excludeName`, which dropped the row the user was anchored on
      // and left the picker landing on index 0 — disorienting when
      // the pivot is e.g. `--global-low-surface-default` and the
      // alphabetical first is in an unrelated group.
      return {
        pivot,
        candidates: sortedSiblings(tokens, pivot.category),
        replaceRange: tokenRef.replaceRange,
        replaceText: editor.document.getText(tokenRef.replaceRange),
        summary: `${pivot.category.toLowerCase()} · siblings of ${pivot.name}`,
        sourceRefName: tokenRef.name,
      };
    }
  }

  // 2. Hardcoded literal under the cursor — re-use the LiteralFinder so
  //    we identify the same ranges the diagnostics use, then look up
  //    matches via the value index.
  const literalHit = literalAt(editor);
  if (!literalHit) return null;

  const index = await scanner.getValueIndex();
  const categories = KIND_TO_CATEGORIES[literalHit.kind] ?? [];
  // Filter at lookup time so out-of-scope or external tokens don't
  // end up as the pivot — that would make the picker offer their
  // siblings, also out of scope. The host-side `tokens` filter
  // handles the same job for the picker's later "all category"
  // fallback.
  const exactMatches = index
    .lookupAcross(literalHit.text, categories)
    .filter((t) => active.has(t.scope) && !t.external);
  // Synthetic helper-call suggestions — `spacing(2)` for a hardcoded
  // `16px` if a helper with unit 8 is indexed. Filtered on scope +
  // external like exact matches so the picker stays scope-coherent.
  const helperCalls = helperSuggestionsFor(
    literalHit.text,
    literalHit.kind,
    tokens,
  ).filter((t) => active.has(t.scope) && !t.external);
  const matches = [...exactMatches, ...helperCalls];

  const pivot = matches[0] ?? null;
  const candidates =
    matches.length > 0
      ? [
          // Helpers don't have siblings to surface — splice them in
          // verbatim above the sortedSiblings of the pivot's category
          // so the user sees `spacing(2)` BEFORE the alphabetical
          // sibling block when both are relevant.
          ...helperCalls,
          ...sortedSiblings(
            tokens,
            pivot!.category,
            /* excludeName */ undefined,
            /* lift to top */ exactMatches.map((m) => m.name),
          ).filter((t) => !helperCalls.some((h) => h.name === t.name)),
        ]
      : tokens
          .filter((t) => categories.includes(t.category))
          .sort(byName);

  if (candidates.length === 0) return null;

  const range = new vscode.Range(
    editor.document.positionAt(literalHit.replaceStart),
    editor.document.positionAt(literalHit.replaceEndExclusive),
  );
  return {
    pivot,
    candidates,
    replaceRange: range,
    replaceText: literalHit.replaceText,
    summary: pivot
      ? `${pivot.category.toLowerCase()} · matches "${literalHit.text}"`
      : `${literalHit.kind.toLowerCase()} · no exact match for "${literalHit.text}"`,
    sourceRefName: null,
  };
}

interface TokenRefHit {
  readonly name: string; //          $x | --x
  /** Range that should be overwritten on replace (may include the `var(…)` wrapper). */
  readonly replaceRange: vscode.Range;
}

/**
 * Locates the pivot token for a textual reference under the cursor.
 *
 * Naïve `find(t => t.name === ref)` fails for JS object paths because
 * the scanner collapses mode-bearing siblings to a canonical name —
 * the user's source still writes `'{global.modeLight.x.y}'` but the
 * index entry is `global.x.y`. We retry with the same chain
 * `resolveValue` uses for alias resolution: exact, mode-stripped,
 * lead-segment-strip, suffix-match.
 *
 * Returning null lets the caller fall through to the literal-under-
 * cursor branch instead of opening an empty picker.
 */
function findPivotByReference(
  tokens: readonly DesignToken[],
  ref: string,
): DesignToken | null {
  // Single shared resolver — same chain used by the analyser for broken-
  // ref detection. Covers exact, binding-prefix strip, mode-segment
  // strip, camelCase ↔ dot drift, and dash-form fallback in one pass.
  const tokenNames = new Set(tokens.map((t) => t.name));
  const resolved = resolveReference(ref, tokenNames);
  if (resolved) {
    return tokens.find((t) => t.name === resolved.tokenName) ?? null;
  }
  // Suffix-match fallback — handles the JS_OBJECT_PATH alias case where
  // the indexer flattened beyond what `resolveReference`'s leading-strip
  // covers (e.g. parser emitted `500` for `primitive.primary.500`).
  if (ref.includes(".")) {
    const needle = "." + ref;
    const suffix = tokens.find((t) => t.name.endsWith(needle));
    if (suffix) return suffix;
  }
  return null;
}

function referenceAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): TokenRefHit | null {
  // Order matters — try the most specific patterns first so the
  // replace range covers as much of the original call as possible.
  // For instance, `var(--x)` must beat the bare `--x` regex so the
  // replacement overwrites the whole call expression, not just the
  // identifier inside it.

  // 1. CSS — `var(--x)` and `var(--x, fallback)`. We accept either
  //    with or without a fallback so a user pressing Alt+T on a
  //    long `var(--token, 14px)` still gets the right range.
  const varCallRange = doc.getWordRangeAtPosition(
    pos,
    /var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*(?:,[^)]*)?\)/,
  );
  if (varCallRange) {
    const m = doc.getText(varCallRange).match(/--[A-Za-z_][A-Za-z0-9_-]*/);
    if (m) return { name: m[0], replaceRange: varCallRange };
  }

  // 2. Style-Dictionary alias literal — `'{a.b.c}'`, `"{a.b.c}"`, or
  //    backticked. The replacement range INCLUDES the surrounding
  //    quotes so swapping it out preserves the JS/JSON syntax.
  const sdAliasRange = doc.getWordRangeAtPosition(
    pos,
    /["'`]\{[A-Za-z_][A-Za-z0-9_.\-]*\}["'`]/,
  );
  if (sdAliasRange) {
    const inner = doc.getText(sdAliasRange).match(/\{([A-Za-z_][A-Za-z0-9_.\-]*)\}/);
    if (inner) return { name: inner[1], replaceRange: sdAliasRange };
  }

  // 3. CSS custom property name — bare `--x`.
  const cssRange = doc.getWordRangeAtPosition(pos, /--[A-Za-z_][A-Za-z0-9_-]*/);
  if (cssRange) {
    return { name: doc.getText(cssRange), replaceRange: cssRange };
  }

  // 4. SCSS variable — `$x`.
  const scssRange = doc.getWordRangeAtPosition(
    pos,
    /\$[A-Za-z_][A-Za-z0-9_-]*/,
  );
  if (scssRange) {
    return { name: doc.getText(scssRange), replaceRange: scssRange };
  }

  // 5. JS runtime property access — `colors.PRIMARY_500`. Two or
  //    more dot-separated identifiers; one-segment idents are skipped
  //    on purpose (would catch every plain variable name).
  const propAccessRange = doc.getWordRangeAtPosition(
    pos,
    /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$0-9][A-Za-z0-9_$]*)+/,
  );
  if (propAccessRange) {
    const name = doc.getText(propAccessRange);
    return { name, replaceRange: propAccessRange };
  }

  return null;
}

/** Find the literal containing the cursor, if any. */
function literalAt(editor: vscode.TextEditor): Hit | null {
  const text = editor.document.getText();
  const offset = editor.document.offsetAt(editor.selection.active);
  for (const hit of findLiterals(text)) {
    if (offset >= hit.startOffset && offset <= hit.endOffsetExclusive) {
      return hit;
    }
  }
  return null;
}

// ─── Candidate ordering ─────────────────────────────────────────────────

function byName(a: DesignToken, b: DesignToken): number {
  return a.name.localeCompare(b.name);
}

/**
 * Returns every token of [category] (minus [excludeName]) sorted
 * alphabetically. Names in [bringToTop] are floated to the top of the
 * list while preserving their input order — used so a hardcoded literal
 * that maps to multiple tokens shows those matches first.
 */
function sortedSiblings(
  all: readonly DesignToken[],
  category: TokenCategory,
  excludeName?: string,
  bringToTop?: readonly string[],
): DesignToken[] {
  const inCategory = all.filter(
    (t) => t.category === category && t.name !== excludeName,
  );
  const top: DesignToken[] = [];
  const rest: DesignToken[] = [];
  const topSet = new Set(bringToTop ?? []);
  for (const t of inCategory) {
    if (topSet.has(t.name)) top.push(t);
    else rest.push(t);
  }
  // Preserve input order of bringToTop list.
  top.sort((a, b) => (bringToTop?.indexOf(a.name) ?? 0) - (bringToTop?.indexOf(b.name) ?? 0));
  rest.sort(byName);
  return top.concat(rest);
}

// ─── Picker (delegated to the custom webview) ───────────────────────────

/**
 * Wraps the `alternativesPicker` host launcher with the AltContext
 * shape this file already builds. Lets the rest of the action stay
 * UI-agnostic — `showPicker` doesn't know whether the picker is a
 * webview, a QuickPick or something else.
 */
async function showPicker(
  ctx: AltContext,
  context: vscode.ExtensionContext,
): Promise<DesignToken | null> {
  return openAlternativesPicker(
    context,
    {
      title: `Replace \`${truncate(ctx.replaceText, 40)}\``,
      subtitle: ctx.summary,
      candidates: ctx.candidates,
      pivot: ctx.pivot,
    },
    {
      viewColumn: vscode.ViewColumn.Beside,
      autoDisposeOnBlur: true,
    },
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n - 1) + "…" : s;
}

// ─── Replacement ────────────────────────────────────────────────────────

async function applyReplacement(
  editor: vscode.TextEditor,
  ctx: AltContext,
  token: DesignToken,
): Promise<void> {
  // For JS_OBJECT_PATH replacements, re-inject the mode segment from
  // the original ref so `'{global.modeLight.x.y}' → '{…modeLight.x.z}'`
  // instead of `'{…x.z}'`. Mirrors TokenAlternativesShower.replaceToken
  // on the IntelliJ side. Non-JS kinds (CSS var, SCSS) pass straight
  // through `tokenExpression`.
  const replacement =
    token.kind === "JS_OBJECT_PATH" && ctx.sourceRefName
      ? buildJsObjectReplacement(token, ctx.sourceRefName, editor.document, ctx.replaceRange)
      : tokenExpression(token);
  // Two contextual adjustments before the edit lands:
  //   1. expand the range to swallow surrounding quotes when the
  //      literal sits inside a `'...'` pair (avoids `''{path}''`),
  //   2. rewrite the replacement itself when we're inside a
  //      backticked CSS-in-JS template — there `'{path}'` isn't
  //      valid CSS; we emit `${dt('path')}` instead.
  const adjustedRange = expandRangeForJsQuotes(editor.document, ctx.replaceRange);
  const adjustedText = adjustReplacementForContext(
    editor.document,
    adjustedRange,
    replacement,
  );
  await editor.edit((b) => b.replace(adjustedRange, adjustedText));
}

/**
 * Builds the source-text replacement for a `JS_OBJECT_PATH` token,
 * preserving:
 *   • the mode segment (`modeLight` / `modeDark`) found in the original
 *     reference, re-injected at the same path index;
 *   • the wrapper form (`'{…}'` vs `dt('…')`) the user already had —
 *     `dt(…)` stays a function call, plain Style-Dictionary aliases
 *     stay quoted literals.
 *
 * Note: the indexed `token.name` is canonical (mode-stripped). Mode is
 * inherited from the source — that's how IntelliJ does it and it keeps
 * "swap colour but stay in the same light/dark column" intuitive.
 */
function buildJsObjectReplacement(
  token: DesignToken,
  sourceRefName: string,
  doc: vscode.TextDocument,
  range: vscode.Range,
): string {
  const rawMode = rawModeSegmentOf(sourceRefName);
  const modeIdx = modeSegmentIndex(sourceRefName);
  // Preserve the source's segment separator. PrimeUIX-derived setups
  // sometimes write `{token-modeLight-form-…}` (dashes) — emitting a
  // dotted replacement there would mix conventions inside one file.
  const sep = pathSeparator(sourceRefName) ?? ".";
  const withMode =
    rawMode !== null && modeIdx >= 0
      ? injectModeSegment(token.name, rawMode, modeIdx, sep)
      : sep === "-"
        ? token.name.replace(/\./g, "-")
        : token.name;
  // Look at the current text to decide between the two wrapper forms.
  const existing = doc.getText(range);
  const dtMatch = existing.match(/^dt\(\s*(['"`])/);
  if (dtMatch) {
    const quote = dtMatch[1];
    return `dt(${quote}${withMode}${quote})`;
  }
  return `'{${withMode}}'`;
}
