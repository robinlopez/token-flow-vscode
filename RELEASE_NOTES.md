# Token Flow — Release Notes

## v0.1.6 — 2026-07-28 · Broken references you can trust

**Analyse's broken-reference list only reports real bugs now.** Two sources of false positives are gone — one fixed in code, one made configurable.

### No more phantom broken references from message placeholders

The Style-Dictionary alias syntax (`'{color.primary}'`) looks exactly like the most common placeholder convention in application code. An Angular paginator was enough to poison the report:

```ts
currentPageReportTemplate = input<string>('{first} - {last} sur {totalRecords}');

return this.currentPageReportTemplate()
  .replace('{first}', String(state.first))
  .replace('{totalRecords}', String(state.totalRecords));
```

That produced **6 broken references that weren't** — plus 6 phantom tokenised refs quietly inflating your coverage ratio. Same story with i18n (`translate.instant('{count}')`) and regex helpers (`raw.split('{sep}')`).

Two independent filters now catch these:

- **Where is the string?** A `'{…}'` handed to `replace` / `split` / `test` / `t` / `instant` / `format` / … is a runtime placeholder. An alias sitting in an object literal (`primary: '{color.primary}'`) is untouched.
- **Is the name part of your vocabulary?** If your project declares no token the path could belong to, it isn't a reference. A typo *inside* a namespace you do own (`'{color.primry}'`, `'{colr.primary}'`) is still reported as broken — that's exactly what you want to see.

Both run before the coverage counter, so the ratio is honest again. `var(--x)`, `$x` and `dt('a.b')` are unambiguous and untouched.

### Tell Token Flow which variables aren't yours

New setting **`tokenFlow.externalPrefixes`** (and a per-scope list, matching the IntelliJ edition). Declare the prefixes your project receives from a framework — `--p-` PrimeNG, `--ion-` Ionic, `--mat-` / `--mdc-` Material, `--bs-` Bootstrap — or exposes on purpose as a component's customisation API:

```scss
// ui-slider.scss — consumers override these via ::ng-deep
height: var(--ui-slider-handle-size, #{$handle-size});
```

Nothing declares `--ui-slider-handle-size`, and nothing should. Adding `--ui-slider-` to the scope's external prefixes makes that reference **neutral**: it counts as tokenised, it's never flagged broken, and it never marks one of your tokens as used.

Both tiers are editable in the **Settings** panel — a project-wide list under *Preferences* (one-click chips for the common frameworks) and a per-scope list in the scope detail.

One trade-off worth knowing: prefer the narrowest prefix. `--ui-` silences every `--ui-*` reference, including a real typo on an existing `--ui-…` token; `--ui-slider-` only covers that component.

### Install

```
code --install-extension token-flow-vscode-0.1.6.vsix
```

---

## v0.1.5 — 2026-06-29 · Analyse reliability & IntelliJ parity

A focused reliability pass on the **Analyse** dashboard so it detects what the IntelliJ edition detects on the same scope, plus scope-config interop and a Library polish fix.

### Analyse now scans your files again

On a multi-scope project the dashboard could report **"0 files scanned"** — every sub-score pinned at 100/100 and every token flagged unused. The coverage walk was applying **every** scope's excludes to **every** file: a `mobile` scope excluding `bo` silently wiped out the analysis of a `bo/src`-rooted `UI` scope. The walk now honours **only the active scope's** excludes, matching IntelliJ's semantics. This was the dominant cause of VS Code under-reporting versus IntelliJ.

### Hardcoded detection on par with IntelliJ

The literal finder was stylesheet-shaped and missed whole classes of value that IntelliJ flags:

- **Unitless numeric props** — `fontSize: 14`, `borderRadius: 8`, `margin: 16`, `opacity: 0.5`, `z-index: 10`. React-Native / JS object themes (where everything is a bare number) previously surfaced **zero** hardcoded values. The number must be the sole value of its slot, so CSS shorthand (`flex: 1 1 auto`) and unit-bearing values (`200px`, `1fr`) are left untouched.
- **Named colors** — `white`, `black`, `transparent`, `red`, … now flagged like any other colour literal.
- **Comment exclusion** — literals inside `// …` and `/* … */` are no longer flagged.
- **camelCase property mapping** — `fontSize`, `borderRadius`, `paddingTop` now classify like their hyphenated CSS twins (`font-size`, `border-radius`, `padding-top`), so a hardcoded `borderRadius: 8` is recognised as RADIUS debt when a radius token exists.

### Import IntelliJ v2 scope configs

Importing a `token-flow-scopes.json` exported from the IntelliJ plugin failed with *"Config file version 2 is newer than this plugin."* The importer now supports schema **version 2**: the IntelliJ-only `analysisExcludedPaths` field folds into VS Code's `excludedPaths`, and exports round-trip back to IntelliJ.

### Library & dashboard polish

- **Sticky category headers** in the Library no longer let the scrolling list bleed through behind them — they paint an opaque, theme-tinted background in every theme (Dark Modern / Dark+ included).
- **Analyse section order** now leads with **Broken references → Hardcoded values → Hardcoded clusters**, surfacing hard bugs and immediate debt first.

### Install

```
code --install-extension token-flow-vscode-0.1.5.vsix
```

---

## v0.1.4 — 2026-06-26 · Copy Token Value

### Copy a token's resolved value — without leaving the keyboard

Token Flow now ports the IntelliJ v0.2.3 gesture ([#27](https://github.com/robinlopez/token-flow/issues/27)) to VS Code: a quick action on any token reference that copies its **resolved value**, its **name**, or — for colours — the resolved colour in **HEX / RGB / HSL / OKLCH**.

Place the caret on a `var(--color-bg-page)`, `$spacing-md`, `'{primitive.neutral.100}'` or `colors.PRIMARY_500` and the dropdown opens with the resolved value preselected. Confirm to copy; arrow down for the alternates.

#### Resolves to the primitive

A semantic alias resolves all the way to the value at the end of its chain:

```
--color-bg-page  →  --color-neutral-100  →  #e5e9eb
```

Copy Token Value puts `#e5e9eb` on the clipboard — not the intermediate alias. It follows the exact same resolution chain as the hover popup and Go-to-Definition, so anything a hover can show, you can copy.

#### Three ways to reach it

VS Code reserves `Ctrl/Cmd+Click` for Go-to-Definition and gives extensions no hook into editor mouse events, so the IntelliJ "modifier+click → dropdown" becomes three native surfaces, all sharing one behaviour:

- **`Alt+V`** — a caret-driven QuickPick. Rebind it from **Keyboard Shortcuts** (search `tokenFlow.copyTokenValue`), the VS Code-native equivalent of the IntelliJ settings combo.
- **Editor right-click menu** — a "Copy Token Value…" entry, no keybinding to remember.
- **Hover popup** — the resolved value, token name and colour formats render as clickable `📋` copy links right under the variant table.

All three light up only when the reference under the caret actually resolves to a token in the active scope (a scan-backed `tokenFlow.onTokenReference` context key), so `Alt+V` and the menu entry stay inert on an arbitrary `a.b.c` property access elsewhere in your code.

#### Colour-aware

When the resolved value is a colour, the dropdown adds the three formats it *isn't* already in. A token resolving to `#e5e9eb` offers:

```
rgb(229, 233, 235)
hsl(200deg 13% 91%)
oklch(0.932 0.005 228.8deg)
```

OKLCH uses Björn Ottosson's sRGB → OKLab → OKLCH transform. Every format emits `.` as the decimal separator regardless of your system locale.

#### Settings

- **`tokenFlow.copyValue.enabled`** (default `true`) — toggles the command, the context-menu entry and the hover links in one switch.
- The shortcut is fully rebindable from VS Code's Keyboard Shortcuts UI.

Every copy confirms with a transient `📋 Copied "…"` status-bar message.

---

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
