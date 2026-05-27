// Message protocol shared by every host ↔ webview pair. Compiled into
// BOTH bundles — the host side uses it to type-check `webview.postMessage`
// calls, the client side uses the same types in its `window.addEventListener`
// handler. Single source of truth, no JSON schemas to keep in sync.
//
// Tokens cross the boundary as a serialisable subset of `DesignToken`:
// we drop `filePath`/`offset` from the wire payload (the host already
// knows them) and add a pre-computed `hex` for COLOR tokens so the
// webview can draw swatches with `background-color: var(--hex)` without
// having to parse colors on the client side.

import { TokenCategory, TokenKind } from "../../model/designToken";

// ─── Common payloads ────────────────────────────────────────────────────

/** One column of the variant table — primary first, then every variant. */
export interface WireVariantColumn {
  /** Theme grouping label (e.g. `themeOne`); null for non-grouped columns. */
  readonly theme: string | null;
  /** Sub-header (`light`, `dark`, `default`, `≥1024`, …). */
  readonly sub: string;
  /** Resolved value at this column. */
  readonly value: string;
  /** Canonical hex for COLOR values; null otherwise. Drives inline swatches. */
  readonly hex: string | null;
}

export interface WireToken {
  readonly name: string;
  readonly resolvedValue: string;
  readonly rawValue: string;
  readonly category: TokenCategory;
  readonly kind: TokenKind;
  readonly variantCount: number;
  /** Canonical lowercase `#rrggbb` or `#rrggbbaa`. Null when not parseable. */
  readonly hex: string | null;
  /**
   * Pre-computed column model the webview uses to render the variant
   * popover as a real HTML table (with swatches, not the markdown
   * fallback). Includes the primary as the first entry.
   */
  readonly variantColumns: readonly WireVariantColumn[];
  /**
   * Markdown tooltip body — the same multi-theme variant table the hover
   * provider builds. Kept on the wire as a fallback for tools that
   * can't render `variantColumns` (none right now, but reserved).
   */
  readonly tooltipMarkdown: string;
  /** Source-text replacement form — what a copy/insert action should emit. */
  readonly insertText: string;
}

export interface WireHardcodedCandidate {
  readonly name: string;
  /** Source-text replacement, ready to splice in (e.g. `var(--foo)`, `$foo`). */
  readonly replacement: string;
  /** Canonical lowercase `#rrggbb[aa]` when the candidate is a COLOR token. */
  readonly hex: string | null;
}

export interface WireHardcodedMatch {
  /** Workspace-relative path (e.g. `src/styles/button.scss`). */
  readonly relPath: string;
  /** Source line, 0-based. */
  readonly line: number;
  /** Inner literal text (`14px`, `#fff`). */
  readonly literal: string;
  readonly kind: "COLOR" | "LENGTH" | "DURATION";
  /** Canonical hex for COLOR literals — drives the row's left swatch. */
  readonly hex: string | null;
  /**
   * Absolute file offsets of the range an `apply` message should
   * overwrite. Covers the literal AND any transparent wrapper
   * (`rem-calc(14px)`) when applicable — same span the editor
   * lightbulb quick-fix uses.
   */
  readonly replaceStart: number;
  readonly replaceEndExclusive: number;
  readonly candidates: readonly WireHardcodedCandidate[];
}

// ─── Library ────────────────────────────────────────────────────────────

export type LibraryHostMessage =
  | { type: "tokens"; tokens: readonly WireToken[] }
  | {
      type: "filterState";
      query: string | null;
      categories: readonly TokenCategory[];
      kinds: readonly TokenKind[];
    }
  | {
      /**
       * Snapshot of which scopes apply to the active editor. The
       * Library renders this as a small strip above the search input
       * so the user always knows which token set they're looking at —
       * mirrors the status-bar item, but in-panel.
       */
      type: "scope";
      /** Deepest non-common scope ("mobile") or null when only the common scope is active. */
      specificName: string | null;
      /** All active scope names in resolution order — `[…, "common"]`. */
      activeNames: readonly string[];
      /** True when no stylesheet is the active editor. Drives a dimmed "no file selected" hint. */
      idle: boolean;
    };

export type LibraryClientMessage =
  | { type: "ready" }
  | { type: "revealToken"; name: string }
  | { type: "copyToken"; name: string }
  | { type: "showAlternatives"; name: string }
  | { type: "setQuery"; query: string }
  | { type: "toggleCategory"; category: TokenCategory }
  | { type: "toggleKind"; kind: TokenKind }
  | { type: "clearFilters" }
  | { type: "openSettings" };

// ─── Hardcoded ──────────────────────────────────────────────────────────

export type HardcodedHostMessage =
  | {
      type: "matches";
      /** Workspace-relative path of the file the matches come from. */
      relPath: string | null;
      matches: readonly WireHardcodedMatch[];
      scanning: boolean;
    }
  | { type: "scanning"; scanning: boolean }
  /** Active editor changed to a file the panel doesn't cover (binary, untitled, non-stylesheet, …). */
  | { type: "noActiveStylesheet" };

export interface WireHardcodedEdit {
  readonly relPath: string;
  readonly replaceStart: number;
  readonly replaceEndExclusive: number;
  readonly replacement: string;
}

export type HardcodedClientMessage =
  | { type: "ready" }
  | { type: "reveal"; relPath: string; line: number }
  | { type: "refresh" }
  | ({ type: "apply" } & WireHardcodedEdit)
  | {
      /**
       * Bulk apply — N edits in the active file atomically. Order is
       * irrelevant from the client's side: the host materialises a
       * single `WorkspaceEdit`, which VSCode applies against the
       * original document offsets (no left-to-right drift to worry
       * about as long as ranges don't overlap, which they cannot here
       * because each match owns a disjoint literal span).
       */
      type: "applyBatch";
      edits: readonly WireHardcodedEdit[];
    };

// ─── Analyse ────────────────────────────────────────────────────────────

export type Axis =
  | "SEMANTIC_COHERENCE"
  | "USAGE_COVERAGE"
  | "DUPLICATION"
  // Hardcoded literals split into two axes (parity with IntelliJ #19):
  //   • OPPORTUNITY — repeated literal with NO matching token (design gap)
  //   • DEBT        — literal whose token already exists (actionable fix)
  // The legacy HARDCODED_PRESSURE axis is replaced by these two.
  | "HARDCODED_OPPORTUNITY"
  | "HARDCODED_DEBT"
  | "REFERENCE_INTEGRITY";

export interface WireSubScore {
  readonly axis: Axis;
  readonly score: number;
  readonly weight: number;
  readonly caption: string;
}

/** A row referencing a token declaration — pre-flattened for the webview
 *  (the host owns absolute file paths; the wire only carries the
 *  workspace-relative path + offset/line). */
export interface WireTokenLocation {
  readonly name: string;
  readonly resolvedValue: string;
  readonly category: TokenCategory;
  readonly relPath: string;
  readonly basename: string;
  readonly offset: number;
  readonly line: number;
}

export interface WireIncoherence {
  readonly token: WireTokenLocation;
  readonly rationale: string;
}

export interface WireDuplicateCluster {
  readonly resolvedValue: string;
  readonly category: TokenCategory;
  readonly canonical: WireTokenLocation;
  readonly tokens: readonly WireTokenLocation[];
}

export interface WireHardcodedOccurrence {
  readonly relPath: string;
  readonly basename: string;
  readonly parent: string;
  readonly offset: number;
  readonly line: number;
}

export interface WireHardcodedCluster {
  readonly literal: string;
  readonly category: TokenCategory | null;
  readonly matchingTokenName: string | null;
  readonly occurrences: readonly WireHardcodedOccurrence[];
}

/**
 * Actionable-debt row: literal that already has a matching token in
 * the design system, grouped by `(literal + category)`. Mirror of
 * IntelliJ's `HardcodedValue`.
 *
 * `suggestedTokenName` is the most relevant existing token to apply.
 * The webview renders it next to the literal so the user knows what
 * the quick-fix would inject.
 */
export interface WireHardcodedValue {
  readonly literal: string;
  readonly category: TokenCategory | null;
  readonly suggestedTokenName: string | null;
  readonly suggestedTokenValue: string | null;
  readonly occurrences: readonly WireHardcodedOccurrence[];
}

export interface WireBrokenReference {
  readonly name: string;
  readonly relPath: string;
  readonly basename: string;
  readonly offset: number;
  readonly line: number;
}

export interface WireTokenSourceUsage {
  readonly relPath: string;
  readonly basename: string;
  readonly declared: number;
  readonly used: number;
  readonly ratio: number;
}

export interface WireCoverage {
  readonly tokenisedAssignments: number;
  readonly literalAssignments: number;
  readonly ratio: number;
  readonly sources: readonly WireTokenSourceUsage[];
}

/**
 * One option in the analyse scope combo. `id` is the value the host
 * receives back on `selectScope` — it carries enough info to rebuild
 * the original choice without round-tripping a full path.
 *
 *   • `"all"`              — analyse the whole project (every scope).
 *   • `"active"`           — use the active editor's file (host resolves
 *                             the deepest matching scope).
 *   • `"scope:<name>"`     — pin to a named scope.
 */
export interface WireScopeOption {
  readonly id: string;
  readonly label: string;
}

export interface WireScopeState {
  readonly options: readonly WireScopeOption[];
  readonly selectedId: string;
}

export interface WireAnalysisReport {
  readonly score: number;
  readonly grade: string;
  readonly subScores: readonly WireSubScore[];
  readonly incoherences: readonly WireIncoherence[];
  readonly duplicateClusters: readonly WireDuplicateCluster[];
  readonly hardcodedClusters: readonly WireHardcodedCluster[];
  /** Actionable-debt rows: literals whose token already exists. */
  readonly hardcodedValues: readonly WireHardcodedValue[];
  readonly coverage: WireCoverage;
  readonly brokenReferences: readonly WireBrokenReference[];
  readonly unusedTokens: readonly WireTokenLocation[];
  readonly totalTokens: number;
  readonly scannedFiles: number;
  readonly tookMs: number;
  /** Label of the analysed scope ("All project" for now). */
  readonly scopeLabel: string;
}

export type AnalyseHostMessage =
  | { type: "report"; report: WireAnalysisReport; scope: WireScopeState }
  | { type: "analysing"; scope: WireScopeState }
  /** Empty state — shown before the first run and after settings reset. */
  | { type: "idle"; scope: WireScopeState; message: string }
  /**
   * Silent in-place update of the scope picker — sent when the active
   * editor changes so the "Active editor (filename)" label stays fresh.
   * Must NOT clear the report or flip into the loading state.
   */
  | { type: "scopeUpdate"; scope: WireScopeState }
  /** Toggle the "analysis is out of date" banner shown above the report. */
  | { type: "stale"; stale: boolean };

export type AnalyseClientMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "selectScope"; id: string }
  | { type: "dismissStale" }
  | { type: "reveal"; relPath: string; line?: number; offset?: number };

// ─── Settings ───────────────────────────────────────────────────────────

/**
 * Wire-format snapshot of one configured scope. Mirrors
 * `ConfiguredScope` minus the derived `isCommon` flag (the client can
 * compute it from `rootPath`).
 */
export interface WireScope {
  readonly name: string;
  readonly rootPath: string;
  readonly sourcePaths: readonly string[];
  readonly whitelistPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly externalPrefixes: readonly string[];
}

/** Categorises the path-list field a `pickPath` / `removePath` action targets. */
export type ScopePathField = "sourcePaths" | "whitelistPaths" | "excludedPaths";

/**
 * Snapshot of the non-scope general preferences shown alongside the
 * Scopes editor. Kept as a flat record so the host can map directly to
 * `vscode.workspace.getConfiguration("tokenFlow").get(key)` without an
 * intermediate translation layer.
 */
export interface WirePreferences {
  /** `tokenFlow.alternatives.pickerStyle` */
  readonly pickerStyle: "webviewBeside" | "completion";
  /** `tokenFlow.hover.enabled` */
  readonly hoverEnabled: boolean;
}

export type SettingsHostMessage = {
  type: "config";
  scopes: readonly WireScope[];
  preferences: WirePreferences;
  /** Human-readable workspace name, surfaced in the panel header. */
  workspaceName: string | null;
  /** True when no workspace folder is open — disables the UI with a hint. */
  noWorkspace: boolean;
};

export type SettingsClientMessage =
  | { type: "ready" }
  | { type: "exportScopes" }
  | { type: "importScopes" }
  | { type: "addScope" }
  | { type: "removeScope"; index: number }
  | {
      type: "updateScopeField";
      index: number;
      field: "name" | "rootPath";
      value: string;
    }
  | { type: "pickRootPath"; index: number }
  | { type: "addPath"; index: number; field: ScopePathField }
  | {
      type: "removePath";
      index: number;
      field: ScopePathField;
      pathIndex: number;
    }
  | {
      /**
       * Updates a general (non-scope) preference. The host narrows the
       * value against `WirePreferences[key]` so a bad value from a
       * compromised webview can't corrupt settings.
       */
      type: "updatePreference";
      key: keyof WirePreferences;
      value: string | boolean;
    }
  | {
      /**
       * Opens VS Code's native Keyboard Shortcuts editor, filtered to
       * Token Flow's commands. We deliberately don't expose
       * keybindings as a setting — VS Code keybindings live in their
       * own system (keybindings.json, settings sync, the chord editor)
       * and bypassing that just to mirror it in our panel would mean
       * editing a global user file behind their back. This action is
       * the idiomatic redirect.
       */
      type: "openKeybindings";
    };

// ─── Alternatives picker ────────────────────────────────────────────────

/**
 * One candidate in the Alt+T picker. Pre-computed by the host so the
 * webview can render with zero JS-side parsing — the value column,
 * variant badge and color swatch all read straight from these fields.
 */
export interface WireAltCandidate {
  readonly name: string;
  /** Resolved value shown in the right column. */
  readonly value: string;
  /** Canonical `#rrggbb[aa]` for COLOR tokens. `null` for non-color. */
  readonly hex: string | null;
  /** Number of variants — surfaced as a `+N` badge when > 0. */
  readonly variantCount: number;
  /**
   * Codicon name for the icon column when no color swatch applies
   * (every non-COLOR row). Lets the client render an icon row that
   * stays aligned across mixed categories.
   */
  readonly categoryIcon: string;
}

/**
 * One group in the picker. `tokenIndices` indexes the parent
 * `tokens` array so the wire payload stays small even when groups
 * overlap (they don't today, but the indirection keeps options
 * open).
 */
export interface WireAltGroup {
  /** Header path segments (e.g. `["surface"]`, `["typography", "title"]`). */
  readonly pathSegments: readonly string[];
  readonly tokenIndices: readonly number[];
}

export type AltHostMessage = {
  type: "init";
  /** Top-of-picker title — usually `Replace \`<text>\``. */
  title: string;
  /** Secondary line — kind + match summary. */
  subtitle: string;
  tokens: readonly WireAltCandidate[];
  groups: readonly WireAltGroup[];
  /** Flat token index to highlight on open (0 if no preference). */
  preselectIndex: number;
};

export type AltClientMessage =
  | { type: "ready" }
  | { type: "select"; index: number }
  | { type: "cancel" };
