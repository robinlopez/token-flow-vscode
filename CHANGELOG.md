# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/) — versioning [SemVer](https://semver.org/).

## [0.1.6] — 2026-07-28

### Added
- **`tokenFlow.externalPrefixes`** — project-wide list of variable-name prefixes that are **valid but declared outside the design system**: framework-injected variables (`--p-` PrimeNG/PrimeVue, `--ion-` Ionic, `--mat-` / `--mdc-` Material, `--bs-` Bootstrap, `--vscode-`) or a component's own customisation API (`--ui-slider-`). Ports the IntelliJ `Scope.externalPrefixes` option, which had no VS Code equivalent, and adds a global tier on top of it. A matching reference is **neutral**: counted as tokenised (it is a variable, not a hardcoded value), never reported as broken, never added to `referenced` (so it can't mask an unused token), and no penalty on the reference-integrity axis. The effective set for a run is the global setting ∪ every active scope's own `externalPrefixes`, deduplicated. Comparison is `startsWith` on the **extracted** name, so a CSS prefix must be written with its leading dashes (`--ui-`, not `ui-`).
  - Editable from the **Settings** panel: a project-wide list under *Preferences* (with one-click chips for the common frameworks) and a per-scope list in the scope detail. `tokenFlow.scopes[].externalPrefixes` also gained its missing `package.json` schema entry, so hand-edited `settings.json` now gets completion and validation.
  - The main use case: a component that deliberately exposes an undeclared variable as its extension point — `height: var(--ui-slider-handle-size, #{$handle-size})` is an API, not a broken reference. Documented trade-off: prefer the narrowest prefix (`--ui-slider-` over `--ui-`), since a broad prefix also silences a genuine typo on an existing `--ui-…` token.

### Fixed
- **Message placeholders reported as broken references.** The Style-Dictionary alias syntax `'{color.primary}'` collides head-on with the most common placeholder convention in application code, so an Angular paginator like `template.replace('{first}', …).replace('{totalRecords}', …)` produced **6 phantom broken references** plus 6 phantom tokenised refs that inflated the coverage ratio. Same symptom with i18n (`translate.instant('{count}')`) and regex helpers (`raw.split('{sep}')`). Two independent layers now filter these out — each one alone neutralises the paginator, together they cover the variants:
  - **Syntactic guard** (`scanner/placeholderGuard.ts`, port of `LiteralFinder.kt`) — a `'{…}'` string that is an argument of `replace` / `replaceAll` / `split` / `test` / `t` / `instant` / `transform` / `format` / `sprintf` / … is a runtime placeholder. The enclosing callee is found by a bounded (400-char) backward walk to the nearest unmatched `(`, skipping nested calls and quoted arguments so `.replace('(', '')` doesn't unbalance it, and stopping at a statement or block boundary — which is what keeps `primary: '{color.primary}'` in an object literal safe.
  - **Vocabulary filter** (`scanner/tokenPathShape.ts`, port of `TokenPathShape.kt`) — asks whether the project declares any token the path could belong to. A CSS-only catalogue rejects every `'{…}'`; a dotted-path catalogue accepts a known namespace root and roots within one edit of one (so `'{color.primry}'` and `'{colr.primary}'` are still reported as *broken*, which is the point), and rejects `'{user.name}'` / `'{route.params.id}'` / `'{first}'`. The historic single-segment behaviour is preserved for catalogues with flat JS names.
  - Both filters run **before** the coverage counter, so the ratio no longer counts placeholders as tokenised assignments. `var(--x)`, `$x` and `dt('a.b')` are unambiguous and are not routed through either filter.

### Changed (internal)
- **`scanner/referenceScan.ts`** — the reference-collection loop moved out of `designSystemAnalyzer.ts` into a `vscode`-free module that is now the single normative implementation of the tokenised / external / dynamic / broken decision order (see `SHARED_LOGIC.md`). Made the rules unit-testable; the analyser is a thin caller.
- **`resolveReference`** accepts an optional `externalPrefixes` argument and returns the name flagged `external` when one matches — a safety net for call paths that bypass the analyser's main loop.
- **`npm test`** — the project gained a test suite. `esbuild.test.js` transpiles `src/test/*.test.ts` into `out-test/` and Node's built-in runner executes them; no new dependency. 57 cases cover the placeholder guard, the vocabulary verdicts and the end-to-end reference scan (including the `externalPrefixes` neutrality contract).

## [0.1.5] — 2026-06-29

### Fixed
- **Analyse scanned 0 files (cross-scope exclusion leak).** When more than one scope was configured, the coverage walk applied **every** scope's `excludedPaths` to **every** file, not just the active scope's. A `mobile` scope excluding `bo` therefore wiped out the entire `bo/src`-rooted `UI` scope analysis — the dashboard reported *"0 files scanned"*, every sub-score sat at 100/100, and all tokens showed as unused. The walk now honours only the **active** scope's excludes (which were already folded into the per-walk exclude set), matching IntelliJ's "active scopes only" semantics. This was the dominant cause of VS Code under-detecting vs IntelliJ on a multi-scope project.
- **Analyse detected fewer hardcoded values than the IntelliJ plugin on the same scope.** The VS Code `LiteralFinder` was stylesheet-shaped and missed two whole classes of literal that IntelliJ flags — closing the parity gap:
  - **Unitless numeric props** (`NUMBER` kind) — `fontSize: 14`, `borderRadius: 8`, `margin: 16`, `opacity: 0.5`, `z-index: 10`, … The previous build found **zero** literals in React-Native / JS object themes (where everything is a bare number), so the whole `mobile` scope under-reported. The regex requires the number to be the sole value of its slot, so CSS shorthand (`flex: 1 1 auto`) and unit-bearing values (`200px`, `1fr`) are left untouched.
  - **Named colors** — `white`, `black`, `transparent`, `red`, … are now flagged like any other colour literal.
  - **Comment exclusion** — literals inside `// …` and `/* … */` are no longer flagged (matches IntelliJ; also keeps the new NUMBER pass from picking up numbers in comments).
- **Property→category mapping now recognises React-Native camelCase.** `categoryForCssProperty` was matching exact hyphenated CSS names (`font-size`), so RN/JS props (`fontSize`, `borderRadius`, `paddingTop`) fell through uncategorised. Ported IntelliJ's `PropertyContext.categoryFor` predicates (`startsWith("font")`, `includes("radius")`, `startsWith("padding")`, …) which match both spellings — so a hardcoded `borderRadius: 8` now correctly classifies as RADIUS debt when a radius token exists, instead of being dropped or mis-bucketed.
- **Scope config import rejected IntelliJ v2 files** — importing a `token-flow-scopes.json` exported from the IntelliJ plugin failed with *"Config file version 2 is newer than this plugin (supported: 1). Update Token Flow."* The VS Code importer now supports schema **version 2**: the IntelliJ-only `analysisExcludedPaths` field is folded into VS Code's single `excludedPaths` list (deduped union with the scan-level `excludedPaths`), so nothing the user carved out gets silently re-included. Exports are now tagged version 2 and mirror `excludedPaths` back into `analysisExcludedPaths` for round-trip fidelity with IntelliJ.
- **Transparent sticky category headers in the Library.** The list's sticky category dividers let the scrolling content bleed through behind them — `.category__header` painted its background with `--vscode-sideBarSectionHeader-background`, which is *defined as transparent* in several built-in themes (Dark Modern, Dark+), so the `var()` fallback to an opaque colour never fired. The header now paints a guaranteed-opaque base (`sideBar-background`) with the theme's header tint layered on top, so it keeps its accent but never shows the list underneath (hover included).

### Changed
- **Analyse — section order.** The accordion now leads with **Broken references**, then **Hardcoded values** (a token already exists → mechanical fix), then **Hardcoded clusters** (opportunities), before the remaining sections. Surfaces hard bugs and immediate debt first.

## [0.1.4] — 2026-06-26

### Added
- **Copy Token Value** (VS Code port of the IntelliJ v0.2.3 gesture, [#27](https://github.com/robinlopez/token-flow/issues/27)) — a quick action on a token reference that copies its **resolved value**, its **name/reference**, or — for colours — the resolved colour in **HEX / RGB / HSL / OKLCH**.
  - **Resolves to the primitive.** A semantic alias (`--color-bg-page` → `--color-neutral-100` → `#e5e9eb`) copies `#e5e9eb`, following the same alias-resolution chain as hover / go-to-definition. Works on `var(--x)`, `--x`, `$x`, Style-Dictionary aliases (`'{a.b.c}'`) and runtime property paths (`colors.PRIMARY_500`).
  - **Three surfaces, one behaviour.** VS Code reserves Ctrl/Cmd+Click for Go-to-Definition and exposes no editor mouse hook, so the IntelliJ "modifier+click → dropdown" becomes: the **`Alt+V` command** (caret-driven QuickPick), an **editor context-menu entry**, and **clickable copy links in the hover popup** (the closest match to the original dropdown).
  - **Resolved value is the default** — listed first and preselected, so a single confirm copies it. The token name and colour alternates are one keystroke away.
  - **Colour alternates skip the source format.** A token already resolving to `#e5e9eb` offers RGB / HSL / OKLCH but not HEX again. OKLCH uses Björn Ottosson's sRGB → OKLab transform; all formatters emit `.` as the decimal separator regardless of locale.
  - **`📋 Copied "…"` status-bar feedback** on every copy.
  - **Rebindable + toggleable** — change the shortcut from VS Code's Keyboard Shortcuts (search `tokenFlow.copyTokenValue`); disable the whole feature via the new `tokenFlow.copyValue.enabled` setting (default `true`).
  - **Scope-aware + inert otherwise.** The `Alt+V` keybinding and context-menu entry are gated on a scan-backed `tokenFlow.onTokenReference` context key, so they only light up when the reference under the caret actually resolves to a token in the active scope — they never shadow `Alt+V` on an arbitrary `a.b.c` property access.

### Added (internal)
- **`ui/colorConversions.ts`** — TypeScript port of `ColorConversions.kt` (`toHex` / `toRgb` / `toHsl` / `toOklch` + `detectFormat`), operating on the canonical `RGBA` from `colorParser.ts`.
- **`scanner/tokenReferenceAt.ts`** — single source of truth for the five reference shapes recognised under the caret, shared by the new Copy Token Value surfaces.
- **`scanner/resolveTokenReference.ts`** — shared reference → `DesignToken` resolver (exact / `resolveReference` / reverse mode-strip / suffix), so any reference a hover finds is also copyable.

## [0.1.3] — 2026-05-27

### Added
- **Auto-scope detect** — one-click bootstrap of the Scopes configuration. The Settings panel can now scan the workspace and create a Token Flow scope per UI project it finds, pre-filled with sources and excludes.
  - **Discovery via `package.json`** — every package.json in the workspace (skipping `node_modules`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `coverage`) is classified as a UI project when it depends on a known frontend framework (React, React Native, Vue, Nuxt, Angular, Svelte, Next, Astro, Solid, Preact, Lit, Stencil, Ember, Ionic, Vite, Tailwind, Sass, styled-components, Emotion, MUI, Chakra, Mantine, Radix, Ant Design, PrimeVue/React/NG, Bootstrap) — or, as a fallback, when it ships any CSS/SCSS/Sass/Less asset. A package whose `name` is namespaced (`@acme/web`) becomes a scope named `web`.
  - **Implicit-container pruning** — when one detected project sits under another (e.g. `apps/desktop/` and `apps/mobile/` under the repo root), the outer project is treated as a monorepo container and the **siblings each get their own scope**. Containers themselves never become scopes. Works without a `workspaces` field — the topology of the candidate tree is the signal.
  - **Strict token-file qualification** — sources are populated by qualifying every `.css`/`.scss`/`.sass`/`.less` file as a "token sheet" only when it (a) has at least 5 `--var:` or `$var:` declarations, (b) carries no selectors except `:root { … }` / `:root.foo { … }`, and (c) contains no `@mixin` / `@function` / `@keyframes` / `@media` / `@font-face`. `@use` / `@forward` are tolerated. `.ts`/`.tsx`/`.js`/`.jsx` qualify when they export only value bags with token-vocabulary keys (no JSX, no React/Vue/Angular imports, no hooks, no function bodies).
  - **Filename + ancestor gate** — only files whose basename matches the token vocabulary (`tokens`, `theme`, `palette`, `variables`, `colors`, `spacing`, `typography`, `metrics`, `transitions`, `durations`, `easings`, `semantics`, `responsive`, `breakpoints`, `shadows`, `radii`, `foundations`, `primitives`, `design-tokens`, …) reach the content heuristic. Files sitting inside a `tokens/`, `theme/`, `palette/`, `foundations/`, `primitives/`, `design-tokens/`, `design-system/`, `ds/`, `variables/`, `generated/`, `styles/`, `scss/`, `css/`, `sass/`, `less/` folder also pass, so Style-Dictionary / Theo output dropped under `src/styles/.../generated/` is picked up.
  - **Folder collapse** — when ≥ 2 qualifying token files sit in the same directory, the directory itself becomes the source entry instead of every individual file (keeps `settings.json` readable).
  - **Unconditional noise excludes** — every produced scope ships with `node_modules`, `dist`, `build`, `out`, `coverage` in its excludes list. `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.angular`, `.parcel-cache`, `.storybook-static`, `storybook-static`, `.vscode`, `.idea`, `.git`, `tmp`, `temp` are added when they exist at the workspace root.
  - **Non-destructive merge** — re-running auto-detect on an already-populated configuration merges by scope name (case-insensitive): existing scopes get new sources / excludes appended, never overwritten. An explicit `rootPath` is never replaced.
  - **Confirmation modal** before any settings write, with a one-line explanation that detection is heuristic and the result is worth a quick review.
  - **Empty-state CTA** — when no scope exists yet, the Settings panel surfaces an "Auto-scope detect" primary button alongside an "Add scope manually" secondary, replacing the previous lone "Create your first scope" button.
  - **Inline header action** — when scopes already exist, "Auto-scope detect" is exposed next to the Scopes section heading so users can re-run detection without scrolling.
  - **Toast feedback** — top-right toast on the Settings panel reports `N detected, X added, Y merged` after each run (or a "no token files detected" notice when the scan came up empty). Auto-dismisses after 5 s; click to dismiss earlier.

### Changed
- **`SettingsHostMessage` is now a discriminated union** — previously a single `{ type: "config"; … }` shape; the auto-detect flow needs to push `autoDetectResult` / `autoDetectFailed` notifications back to the webview, so the protocol moved to a proper union. The client `message` listener now uses an exhaustive `switch (msg.type)`.
- **Settings panel — Scopes section header** uses a row layout (`section-header--with-action`) when an action button is attached, so the auto-detect button aligns cleanly with the title without disturbing the existing two-line "title + hint" layout when no action is present.

## [0.1.2] — 2026-05-24

### Added
- **Multi-criteria Semantic Scoring** — The suggestion engine now ranks candidates based on structural Tiers (Semantic > Component > Primitive) and semantic Roles (Surface, Content, Stroke, Effect) inferred from the surrounding CSS property context, rather than falling back to naive name-length sorting.
- **Analyser — hardcoded results split into clusters + values** (parity with IntelliJ [#19](https://github.com/robinlopez/token-flow/issues/19)) — the legacy "Hardcoded clusters" section is now two sections:
  - *Hardcoded clusters* keeps the original semantic: repeated literals with **no** matching token in the active scope (design opportunities).
  - *Hardcoded values* is new: literals where one or more tokens already exist for the same `(value, category)` pair (actionable technical debt). Values are grouped by `(literal + property family)` so the same value used under two distinct properties (`12px padding` vs `12px font-size`) shows up as two separate rows with their own role-aware suggestion from the unified `findSuggestions` engine.
  - The previous single `HARDCODED_PRESSURE` score axis is replaced by `HARDCODED_OPPORTUNITY` (weight 15, x1 per hit) and `HARDCODED_DEBT` (weight 10, x2 per hit — the fix is immediate).
  - New `categoryForCssProperty` helper resolves the property → category mapping (padding/margin/gap → SPACING, font-size/line-height → TYPOGRAPHY, border-radius → RADIUS, width/height → SIZING, etc.) so the bucketing matches the IntelliJ taxonomy.
- **Suggestion engine parity with IntelliJ** — `SuggestionEngine.kt` (Kotlin) is now the authoritative spec per `SHARED_LOGIC.md` and the VSCode side is a faithful port:
  - **Unified `findSuggestions()` entry point** — single function called by `HardcodedDiagnostics`, the Hardcoded panel aggregator, and the Analyser workspace aggregator. Replaces the previous three-call combo (`lookupAcross` + `sortCandidates` + manual helper concat) that had drifted between callers.
  - **Cross-family demotion (+200)** — a TYPOGRAPHY-categorised token can no longer outrank a SPACING token on a `padding: 12px` declaration when no exact SPACING match exists. Wrong-family hits surface only as last-resort fuzzy hints.
  - **Typography-name guard** — a token literally named `--size-typography-title-md` no longer surfaces on `width: 20px` even if its declared category is SIZING. Word-boundary regex (`typography|font|text|weight|leading|…`) catches the canonical pitfall.
  - **Color-distance fallback** — when no exact COLOR match exists, tokens within RGBA Δ ≤ 0.05 are now surfaced, sorted by colour proximity primary and semantic score secondary. Previously diagnostics simply showed no suggestion at all.
  - **Role markers aligned to IntelliJ** — added `canvas` (SURFACE), `label` (CONTENT), `divider` (STROKE), `focus` / `glow` (EFFECT). Removed `ring`, `blur`, `filter`, `overlay` markers that had no Kotlin counterpart.
  - **Tier prefix list aligned** — added `unit` (singular), `primitives` (plural), `component`, `components` to match Kotlin segment list.
  - **JS-object-path tokens classified correctly** — tier extraction now splits on both `-` and `.`, so a `primitive.units.xl` JS token is recognised as PRIMITIVE rather than silently falling through to SEMANTIC.
  - **Bug fix — SCSS sigil stripping** — the previous `/^(--|\$)/` regex had an escaping bug (`\$` interpreted as a literal backslash) so `$units-xl` was never normalised. Tier and role extraction silently mis-scored every SCSS token.

### Performance & Stability
- **In-flight scan dedup** — concurrent callers (multiple visible editors firing diagnostics in parallel after an invalidation) now await a SINGLE shared scan instead of triggering N redundant workspace passes. Eliminates a known cause of compounded freezes on multi-editor sessions.
- **Generation guard against stale cache writes** — a scan that raced an `invalidate()` will no longer commit its outdated result over the fresh cache.
- **File watcher debounce (300ms)** — save-all bursts (formatters, multi-file refactors, branch switches) now coalesce into a single index invalidation instead of N consecutive rescans.
- **Scope-aware JS/TS watcher** — the `**/*.{ts,tsx,js,jsx,mjs,cjs,json}` watcher used to fire on every component save anywhere in the workspace. It now watches ONLY paths declared by configured scopes (`sourcePaths` / `rootPath` / `whitelistPaths`). Stylesheets keep their broad watch since they are typically thin and bounded.
- **No-scope mode is stylesheets-only** — when no scope is configured, the scanner no longer crawls every `.tsx` file in the workspace. JS/TS/JSON token catalogues now require explicit scope configuration. This was the dominant cause of the "98% CPU UNRESPONSIVE extension host" freezes on React projects.
- **Default heavy-directory excludes everywhere** — `node_modules`, `dist`, `out`, `build`, `coverage`, `.next`, `.nuxt`, `.git`, `.cache`, `.turbo`, `.parcel-cache`, `target` are now excluded from every `findFiles` call, not just the legacy no-scope fallback.
- **Per-file mtime cache** — `runScan()` now keeps a `fsPath → {mtime, text, rawTokens}` map that survives `invalidate()`. Unchanged files pay only a `stat()` on subsequent scans instead of a full `readFile` + regex pass; orphaned entries are pruned at the end of each scan.
- **Parallel file reads + cooperative yield** — files are read in batches of 16 in parallel; the scanner yields to the event loop every 50 files so keystrokes and commands stay responsive during a workspace-wide scan. Mid-scan invalidations bail out early.


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
