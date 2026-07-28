# Token Flow VSCode — Roadmap to IntelliJ parity

Tracks the remaining work to bring the VSCode plugin to feature parity
with the IntelliJ plugin. Each phase ships as one or more focused
commits; check off items as they land. PRs that change shared
behaviour should also update `SHARED_LOGIC.md` and tick the matching
item here.

## Status legend
- ✅ Done
- 🚧 In progress
- ⬜ Not started

---

## Phase 1 — Named scopes ✅

**Why first**: closes the structural gap the user pointed out — the
flat `tokenFlow.sourcePaths` setting doesn't reproduce the IntelliJ
UX where each scope has its own `rootPath` and the editor's open
file auto-selects the matching scope. Every downstream feature
(Library, Hardcoded, Hover, Completion, Alternatives) needs to be
scope-aware before any further parity work is meaningful.

### Tasks
- ✅ Settings schema: `tokenFlow.scopes: Array<{name, rootPath, sourcePaths}>`.
  Back-compat: `tokenFlow.sourcePaths` is wrapped into an implicit
  common scope when `tokenFlow.scopes` is empty.
- ✅ `src/scanner/scopeResolver.ts`: resolves active scope from the
  editor's URI — deepest non-common match wins; sourcePath hits beat
  rootPath hits.
- ✅ Model: `DesignToken.scope: string` (defaults to `"common"`).
- ✅ `TokenScanner` iterates configured scopes, dedupes files across
  scopes (first scope wins), tags each token with its origin scope.
- ✅ Consumers filter by `activeNames.has(token.scope)`:
  Library / Hardcoded panel / Hardcoded diagnostics / Hover /
  Completion / Show alternatives. The Analyse dashboard is intentionally
  workspace-wide for now (it surfaces project health stats; scoping
  would hide cross-scope incoherences).
- ✅ `ActiveScopeTracker` (host-side singleton) is the single source of
  truth; emits `onDidChange` only when the resolved set actually moves.
- ✅ Status-bar item shows the current scope with `$(layers)` glyph;
  click opens the `tokenFlow.scopes` setting.
- ✅ New `Token Flow: Configure Scopes…` palette command.
- ✅ Docs: `SHARED_LOGIC.md` §13, `README.md` configuration table +
  example, `CHANGELOG.md` `[Unreleased]` entry.
- ✅ Commit.

---

## Phase 2 — JS/TS parsers ⬜

**Why second**: unlocks support for TS/JS preset (Style-Dictionary,
PrimeUIX) and React-Native runtime themes. Without this, users
whose tokens live in `.ts`/`.js` files see an empty Library. Half
the real-world projects are probably in this category.

### Tasks
- ⬜ Port `JsObjectTokenParser.kt` (~250 LOC Kotlin) →
  `src/scanner/parsers/jsObjectTokenParser.ts`. Parses
  `export const X = { … }` / `export default { … }` and emits
  one leaf token per nested string-value entry. Path-aware
  (`global.modeLight.surface.default`).
- ⬜ Port `JsTokenFileParserRegistry.kt` (~150 LOC) →
  `src/scanner/parsers/jsTokenFileParserRegistry.ts`. Dispatches
  to "preset" (string-leaf) vs "runtime" (typed-const) modes.
- ⬜ Port `TokenNameParser.kt` helpers (`modeSegmentOf`,
  `stripModeSegment`) — needed for both the parser and the alias
  resolution.
- ⬜ Extend `TokenScanner.scanText` to scan `.ts/.tsx/.js/.jsx/.mjs/.cjs`
  via the registry. New `JS_RUNTIME_PROPERTY` and `JS_RUNTIME_FUNCTION`
  kinds already exist on the wire — wire them up to the new parsers.
- ⬜ Extend alias resolution: `JS_RUNTIME_ALIAS_REGEX`,
  `JS_OBJECT_ALIAS_REGEX` with lead-segment strip + suffix-match
  fallbacks (mirrors `TokenScanner.kt`'s `resolveValue`).
- ⬜ Helper extraction (`spacing(scale)`, `normalize(size, ref)`) —
  emit `JS_RUNTIME_FUNCTION` tokens, store `functionUnit` for
  linear helpers (mirrors `JsObjectTokenParser.helpers`).
- ⬜ Suggestion engine helper-aware: `12px` hardcoded yields
  `spacing(1.5)` when a helper has `functionUnit = 8`.
- ⬜ `package.json` `activationEvents`: add TS/JS languages so the
  extension activates on them.
- ⬜ Hover / completion / alternatives plug in via existing
  `tokenExpression(token)` — no per-kind branches needed downstream.
- ⬜ Tests on real fixtures (PrimeUIX preset, RN theme).
- ⬜ Docs + commit.

---

## Phase 3 — Go to Token Declaration ✅

**Why third**: small file, big UX win. Ctrl+Click on `var(--x)`
or `$x` opens the declaration. Native VSCode "Go to Definition"
flow — works with peek view too.

### Tasks
- ✅ `src/providers/tokenDefinitionProvider.ts`:
  `DefinitionProvider` returning a `Location` for token references
  (`var(--x)`, bare `--x`, `$x`). Scope-aware: only jumps within the
  active scopes.
- ✅ Registered against the stylesheet selector in `extension.ts`.
- ✅ Extend to TS/JS so `'{path.to.token}'` and `colors.PRIMARY_500`
  jump too.

---

## Phase 4 — Polish 🚧

Single commit grouping small wins. The Settings webview (originally
listed under Phase 6) shipped here because the user surfaced it as a
blocker for testing scopes.

### Tasks
- ✅ **Settings webview** — master-detail editor for scopes with
  native file pickers + workspace-target persistence. Adds
  `whitelistPaths` and `excludedPaths` per scope (full plumbing
  through Hardcoded + Analyse + Diagnostics).
- ✅ **Library multi-term search** (matches IntelliJ): tokenise on
  `[\s\-_]+`, AND-match every term. Fixes the trailing-space-eaten
  bug.
- ✅ **Library kind filter** (CSS / SCSS / JS-JSON) — second chip row
  alongside categories.
- ✅ **Library variant popover** on the `+N` badge — HTML table with
  theme-grouped headers and inline swatches; replaces the raw-markdown
  browser tooltip.
- ✅ **Library copy + goto buttons** per row, hover-revealed. The
  whole-row click is gone — click the `↗` icon to navigate, `⎘` to
  copy.
- ✅ **Library drag-and-drop** — `dataTransfer.setData("text/plain",
  insertText)` on row dragstart; native VSCode drop handling inserts
  the canonical reference.
- ✅ **Show Token Alternatives — custom webview picker** (replaces
  native QuickPick). Real CSS color swatches, proper group dividers,
  pivot pre-selection, keyboard + mouse navigation.
- ✅ Hardcoded panel filter chips (COLOR / LENGTH / DURATION).
- ✅ Hardcoded panel sort options (by line, by candidate count).
- ✅ Hardcoded "Replace all in file" batch action.
- ⬜ Settings: hover delay slider, autocomplete toggle (schema present,
  providers don't read them yet).

---

## Phase 5 — Analyse dashboard polish 🚧

**Why last**: largely visual. Users can ship without the gauge, but
the IntelliJ side is recognisable for its A→F health score, so this
matters for the "wow factor" once everything else is solid.

### Tasks
- ✅ Port `DesignSystemAnalyzer.kt` (~600 LOC Kotlin) →
  `src/scanner/designSystemAnalyzer.ts`. Computes:
  - Global score (A→F) with 5 sub-axes (added Reference integrity)
  - Semantic coherence — `*-color-*` tokens whose resolved value
    is a length, etc.
  - Usage coverage — `X/Y tokens used` per source file
  - Duplication — tokens sharing the same full signature across files
  - Unused — declared but never referenced (regex scan over the
    workspace, excluding declarations)
  - Hardcoded pressure — clusters of repeated literals
  - Reference integrity — broken `var(--…)` / `$…` / `'{…}'` refs
- ✅ Update protocol (`WireAnalysisReport`) to carry the full
  analysis: sub-scores, clusters, broken refs, coverage sources.
- ✅ Webview client renders:
  - Circular SVG gauge for the global score (red/amber/green band)
  - 5 sub-score cards in a 2-column grid
  - Accordion sections for hardcoded clusters (with per-occurrence
    drilldown), broken refs, unused, duplicates, incoherences,
    coverage. Target button per row jumps to the source location.
- ✅ Cache the analysis — relies on `TokenScanner` cache;
  auto-refreshes on `scanner.onDidChange`.
- ✅ Broken-reference parity with IntelliJ v0.2.4 (0.1.6) —
  `SHARED_LOGIC.md` §16:
  - Placeholder guard (`scanner/placeholderGuard.ts`) — a `'{…}'`
    argument of `replace` / `split` / `instant` / … is a runtime
    placeholder, dropped before the coverage counter.
  - Vocabulary filter (`scanner/tokenPathShape.ts`) — a `'{…}'` name
    outside the project's token vocabulary isn't a reference.
  - `tokenFlow.externalPrefixes` (global) ∪ per-scope
    `externalPrefixes` — framework-injected variables and component
    customisation APIs are neutral, never broken.
  - Reference collection extracted to `scanner/referenceScan.ts`
    (`vscode`-free, unit-tested via `npm test`).

---

## Bookkeeping

Every commit that touches shared behaviour:
- ☐ Update `SHARED_LOGIC.md` if the contract changes.
- ☐ Tick the matching task in this file.
- ☐ Cross-check the IntelliJ side hasn't drifted (the
  `Last sync'd against:` footer in `SHARED_LOGIC.md`).
