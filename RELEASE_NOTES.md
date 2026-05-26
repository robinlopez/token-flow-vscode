# Token Flow — Release Notes

## v0.1.2 — 2026-05-24 · Semantic Scoring Engine + Stability Pass

- **Multi-criteria Semantic Scoring**: The suggestion engine now natively understands your CSS property context (e.g. `background-color`, `padding`). It ranks design token candidates based on structural **Tiers** (Semantic vs Component vs Primitive) and semantic **Roles** (Surface, Content, Stroke, Effect).
- **Intelligent Contextual Suggestions**: For a hardcoded `32px` value in a `padding` rule, the engine will prioritize `--spacing-xl` over `--units-xl`. For `#005bff` in a `background`, a token like `--color-surface-high` will easily outrank a `--color-text-brand` token, delivering exactly the right token for the context.

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
