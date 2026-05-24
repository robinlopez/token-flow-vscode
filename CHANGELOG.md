# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/) — versioning [SemVer](https://semver.org/).

## [0.1.2] — 2026-05-24

### Added
- **Multi-criteria Semantic Scoring** — The suggestion engine now ranks candidates based on structural Tiers (Semantic > Component > Primitive) and semantic Roles (Surface, Content, Stroke, Effect) inferred from the surrounding CSS property context, rather than falling back to naive name-length sorting.


## [0.1.1] — 2026-05-23

### Added
- **DynamicCssVarIndex** — global indexing of contextual CSS variables across the workspace (`CSS`, `SCSS`, `Vue`, `React`, `Angular`).
- **Show Contextual Variable References (Ctrl+T / Alt+T)** — triggering "Show Alternatives" on a known contextual variable now opens a QuickPick listing all its declarations and usages across the project (sorted by static vs runtime).
- **Broken Reference Tolerance** — Contextual CSS variables that exist in the project are no longer flagged as broken references by the analyser.
- **Library Visual Mode** — a new visual presentation mode for tokens aimed at designers and integrators. Switch between "List Mode" and "Visual Mode".
  - **Colors**: Rich color swatches on checkerboards with dynamic rendering.
  - **Metrics**: Visual scale previews for spacing, radius, and shadows sorted numerically.
  - **Responsive & Themes**: Localised sub-variant selection (e.g., light/dark, tablet/desktop) directly per category header in both list and visual modes.
  - **Accordion Polishing**: Collapsible groups with elegant counters and dynamic SVG chevron animations.
- **Robust Variant Parsing** — Major improvements to how `parseCondition` detects responsive breakpoints (`min-width`, `max-width`, rem/px) and theme classes directly from SCSS maps or CSS files.

## [0.1.0] — 2026-05-23

First public release.

### Changed
- **Show Token Alternatives (Alt+T) — now a custom webview picker**.
  The native `vscode.window.showQuickPick` had two unfixable issues
  for a designer-grade UX:
  - `QuickPickItem.iconPath` is unreliable across recent VSCode
    builds (Uri shape silently no-ops; the `{ light, dark }`
    workaround also fails on some setups). Result: no color
    swatches.
  - `QuickPickItemKind.Separator` rows render inline with the next
    item rather than between groups — the user reported the
    "divider appears against the first row".
  The new picker is a `WebviewPanel` opened in `ViewColumn.Active`
  with a centered modal-style card. Full rendering control means:
  - **Real CSS pastilles** (`background-color: #hex`) on every
    COLOR token, with `inset` hairline outlines so light swatches
    stay visible on light themes and vice versa.
  - **Group dividers between groups** (vertical breathing room
    above each header, no inline-with-row glitch).
  - **Keyboard navigation**: `↑` / `↓` move selection, `Enter`
    selects, `Esc` cancels, typing filters live with the same
    multi-term `[\s\-_]+` tokenisation as the Library.
  - **Mouse hover** preview-selects (matches IntelliJ).
  - **Footer hints** (`↑ ↓ navigate`, `↵ select`, `Esc cancel`).
  - **Pivot pre-selection**: the picker opens with the keyboard
    cursor on the pivot's row (or row 0 if no pivot).
  - Name-prefix grouping algorithm is unchanged — only the
    rendering layer changed.

  Implementation: new `views/alternativesPicker.ts` host +
  `webview/alternatives/{main.ts,style.css}` client + protocol
  additions (`WireAltCandidate`, `WireAltGroup`, `AltHostMessage`,
  `AltClientMessage`). The previous native-QuickPick code (~210 LOC
  of buildPickerItems / buildPickItem / iconPath plumbing) is gone
  — `showAlternatives.ts` now delegates straight to
  `openAlternativesPicker`.

### Added
- **Library — multi-term search** (matches IntelliJ): typing
  `"informative content"` now finds `--token-informative-highlight-content-hover`.
  Search tokenises on `[\s\-_]+`, AND-matches every term against the
  name + resolved value, order-insensitive.
- **Library — kind filter** (matches IntelliJ funnel popup): a second
  filter row slices the Library by **CSS** / **SCSS** / **JS-JSON**
  alongside the category chips. Chips for kinds not present in the
  index stay hidden so the row stays compact on stylesheet-only
  projects.
- **Library — variant popover** on the `+N` badge: hover (or click,
  or keyboard focus) renders the per-condition variant table as a
  real HTML popover with theme-grouped headers and inline color
  swatches. Replaces the previous raw-markdown browser tooltip.
  Cancel-on-leave includes a 200ms grace period so moving the cursor
  from badge to popover keeps it open.
- **Library — copy & goto buttons** on each row, hover-revealed:
  - `⎘` copies the canonical insertion form (`var(--x)`, `$x`,
    `'{path}'`) to the system clipboard via
    `vscode.env.clipboard.writeText`. Status-bar message confirms.
  - `↗` navigates to the declaration (was previously the row click).
- **Library — drag-and-drop** rows into the editor. The DataTransfer
  payload is the per-kind source-code form, so dropping
  `--color-primary-500` into an `.scss` file inserts `var(--color-primary-500)`
  at the drop position. Native VSCode `text/plain` drop handling.

### Fixed
- **Library search swallowed trailing spaces**. The host
  `setQuery` handler used to `.trim()` before storing, then echo the
  trimmed value back via `filterState`; the client overrode the
  input value, eating the user's space as soon as it was typed.
  Three changes:
  - Host stores the raw value (only treats pure-whitespace as `null`).
  - Client's `syncSearchInput` skips when the input has focus —
    state-back-broadcasts never compete with active typing.
  - Multi-term search treats spaces as term separators, so the
    matching pipeline doesn't depend on edge-trimming.

### Changed
- **Library — rows no longer navigate on whole-row click**. The
  click target moved to the explicit `↗` button at the end of each
  row. Rows now have a `grab` cursor to surface drag-and-drop
  affordance. Goto declaration via the icon, copy via `⎘`, variants
  via the badge hover.

### Added
- **Settings webview** — dedicated full-tab editor for scopes, opened
  via the status-bar item, the `Token Flow: Configure Scopes…`
  command or the `$(settings-gear)` button on the Library view title.
  Master-detail layout: scope list on the left, detail panel on the
  right with name + root-path fields and three path sections
  (Sources, Whitelist, Excludes), each with native folder/file
  pickers. Writes go to **workspace** settings — the User-vs-Workspace
  tab of the native VSCode settings UI is sidestepped entirely.
- **`whitelistPaths` + `excludedPaths` on every scope**:
  - `whitelistPaths` files are indexed and tagged `external: true` —
    their tokens show up in Hover / Completion / Library (catalogue
    convenience) but are excluded from Hardcoded-replacement
    candidates and Analyse project-health metrics.
  - `excludedPaths` files are skipped by Hardcoded diagnostics, the
    Hardcoded panel and the Analyse "Top hardcoded" aggregation.
    Equivalent of the IntelliJ `analysisExcludedPaths`.
- **`DesignToken.external: boolean`** — propagated from `whitelistPaths`
  through the resolver to every consumer.

### Changed
- Status-bar item now opens the new Settings webview (instead of the
  filtered `workbench.action.openSettings` JSON view).
- `tokenFlow.openScopeSettings` command renamed to
  `tokenFlow.openSettings` (kept under the same palette title so the
  user-facing label doesn't move).

### Added
- **Go to Token Declaration** — Ctrl+Click / F12 / Peek on
  `var(--token)`, `--token` or `$token` now jumps to the token's
  declaration via VSCode's native Definition flow. Scope-aware: only
  jumps within the active scopes.

### Added
- **Named scopes** — `tokenFlow.scopes` array configures multiple
  scopes (`{ name, rootPath, sourcePaths }`), each declaring its own
  token catalogue. The active editor's file path picks the deepest
  matching scope automatically; only that scope's tokens (plus every
  common scope) are proposed by hover, completion, alternatives, the
  Library panel, the Hardcoded panel and the diagnostics. Mirrors the
  IntelliJ multi-scope UX.
  - `DesignToken.scope: string` records which scope indexed each
    token. Defaults to `"common"`.
  - `ActiveScopeTracker` (host-side singleton) is the single source of
    truth for "which scopes apply to the active editor?". Listens to
    active-editor changes and settings updates; emits `onDidChange`
    only when the resolved set actually moves.
  - Status-bar item shows the current scope name (`$(layers) mobile`)
    when a stylesheet is focused. Click to open the
    `tokenFlow.scopes` setting.
  - New command `Token Flow: Configure Scopes…` opens the settings
    UI filtered to `tokenFlow.scopes`.
  - `tokenFlow.sourcePaths` is preserved as a **back-compat** fallback:
    when `tokenFlow.scopes` is empty, the flat sourcePaths are wrapped
    into an implicit common scope so existing configs keep working.
  See `SHARED_LOGIC.md` §13 for the resolution rule.

### Fixed
- **False positives on token declarations** — `LiteralFinder` no longer
  flags the right-hand side of token declarations as hardcoded.
  `"token-name": #abc,` (quoted SCSS map entry), `$name: #abc` and
  `--name: #abc` are now recognised as declarations; only plain CSS
  property uses (`color: #abc`, `padding: 14px`) get flagged. The
  check runs against the wrapper-expanded replace range, so
  `$padding: rem-calc(14px)` also gets skipped (without that, the
  panel would have offered `rem-calc(14px) → var(--padding)`, a
  circular replacement). Affects the editor diagnostics, the
  Hardcoded panel and the Analyse "top hardcoded" list.

### Changed
- **Hardcoded panel now follows the active editor** — replaces the
  previous workspace-wide scan, matching the IntelliJ tool window
  behaviour. Open a stylesheet and the panel shows that file's hits;
  switch to another file and the panel re-scans automatically. Debounced
  re-scan on document edits keeps the panel in sync as you type. The
  Analyse dashboard keeps the workspace-wide aggregation under its
  "Top hardcoded values" block.
- **Hardcoded rows now ship rich actions and inline color swatches** —
  each row renders as `[swatch] literal → [swatch] candidate :line
  [▾] [⌖] [↩]`:
  - The two swatches mirror the IntelliJ row's left/right pastilles
    (CSS background-color, parsed via the shared `colorParser` so
    every CSS color form lights up).
  - `↩` applies the replacement (workspace edit on the host side,
    using the same wrapper-expanded range the editor lightbulb uses).
  - `⌖` jumps to the source line.
  - `▾` cycles through alternative candidates when a literal matches
    more than one token; a `i/N` counter shows the cursor position.

### Added
- **Analyse dashboard** — full-tab webview opened via
  `Token Flow: Open Analyse Dashboard` (or the new `$(graph)` button
  on the Library title bar). Four blocks:
  - **Top-line metrics** — tokens indexed, hardcoded hits across the
    workspace, source-file count.
  - **Tokens per category** — horizontal bar chart driven by VSCode's
    chart-palette CSS variables (themable across light/dark/HC).
  - **Token sources** — files ranked by tokens declared; click a row
    to open the source file.
  - **Top hardcoded values** — literals aggregated by value, ordered
    by occurrence count so the highest-leverage cleanup targets are
    immediate. Click jumps to the first occurrence.
  Auto-refreshes on `scanner.onDidChange`. Singleton: re-running the
  command on an already-open dashboard reveals + refreshes it
  instead of opening a duplicate tab.

### Added
- **Hardcoded values panel** — second webview in the Token Flow
  activity-bar container. Lists every workspace-wide literal that
  matches an indexed token, grouped by file. Each row shows the
  literal, the top candidate token name, the source line, and a
  `+N more` badge when there are alternative candidates. Click a row
  to jump to the source line in the editor.
  - Runs the existing `findLiterals` + `TokenValueIndex.lookupAcross`
    pipeline over every stylesheet file in the workspace (honors
    `tokenFlow.sourcePaths` when set).
  - Re-aggregates automatically on `scanner.onDidChange`. Concurrent
    invocations coalesce so a rapid sequence of file edits doesn't
    trigger N parallel scans.
  - Title-bar Refresh button for manual re-scans.

### Changed
- **Library is now a webview** — replaces the native TreeView. Tokens
  are rendered as rich rows with **inline color swatches** (filled disks
  driven by the resolved value, with the same `parseColor` pipeline as
  the hover popup), a **two-line name + value preview**, a **variant
  count badge**, and a category-glyph fallback for non-color tokens.
  The view ships with a built-in **search field** and **category chips**
  inside the panel header so filtering doesn't require palette
  round-trips. Looks closer to the IntelliJ tool window — the only
  trade-off is webview lifecycle (a brief reload-and-rehydrate
  when the view is hidden+shown, mitigated by
  `retainContextWhenHidden`).

### Removed
- `tokenFlow.searchTokens` and `tokenFlow.filterCategories` palette
  commands. The Library webview owns both UI affordances now — the
  in-panel search field is faster than the QuickPick round-trip and the
  category chips are always visible.
- `views/libraryTreeProvider.ts` and `views/libraryFilterState.ts`. The
  webview provider takes over both responsibilities.

### Added
- **Library filters** — three new title-bar buttons on the Library view:
  - **Search** (`$(search)`): an InputBox that filters tokens by name
    OR resolved value (case-insensitive substring).
  - **Filter by category** (`$(filter)`): a multi-select QuickPick over
    the categories present in the index. Empty selection = show all.
  - **Clear filters** (`$(clear-all)`): only visible when a filter is
    active (driven by the `tokenFlow.library.hasFilters` context key).
  The active filter is summarised as the view's `description`
  (e.g. `2 cat · "primary"`). State is in-memory only — resets on
  window reload, matching the UX of every other VSCode sidebar filter.

### Added
- **Show Token Alternatives** (`Alt+T`) — Quick Pick that surfaces sibling
  tokens of the same category. Works on:
  - **Token references** (`var(--x)`, `$x`) → siblings of the same
    category (alphabetical sort, mirrors IntelliJ v0.1.2).
  - **Hardcoded literals** (`14px`, `#fff`, `200ms`) → exact-value
    matches floated to the top, then every same-category sibling so the
    user can navigate to a related token even without an exact value
    match.
  Selection performs an `editor.edit` replacing the appropriate range
  with the per-kind insertion form (`var(--name)`, `$name`, etc.).

### Added
- **Hardcoded-value diagnostics + Replace-with-token quick-fix** —
  literals in stylesheet files (`#fff`, `14px`, `rgba(0,0,0,.5)`,
  `200ms`) that match an indexed token are now surfaced as `Hint`-level
  diagnostics with a yellow underline. Hovering or clicking the
  lightbulb gives one quick-fix per candidate token; the top match is
  marked as `isPreferred` so `editor.action.autoFix` picks it.
  - Ports `LiteralFinder.kt` (hex / functional colors / lengths /
    durations) and `TokenValueIndex.kt` (canonical-px normalisation for
    spacing-like categories, canonical RGBA for colors).
  - Skips JS-specific behaviours from the Kotlin side (unitless number
    detection, partial-string handling) — those are stylesheet-only
    paths in the VSCode MVP. See SHARED_LOGIC.md §12.
  - `var(--token, fallback)` fallback expressions are excluded.
  - Transparent wrapper expansion (`rem-calc(14px)` → `var(--token)`)
    is supported.

### Added
- **Color swatches for every CSS color form** — `ColorParser.kt` is now
  ported in `ui/colorParser.ts` (hex 3/4/6/8 · `rgb()`/`rgba()` ·
  `hsl()`/`hsla()` · named colors). The Library swatch previously only
  rendered for pure hex literals; tokens defined as `rgba(0,0,0,.5)` or
  `hsl(120, 50%, 60%)` now get a proper circular pastille too.
- **Transparency-aware swatches** — semi-transparent colors render over a
  4×4 grey checkerboard so they're visually distinct from opaque siblings.
- **Canonical swatch cache** — files are now stored by their 8-digit RGBA
  hash (`rrggbbaa.svg`), so `#ff0000`, `rgb(255, 0, 0)` and `red` share
  the same cached asset.

### Added
- **Library sidebar view** — new "Token Flow" entry in the activity bar with
  a two-level tree (category → tokens). Color tokens get a live circular
  swatch icon generated as an on-disk SVG cached under `globalStorage/swatches/`.
  Other categories use codicon hints (`symbol-ruler`, `symbol-text`, …).
  Tree-item tooltips show the same markdown popup as the hover provider —
  resolved value + per-condition variant table with multi-theme grouping.
- **`tokenFlow.revealDeclaration` command** — internal, wired to single-click
  on a Library tree item; opens the source file and centers the caret on
  the token's declaration. Hidden from the command palette.
- Refresh button on the Library view title bar (`tokenFlow.refreshIndex`).

### Changed
- Markdown rendering of a `DesignToken` extracted from `HoverProvider` into
  `ui/tokenMarkdown.ts` so the Library tree tooltips reuse the same code
  path. `parseCondition` lives in the same module and is now the canonical
  TS port of `VariantTableHtml.parseCondition` (see SHARED_LOGIC.md §6).
- `tokenFlow.refreshIndex` and `tokenFlow.showAllTokens` titles split into
  `title` + `category` so they appear as "Token Flow: …" in the command
  palette consistently.

## [0.1.0] — initial scaffold

### Added
- TypeScript project bootstrap (esbuild bundling, tsconfig strict, npm scripts).
- `TokenScanner` — workspace scan for SCSS/SASS/CSS files with the same regex
  set as the IntelliJ plugin v0.1.2 (`SCSS_VAR_REGEX`, `CSS_VAR_REGEX`,
  `SCSS_MAP_KEY_REGEX`). SCSS-specific patterns only run on `.scss`/`.sass`
  files; CSS custom properties are extracted from all stylesheet files.
- `DeclarationContext.describeAt` — direct port of the Kotlin implementation;
  walks back from a token offset and surfaces the chain of enclosing CSS rule
  blocks and SCSS map keys (nested `$themes -> "themeOne" -> "light"` produces
  `themeOne light`).
- `TokenCategorizer.categorize` — name-then-value heuristics mirroring
  `TokenCategorizer.kt` (8 categories: COLOR / SPACING / TYPOGRAPHY / SHADOW /
  RADIUS / DURATION / Z_INDEX / OTHER).
- `HoverProvider` — markdown rendering with multi-theme grouped header for
  tokens whose variants span 2+ themes.
- `CompletionItemProvider` — triggers after `var(--` (CSS/LESS) and `$`
  (SCSS/SASS); alphabetical sort matching the IntelliJ v0.1.2 choice.
- Commands: `tokenFlow.refreshIndex`, `tokenFlow.showAllTokens`.
- Settings: `tokenFlow.sourcePaths`, `tokenFlow.hover.enabled`.
- `SHARED_LOGIC.md` — invariants shared with the IntelliJ plugin.

### Not yet ported (planned)
- TS/JS preset / runtime theme parsers (`JsObjectTokenParser`,
  `JsTokenFileParserRegistry`).
- Hardcoded-value diagnostics + quick-fix.
- Library tree view (sidebar).
- Quick Pick "Show Token Alternatives" (Alt+T equivalent).
- Analyse webview.
