# Token Flow — Release Notes

## v0.1.3 — 2026-05-27 · Auto-scope detect

### One-click bootstrap of the Scopes configuration

Setting up Token Flow on a real codebase used to mean opening the Settings panel, creating a scope, browsing to your `_tokens.scss`, repeating per app, and remembering to skip `node_modules`/`dist`. **Auto-scope detect** does the whole walk for you in a single click.

#### How it works

- Token Flow walks every `package.json` in the workspace (skipping `node_modules`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `coverage`) and classifies each as a UI project when it depends on a known frontend framework — React, React Native, Vue, Nuxt, Angular, Svelte, Next, Astro, Solid, Preact, Lit, Stencil, Ember, Ionic, Vite, Tailwind, Sass, styled-components, Emotion, MUI, Chakra, Mantine, Radix, Ant Design, PrimeVue/React/NG, Bootstrap. Packages that don't depend on a framework but ship CSS/SCSS assets are picked up as a fallback (design-token libraries).
- One **scope** is created per UI project, named after the `package.json#name` (stripped of any `@scope/` prefix), with `rootPath` pointing at the project directory.
- **Multi-app monorepos work without configuration** — if `apps/desktop/` and `apps/mobile/` are both UI projects under a parent `package.json`, the parent is treated as an implicit container and each sibling gets its own scope. No `workspaces` field required.
- **Sources** are populated by scanning each project for files that *only* contain token declarations: a strict content heuristic checks for at least 5 `--var:` or `$var:` declarations and no real selectors / mixins / keyframes / media queries (`:root { … }`, `@use`, `@forward` are tolerated). Filename gate accepts the usual token vocabulary plus arbitrary suffixes (`_tokens-metrics.scss`, `_tokens-transitions.scss`, …). Folder gate accepts files dropped inside `tokens/`, `theme/`, `foundations/`, `primitives/`, `design-tokens/`, `design-system/`, `ds/`, `variables/`, `generated/`, `styles/`, `scss/`, `css/`, `sass/`, `less/` — so Style-Dictionary / Theo output emitted under `src/styles/.../generated/` is picked up.
- **Excludes** ship with `node_modules`, `dist`, `build`, `out`, `coverage` unconditionally, plus `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.angular`, `.parcel-cache`, `.storybook-static`, `.vscode`, `.idea`, `.git`, `tmp`, `temp` when those folders actually exist.
- **Re-runs are safe.** Auto-detect merges by scope name (case-insensitive): existing sources / excludes are appended to, never overwritten. An explicit `rootPath` is never replaced.

#### Where to find it

- **Empty Settings panel** — a primary "Auto-scope detect" button sits alongside an "Add scope manually" button, replacing the previous lone "Create your first scope" CTA.
- **Already-populated Settings panel** — "Auto-scope detect" is exposed next to the Scopes section heading.

Each run prompts a quick confirmation before mutating workspace settings and reports back via a top-right toast ("N detected — X added, Y merged"). A review of the result usually adds or removes a couple of paths and noticeably sharpens later scans — but the defaults are tuned to be useful out of the box.

---

## v0.1.2 — 2026-05-24 · Semantic Scoring Engine + Stability Pass + IntelliJ Parity + Analyser Split

### Analyser — Hardcoded clusters & values, split

The single "Hardcoded clusters" section is now two complementary views, mirroring IntelliJ [#19](https://github.com/robinlopez/token-flow/issues/19):

- **Hardcoded clusters** — repeated literals with NO matching token in the active scope. These are **design opportunities** — values worth promoting into the design system.
- **Hardcoded values** *(new)* — literals whose token already exists for the same `(value, category)` pair. These are **actionable debt** — the fix is mechanical, the user just needs to apply the existing token.

Values are bucketed by `(literal + property family)`. The same `12px` used as `padding` and as `font-size` shows up as two distinct rows, each carrying the most relevant suggestion (`--spacing-sm` vs `--text-sm-line-height`) from the unified suggestion engine.

The legacy `HARDCODED_PRESSURE` score axis is replaced by:
- `HARDCODED_OPPORTUNITY` (weight 15, x1 per hit)
- `HARDCODED_DEBT` (weight 10, x2 per hit — the fix is immediate, the penalty is sharper)

---



- **Multi-criteria Semantic Scoring**: The suggestion engine now natively understands your CSS property context (e.g. `background-color`, `padding`). It ranks design token candidates based on structural **Tiers** (Semantic vs Component vs Primitive) and semantic **Roles** (Surface, Content, Stroke, Effect).
- **Intelligent Contextual Suggestions**: For a hardcoded `32px` value in a `padding` rule, the engine will prioritize `--spacing-xl` over `--units-xl`. For `#005bff` in a `background`, a token like `--color-surface-high` will easily outrank a `--color-text-brand` token, delivering exactly the right token for the context.

### Suggestion Engine — full parity with IntelliJ

The VSCode suggestion engine is now a faithful port of `SuggestionEngine.kt`. Every behaviour the IntelliJ users rely on is now available on VSCode:

- **Cross-family demotion**: a TYPOGRAPHY token will never outrank a SPACING token on `padding`, even when the spacing scale doesn't contain that value.
- **Typography-name guard**: tokens literally named `--size-typography-…` won't surface on `width: …` declarations even if their declared category is SIZING.
- **Colour-distance fallback**: when no exact colour match exists, near-match tokens (RGBA Δ ≤ 0.05) are now suggested — sorted by colour proximity first, semantic score second. Previously the diagnostic stayed silent.
- **Helper-aware suggestions (`spacing(1.5)`, `radius(2)`)**: synthetic helper-call candidates are composed and ranked alongside direct matches everywhere — diagnostics, hardcoded panel, and Analyser dashboard.
- **SCSS variable scoring fix**: a regex bug meant `$`-prefixed SCSS variables were never normalised, so their tier and role extraction silently mis-scored. SCSS tokens now rank consistently with their CSS-custom-property siblings.
- **JS-object-path tokens**: `primitive.units.xl`-style tokens are now correctly classified as PRIMITIVE instead of falling through to SEMANTIC.

### Performance & Stability — End of "98% CPU freezes"

The v0.1.2 line had documented `UNRESPONSIVE extension host` events where the indexer would consume 98% of the host's CPU budget on large React/TS workspaces. This release ships a focused stability pass that addresses the root causes:

- **No-scope mode is now stylesheets-only.** When no scope is configured, the scanner no longer walks every `.tsx` file in the workspace — JS/TS/JSON token catalogues require explicit configuration via `sourcePaths` / `rootPath` / `whitelistPaths`. This was the dominant freeze trigger on projects without scope setup.
- **Scope-aware file watchers.** The JS/TS watcher fires only inside declared scope paths; saving an unrelated component no longer invalidates the token index.
- **300ms debounce on invalidation.** Save-all bursts, formatters, and multi-file refactors coalesce into one rescan instead of N.
- **In-flight `scan()` dedup.** Multiple visible editors triggering diagnostics in parallel now share a single workspace scan instead of running N redundant passes.
- **Per-file mtime cache.** Unchanged files pay only a `stat()` on repeat scans — `readFile` + regex parsing is skipped entirely. Massive speedup on warm caches.
- **Parallel reads + cooperative yields.** Files read in batches of 16; the scanner yields to the event loop every 50 files so VSCode stays responsive during a large scan.
- **Default excludes everywhere.** `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.git`, `.cache`, `.turbo`, `.parcel-cache`, `target` are excluded from every `findFiles` call.
- **Settings panel no longer freezes** on scope add/remove/rename actions, since the resulting re-scan is now bounded and incremental.

---
## v0.1.1 — 2026-05-23 · Contextual Variables Integration

- **DynamicCssVarIndex**: Token Flow now globally indexes contextual CSS variables across your entire workspace, including `CSS`, `SCSS`, `Vue`, `React`, and `Angular` styles.
- **Show Contextual Variable References (`Ctrl+T` / `Alt+T`)**: Triggering "Show Alternatives" on a known contextual variable opens a QuickPick listing all its declarations and usages across the project (sorted by static vs runtime).
- **Broken Reference Tolerance**: Contextual CSS variables that exist in the project are no longer flagged as broken references by the analyser.
- **Library Visual Mode**: A stunning new visual presentation for your design system tokens. Toggle between the traditional List view and the new Visual mode to see rich color palettes on checkerboard backgrounds, visual scale bars for metrics (spacing, radius), and numerical sorting.
- **Enhanced Variant Selection**: Easily switch between themes (light/dark) or viewports directly within each category accordion. The selected variant instantly updates the preview values in both List and Visual modes.
- **Robust Condition Parsing**: Flawless extraction of variants (`min-width`, breakpoints, theme classes) directly from complex SCSS maps and CSS media queries.

---

## v0.1.0 — 2026-05-23 · First public release

Bridging the gap between Design and Code, inside VSCode.

This is the inaugural public release of **Token Flow for VSCode**, the
companion plugin to the [IntelliJ edition](https://github.com/robinlopez/token-flow).
It ships a complete stylesheet-oriented token workflow: find, insert,
swap, and audit design tokens without leaving the editor.

---

### Highlights

- **Library webview** — sidebar panel listing every indexed token,
  grouped by category, with inline color swatches, two-line
  name + value previews, variant badges, per-row copy / goto buttons,
  drag-and-drop into the editor, multi-term search and category + kind
  filter chips.

- **Hardcoded values panel** — follows the active editor and lists
  every literal that matches an indexed token. Inline swatches,
  alternative-candidate cycling, jump-to-source and one-click
  replacement (workspace edit, undoable).

- **Hardcoded-value diagnostics + quick-fix** — `Hint`-level
  underlines on `#fff`, `14px`, `200ms`, … with a lightbulb that
  replaces the literal by the canonical `var(--token)` / `$token`.
  Works through transparent wrappers like `rem-calc(14px)` and ignores
  `var(--name, fallback)` fallback values.

- **Show Token Alternatives (`Alt+T`)** — custom webview picker (not
  the native QuickPick) with real CSS swatches, category grouping,
  pivot pre-selection, keyboard + mouse navigation. Swaps a token
  reference or "tokenizes" a hardcoded literal in one keystroke.

- **Go to Token Declaration** — `Ctrl+Click` / `F12` / Peek on
  `var(--x)`, `--x` or `$x` opens the declaration via VSCode's native
  Definition flow.

- **Hover popup** with resolved value and a per-condition table of
  variants, including multi-theme grouping (`themeOne → light / dark`).

- **Code completion** triggered after `var(--` or `$`.

- **Analyse dashboard** — full-tab webview with global A→F score on a
  circular gauge, five sub-axis cards (semantic coherence, usage
  coverage, duplication, hardcoded pressure, reference integrity),
  and accordion drilldowns for hardcoded clusters, broken refs,
  unused / duplicate / incoherent tokens, and per-file coverage.

- **Named scopes** — multi-scope projects supported through
  `tokenFlow.scopes`. Each scope declares `name`, `rootPath`,
  `sourcePaths`, `whitelistPaths`, `excludedPaths`. The active editor
  picks the deepest matching scope automatically; status-bar item
  shows the current scope.

- **Settings webview** — master-detail editor for scopes with native
  folder/file pickers and workspace-target persistence. Open via the
  status-bar item, the `$(settings-gear)` button on the Library, or
  `Token Flow: Configure Scopes…`.

---

### Supported formats

- SCSS variables (`$color-primary-500`)
- CSS Custom Properties (`--color-primary-500`)
- SCSS Maps (`("color-primary-500": #5d3fd3)`)
- TS/JS preset objects (Style-Dictionary, PrimeUIX) — `'{path.to.token}'`

---

### Known limitations

- **React-Native runtime themes** (`colors.PRIMARY_500`) and callable
  helpers (`spacing(scale)`) are not in this release — next milestone.
- **Analyse dashboard is workspace-wide.** Scope selector to come.
- A handful of polish items (hover-delay slider, autocomplete toggle)
  are on the roadmap.

See [`PLAN.md`](PLAN.md) for the full roadmap and
[`CHANGELOG.md`](CHANGELOG.md) for the detailed change log.

---

### Install

Download the `.vsix` from this release and install it via:

```
code --install-extension token-flow-0.1.0.vsix
```

Or from VSCode: `Extensions › … › Install from VSIX…`

---

### Thanks

Built alongside the IntelliJ edition to keep parity between the two —
see [`SHARED_LOGIC.md`](SHARED_LOGIC.md) for the invariants both
implementations must respect.
