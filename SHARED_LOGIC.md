# Shared Logic — Token Flow

This document is the **canonical reference** for the parsing, resolution and
categorization logic that **must behave identically** in both the IntelliJ
plugin ([token-flow](https://github.com/robinlopez/token-flow)) and this
VSCode edition.

When the two implementations disagree, this file is the source of truth.

> If a section is updated here, both repos must be patched in the same PR.
> Add a checkbox to the PR description: `- [ ] IntelliJ side updated · - [ ] VSCode side updated`.

---

## 1. Regex set

These regexes extract raw token declarations from source files. Any edit
**must** be mirrored on both sides.

| Constant | Pattern (regex) | Files scanned |
|---|---|---|
| `SCSS_VAR_REGEX` | `(?m)^\s*\$([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;\n]+)\s*;?` | `.scss`, `.sass` |
| `CSS_VAR_REGEX` | `--([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;}\n]+)\s*;?` | All stylesheet files |
| `SCSS_MAP_KEY_REGEX` | `"([a-z][a-z0-9_-]*)"\s*:\s*([^,\n}]+),` | `.scss`, `.sass` |
| `SCSS_ALIAS_REGEX` | `^\$([A-Za-z_][A-Za-z0-9_-]*)$` | (alias resolution) |
| `CSS_VAR_CALL_REGEX` | `^var\(\s*--([A-Za-z_][A-Za-z0-9_-]*)\s*\)$` | (alias resolution) |
| `JS_OBJECT_ALIAS_REGEX` | `^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$` | (alias resolution) |
| `JS_RUNTIME_ALIAS_REGEX` | `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$0-9][\w$]*)+$` | (alias resolution, runtime) |

**Invariants**:
- `SCSS_MAP_KEY_REGEX` requires the trailing comma to skip map *headers*
  like `"themeOne": (` (the `(` would not be followed by a `,` directly).
- The `--` and `$` regexes accept identifier characters `[A-Za-z_-]` plus
  digits in the body. The first character must NOT be a digit.

## 2. File extension targeting

| Extension | SCSS regex | CSS regex | JS parsers |
|---|---|---|---|
| `.scss`, `.sass` | ✅ | ✅ | ❌ |
| `.css`, `.less` | ❌ | ✅ | ❌ |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json` | ❌ | ❌ | ✅ |

**Rationale (since IntelliJ v0.1.2)**: SCSS regex on `.css` produces false
positives because `--` follows different lexical rules in pure CSS. JS
detectors on stylesheets are wasted work.

VSCode side: parsers live under [src/scanner/parsers/](src/scanner/parsers/)
and self-register into a dispatcher (`jsTokenFileParserRegistry.ts`). The
dispatcher picks **one** parser per file via `detectMode(text)`:
`'{a.b.c}'` alias literals or no hint at all → `STYLE_DICTIONARY`; RN
import / `StyleSheet.create` / typed export → `RUNTIME`. Helpers
(callable arrow functions) are an orthogonal pass run only in
`RUNTIME` mode.

## 3. Declaration context (`describeAt`)

Walks the source text **backwards** from a token offset and returns a
space-joined chain of enclosing blocks:

- CSS rule blocks delimited by `{}` — selector text immediately before `{`,
  stopping at the previous `}`, `;`, or `{` (selector chains).
- SCSS map literals delimited by `()` — only when `(` is preceded by a
  `"key":` or `key:` pair. Plain function calls (`rgb(…)`, `map-get(…)`)
  are skipped.

**Output examples**:

| Source | `describeAt` output |
|---|---|
| Top-level `$x: 1;` | `""` |
| `:root { --x: 1 }` | `:root` |
| `:root @media (min-width: 1024px) { --x: 1 }` | `:root @media (min-width: 1024px)` |
| `$themes: ("light": (--x: red))` | `light` |
| `$themes: ("themeOne": ("light": (--x: red)))` | `themeOne light` |

**Invariants**:
- A SCSS map key with quotes (`"…"` or `'…'`) strips the quotes.
- A bare identifier key (`themeName: (`) is preserved verbatim.
- Selector text is trimmed and collapsed (`\s+` → ` `), capped at 120 chars.

## 4. Alias resolution

Recursive expansion with a cycle guard (`seen: Set<string>`). Order of attempts
on a given value:

1. **SCSS alias** — `^\$([A-Za-z_][A-Za-z0-9_-]*)$` → look up `$name`.
2. **CSS var call** — `^var\(\s*--([A-Za-z_][A-Za-z0-9_-]*)\s*\)$` → look up `--name`.
3. **Runtime property-access alias** (JS) — `JS_RUNTIME_ALIAS_REGEX` → look up the verbatim expression.
4. **Object-path alias** (JS) — `^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$`, then:
   1. Look up the path verbatim.
   2. Try the mode-stripped canonical form (`TokenNameParser.stripModeSegment`).
   3. Lead-segment strip: try `parts.drop(1).join('.')`, `parts.drop(2)…` (handles
      paths emitted without the leading `export const NAME` segment).
   4. Suffix match: first indexed token whose name ends with `.{ref}`.

Each step adds its lookup key to `seen` before recursing.

## 5. Primary condition label

Sets the column header for the primary occurrence in the variant table.
The IntelliJ side (since v0.1.1) and VSCode are aligned on:

| Kind | Source of label |
|---|---|
| `CSS_CUSTOM_PROPERTY` | `describeAt(text, primary.offset)`, blank → `null` |
| `SCSS_VARIABLE` | `describeAt(text, primary.offset)`, blank → `null` |
| `JS_OBJECT_PATH` | `TokenNameParser.modeSegmentOf(name)` (e.g. `light` / `dark`) |
| `JS_RUNTIME_PROPERTY` | `null` (flat property access, no nesting) |
| `JS_RUNTIME_FUNCTION` | `null` (helper, not a variant in the usual sense) |

## 6. `parseCondition` (variant table header)

Converts a raw context chain into a `{ theme, sub }` pair driving the
two-row header rendering in the hover popup.

```
""                                  →  { theme: null,    sub: "default" }
"(top level)"                       →  { theme: null,    sub: "default" }
"min-width: 1024px"                 →  { theme: null,    sub: "≥1024" }
"max-width: 767px"                  →  { theme: null,    sub: "<768" }
"themeOne light"                    →  { theme: "themeOne", sub: "light" }
"themeOne"                          →  { theme: "themeOne", sub: "default" }
"light"                             →  { theme: null,    sub: "light" }
":root .dark-mode"                  →  { theme: null,    sub: "dark-mode" }
":root"                             →  { theme: null,    sub: "default" }
```

**Rules**, in order:
1. Blank or `(top level)` → `default`.
2. `min-width:Npx` → `≥N` ; `max-width:Npx` → `<(N+1)`.
3. Pure word chain (matches `[\w- ]+`): split on space, pick first
   `light/dark/auto` as `sub`, first non-mode non-`default` word as `theme`.
4. Selector chain: look for an isolated `dark*` / `light*` substring.
5. Otherwise strip `:root`, `@media `, leading `.`, `:`, `&`, parentheses,
   whitespace. If empty → `default`; else cap at 24 chars.

## 7. Categorization

Name hints win over value hints. Both sides must use **the same keyword
lists**, in the same evaluation order:

### Name hints (substring match on lowercased name, leading `--`/`$` stripped)

Order matters — each row short-circuits. **High-priority composites
first** so multi-word patterns win over their constituent root words
(e.g. `border-width` lands on `BORDER`, not on `COLOR` via the
"border" keyword in the generic row).

| Priority | Keywords | Category |
|---|---|---|
| 1 (composite) | `border-color` | `COLOR` |
| 1 | `border-width`, `border-style`, `stroke-width` | `BORDER` |
| 1 | `box-shadow`, `drop-shadow` | `SHADOW` |
| 1 | `line-height` | `TYPOGRAPHY` |
| 1 | `min-width`, `max-width` | `SIZING` |
| 2 (specific) | `z-index`, `zindex`, `layer`, `depth`, `elevation` | `Z_INDEX` |
| 2 | `opacity`, `alpha` | `OPACITY` |
| 2 | `icon`, `glyph` | `ICON` |
| 3 (general) | `color`, `colour`, `bg`, `background`, `fill`, `stroke`, `surface`, `gradient`, `tint`, `shade` | `COLOR` |
| 3 | `font`, `text`, `type`, `weight`, `leading`, `letter`, `family`, `tracking`, `kerning`, `decoration` | `TYPOGRAPHY` |
| 3 | `shadow` | `SHADOW` |
| 3 | `radius`, `rounded` | `RADIUS` |
| 3 | `duration`, `transition`, `delay`, `ease`, `motion`, `animation`, `timing`, `speed` | `DURATION` |
| 3 | `effect`, `focus`, `blur`, `outline` | `EFFECTS` |
| 3 | `grid`, `column`, `row`, `breakpoint`, `media`, `screen`, `layout`, `viewport`, `container` | `LAYOUT` |
| 3 | `size`, `width`, `height`, `sizing`, `dimension`, `scale`, `ratio` | `SIZING` |
| 3 | `space`, `spacing`, `gap`, `margin`, `padding`, `inset`, `top`, `bottom`, `left`, `right`, `position` | `SPACING` |

**Stroke disambiguation**: when `nameHint === "COLOR"` but the name
contains `stroke` / `border` AND the resolved value matches
`LENGTH_REGEX`, the category is overridden to `BORDER`. Mirrors
Figma's convention (stroke = colour by default, stroke width = a
length).

### Value hints (regex match on trimmed resolved value)

| Pattern | Category |
|---|---|
| `^(#[0-9a-fA-F]{3,8}\|(rgb\|rgba\|hsl\|hsla\|hwb\|lab\|lch\|oklab\|oklch\|color)\s*\(.*\))\s*$` | `COLOR` |
| One of: `transparent`, `currentcolor`, `black`, `white`, `red`, `green`, `blue`, `yellow`, `orange`, `purple`, `pink`, `gray`, `grey` (case-insensitive) | `COLOR` |
| `^-?\d*\.?\d+(ms\|s)\s*$` | `DURATION` |
| `\d+(px\|rem\|em).*\d+(px\|rem\|em)` AND value contains `,` | `SHADOW` |
| `^-?\d*\.?\d+(px\|rem\|em\|%\|vh\|vw\|vmin\|vmax\|ch\|ex)\s*$` | `SPACING` |
| `^-?\d+$` (bare integer) | `Z_INDEX` |

Anything else → `OTHER`.

**Total categories (14)**: `COLOR`, `SPACING`, `TYPOGRAPHY`, `SHADOW`,
`RADIUS`, `DURATION`, `Z_INDEX`, `EFFECTS`, `LAYOUT`, `SIZING`,
`BORDER`, `OPACITY`, `ICON`, `OTHER`. Both plugins ship the same
enum; webview consumers (`CATEGORY_ORDER`, `CATEGORY_GLYPHS`) must
list every entry or TypeScript will fail.

## 8. `TokenReference.expression` — insertion form

How a token is materialized in source code when inserted/replaced:

| Kind | Insertion form |
|---|---|
| `SCSS_VARIABLE` | `$name` (verbatim — name already carries the `$`) |
| `CSS_CUSTOM_PROPERTY` | `var(--name)` |
| `JS_OBJECT_PATH` | `'{path.to.token}'` |
| `JS_RUNTIME_PROPERTY` | `name` verbatim (property access expression) |
| `JS_RUNTIME_FUNCTION` | `name` verbatim (bare helper or applied call) |

## 9. Color parsing

Used by the variant table renderer (`VariantTableHtml.kt` →
`ui/tokenMarkdown.ts`) and by the Library swatch generator
(`ui/colorSwatch.ts`).

### Accepted forms

| Form | Regex / lookup |
|---|---|
| Named (case-insensitive) | `transparent`, `currentcolor`, `black`, `white`, `red`, `green`, `blue`, `yellow`, `orange`, `purple`, `pink`, `gray`, `grey` |
| Hex 3 / 4 / 6 / 8 digits | `^#([0-9a-fA-F]{3,8})$` |
| `rgb()` / `rgba()` | `^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$` |
| `hsl()` / `hsla()` | `^hsla?\(\s*([0-9.]+)(?:deg)?\s*[, ]\s*([0-9.]+)%\s*[, ]\s*([0-9.]+)%\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$` |

### Conversions

- **3-digit hex** widens each char: `0xA` → `0xAA` (multiply by `0x11`).
- **HSL → RGB**: standard formula (`q = l<0.5 ? l*(1+s) : l+s-l*s; p = 2l-q`),
  then `hueToRgb(p, q, h ± 1/3)`. Hue input is normalised to `[0, 1]`.
- **Alpha**: `0..1` floats, or `N%` syntax. Stored as `0..255` int.
- **`currentcolor`**: rendered as a neutral grey placeholder (`#808080`)
  since we can't resolve it without runtime CSS context.

### Output conversions (`ColorConversions.kt` → `ui/colorConversions.ts`)

Used by **Copy Token Value** (§15) to offer a colour in formats other
than its source.

- **`toHex` / `toRgb` / `toHsl`**: emit the canonical CSS strings;
  alpha is dropped when opaque (`a == 255`), else appended (`#rrggbbaa`,
  `rgba(…)`, `hsla(… / a)`).
- **`toOklch`**: Björn Ottosson's sRGB → OKLab → OKLCH transform
  (linearise sRGB, the two fixed 3×3 matrices, cube roots, `atan2` for
  hue). Output `oklch(L C Hdeg)` with L/C at 3 dp, H at 1 dp.
- **`detectFormat`**: prefix-sniffs `#` / `oklch` / `hsl` / `rgb`;
  named colours return `null` (no source format → offer all four).
- **Locale**: JS `Number.toFixed`/`toString` always emit `.`, so unlike
  Kotlin/Java no explicit locale guard is needed. The shared `trim`
  helper rounds + drops trailing zeros for every formatter.

### Cache key (VSCode-only)

Library swatches are cached on disk by their canonical 8-char hex
`rrggbbaa` (lowercase). Equivalent literals (`#ff0000`, `rgb(255,0,0)`,
`red`) share a single SVG file. Alpha < 255 triggers a checkerboard
background layer.

## 10. Order-sensitive behaviors

- **Grouping by name**: declarations are grouped by `name`, preserving
  *source order*. The first declaration is the primary; the rest become
  variants with `condition + value` deduplication.
- **JS_OBJECT_PATH**: tokens with a `modeLight`/`modeDark` segment are
  collapsed under their mode-stripped canonical name. Sibling mode
  declarations become variants of one logical token.
- **Variant sort**: not sorted — `variants` preserves declaration order
  from the source file. This matters for theme grouping: themes are
  consecutive only because they appear consecutively in the source.

## 11. Hardcoded-value detection

### Literal finder regex set (stylesheets)

| Constant | Pattern |
|---|---|
| `HEX_REGEX` | `(?<![A-Za-z0-9_-])#([0-9a-fA-F]{8}\|[0-9a-fA-F]{6}\|[0-9a-fA-F]{4}\|[0-9a-fA-F]{3})\b` |
| `FN_COLOR_REGEX` | `(?<![A-Za-z0-9_-])(?:rgb\|rgba\|hsl\|hsla\|hwb)\(\s*[^)]*\)` (case-insensitive) |
| `DURATION_REGEX` | `(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:ms\|s)\b` |
| `LENGTH_REGEX` | `(?<![A-Za-z0-9_-])-?\d*\.?\d+(?:px\|rem\|em\|vh\|vw\|vmin\|vmax\|ch\|ex\|%)\b` |
| `VAR_WITH_FALLBACK` | `var\(\s*--[A-Za-z_][A-Za-z0-9_-]*\s*,([^)]*)\)` |

### Exclusion rules

- Literals inside the captured fallback group of `VAR_WITH_FALLBACK` are
  ignored (they're a deliberate safety net, not hardcoded).
- The whitelist `{ "0", "0px", "0rem", "0em", "0%", "100%", "0s", "0ms" }`
  is skipped (case-insensitive).
- **Token-declaration values are skipped** — a literal that sits in the
  value position of a token declaration IS the token's own definition;
  flagging it would offer a circular `var(--foo)` replacement on the
  very declaration of `--foo`. The three recognised declaration
  patterns are:
  - `"key": value` — quoted SCSS map entry (the user's
    `$themes-config -> "themeOne" -> "light" -> "tokenName": #abc,` chain).
  - `$name: value` — SCSS variable.
  - `--name: value` — CSS custom property.

  Plain CSS property uses (`font-size: 14px`, `color: #abc`) **are**
  flagged — those are real hardcoded values. The distinguishing rule is
  the `$` / `--` prefix on the bare identifier, or any surrounding quote
  for the SCSS map case. The check runs against the wrapper-**expanded**
  replace range, so `$padding: rem-calc(14px)` correctly counts as a
  declaration (without that, the panel would offer to replace
  `rem-calc(14px)` with `var(--padding)` — circular).
- A literal sitting as the sole argument of a **transparent wrapper**
  (`rem-calc`, `rem`) gets its replace range expanded to cover the whole
  call so quick-fixes produce `var(--token)` instead of
  `rem-calc(var(--token))`. Match is on the trailing identifier after
  any `module.` prefix.

### Value normalisation (`TokenValueIndex.normalize`)

| Category | Rule |
|---|---|
| `COLOR` | `parseColor(v)` → canonical lowercase `#rrggbb` (or `#rrggbbaa` if alpha < 255). |
| `SPACING` / `RADIUS` / `TYPOGRAPHY` | `px`/`rem`/`em` → canonical px float assuming 16-px root font-size. Other units keep raw lowercased form. |
| Anything else | Lowercased trim only. |

### Cross-category lookup

A `LENGTH` literal is looked up against `SPACING`, `RADIUS` **and**
`TYPOGRAPHY` candidates. The diagnostic surfaces all matches; the
quick-fix lists them in source order (alphabetical fallback handled at
the index-build level).

### Helper-call synthesis

For LENGTH and DURATION hits, the VS Code aggregator also surfaces
**synthetic** call candidates from indexed `JS_RUNTIME_FUNCTION`
tokens. Algorithm (mirror of `SuggestionEngine.helperSuggestionsFor`
in [src/scanner/helperSuggestions.ts](src/scanner/helperSuggestions.ts)):

1. Parse the literal magnitude — strip the trailing unit, parse the
   numeric core.
2. For every helper with `functionUnit != null`:
   - `multiplier = literal / unit`
   - `snapped = round(multiplier × 4) / 4` (quarter-step snapping)
   - reject if `snapped < 0.25` or `snapped > 12.0`
   - reject if `|multiplier - snapped| > 0.05`
   - reject if `|unit × snapped - literal| > 0.5`
3. Emit a synthetic `DesignToken` cloned from the helper, with
   `name = \`${helper.name}(${formatMultiplier(snapped)})\``,
   `rawValue = formatProduced(unit × snapped)`. The apply pipeline
   reads `tokenExpression(t) = t.name`, so the user sees the call
   verbatim inserted.

Colour helpers aren't attempted — they're not linear in a single
scalar.

### VSCode-only differences from IntelliJ

- No `NUMBER_PROP_REGEX` — unitless property values are an RN/CSS-in-JS
  thing and the VSCode side only inspects stylesheets so far.
- No `isInsidePartialString` — same reason (JS string literal handling).
- No `SuggestionEngine` cross-property smartness for **exact-value**
  candidates — they're ordered by their `byNormalized` map order
  (= source order of the primary-token declarations in the scanned
  files). Helper-call candidates run through the algorithm above.

## 12. Webview UI architecture (VSCode side)

The Library, Hardcoded and Analyse panels are implemented as VSCode
webviews. Each panel has:

- A **host provider** in `src/views/<name>WebviewProvider.ts` that
  owns the webview lifecycle, the data model and the message handling.
- A **client bundle** at `src/webview/<name>/main.ts` that runs in the
  webview iframe, receives data via `window.addEventListener("message")`
  and posts user-driven events via `acquireVsCodeApi().postMessage`.
- A **stylesheet** at `src/webview/<name>/style.css`, copied to
  `out/webview/<name>.css` by `esbuild.js` and served via
  `webview.asWebviewUri`. All colors pull from VSCode's CSS variables
  (`var(--vscode-…)`) so theming Just Works.

The host/client contract is the discriminated union in
`src/webview/shared/protocol.ts` — single source of truth for messages
in both directions.

### Wire format conversions

`src/views/wireConversions.ts` translates rich host types into the
serialisable shapes the webview consumes. Notable transforms:

- `toWireToken(token)` pre-computes the canonical `#rrggbb[aa]` hex
  for COLOR tokens so the client can render swatches via plain
  `background-color`, without re-parsing on the browser side. Tokens
  whose color isn't parseable get `hex: null` → the client falls back
  to a category glyph.
- `tooltipMarkdown` is built eagerly on every conversion (same renderer
  the hover popup uses). The alternative — lazy fetch on hover — would
  add a round trip per tooltip, which is more visible than a single
  up-front pass on a few thousand tokens.

### CSP & security

`buildWebviewHtml` (in `src/views/webviewHtml.ts`) emits a strict CSP:

```
default-src 'none';
style-src <webview.cspSource> 'unsafe-inline';
script-src 'nonce-<random>';
img-src <webview.cspSource> data:;
font-src <webview.cspSource>;
```

A 32-char nonce is generated per render and stamped on both the CSP
header and the `<script>` tag. `localResourceRoots` is restricted to
`out/`.

## 13. Named scopes

Tokens are grouped under **scopes** so a multi-UI project (mobile,
desktop, common…) can keep its catalogues isolated. The active editor
file determines which scopes are visible at any moment.

### Configuration shape

```json
"tokenFlow.scopes": [
  {
    "name": "common",
    "rootPath": "",
    "sourcePaths": ["src/styles/tokens-common"],
    "whitelistPaths": [],
    "excludedPaths": []
  },
  {
    "name": "mobile",
    "rootPath": "apps/mobile",
    "sourcePaths": ["apps/mobile/styles/tokens"],
    "whitelistPaths": ["node_modules/some-lib/_variables.scss"],
    "excludedPaths": ["apps/mobile/legacy"]
  }
]
```

- `name` — user-facing label.
- `rootPath` — workspace-relative folder. Empty = common scope (always
  active).
- `sourcePaths` — files or folders that **declare** the scope's tokens.
- `whitelistPaths` — files whose variables are **external/known** (e.g.
  bundled libraries). Their tokens are indexed for Hover + Completion +
  Library, but flagged `external: true` so they're NOT proposed as
  Hardcoded-replacement candidates and NOT counted in Analyse
  project-health metrics.
- `excludedPaths` — folders/files inside the scope's `rootPath` that
  the Hardcoded panel + Analyse aggregator must skip entirely.
  Equivalent to the IntelliJ `analysisExcludedPaths`.

### Settings UI

Configuration is edited through a dedicated **Settings webview** (full
tab) — opened via the status-bar item, the `Token Flow: Configure
Scopes…` command, or the `$(settings-gear)` button on the Library view.
The panel exposes a master-detail editor with native folder/file
pickers; writes always target the **workspace** target (not user
settings) since scope config is project-specific.

When `tokenFlow.scopes` is empty, the deprecated `tokenFlow.sourcePaths`
setting is wrapped into a single implicit "common" scope (back-compat).

### Active-scope resolution rule

For a given file URI, the active scopes are:
- every **common** scope (empty `rootPath`)
- **plus the single deepest** non-common scope whose `rootPath` (or any
  of its `sourcePaths`) is a prefix of the file path. Picking the
  deepest match prevents a generic scope (`bo/src`) from masking a more
  specific one (`bo/src/app/feature-x`).

Source-path matches take precedence over rootPath matches when scoring
the deepest candidate.

### Per-token scope tag

Every `DesignToken` carries a `scope: string` field set to the scope
that originally indexed it. Consumers filter by
`activeScopeNames.has(token.scope)`.

### Refresh semantics

Scope changes do **not** invalidate the token index — only the
read-time filter changes. The `ActiveScopeTracker` (host-side) emits
`onDidChange` when the resolved active-scope identity moves; each
consumer (`HoverProvider`, `CompletionItemProvider`,
`HardcodedDiagnostics`, `HardcodedWebviewProvider`,
`LibraryWebviewProvider`, `showAlternatives`) subscribes and either
re-broadcasts to its webview or recomputes on next request.

The scanner cache is only invalidated when settings change
(`tokenFlow.scopes` / `tokenFlow.sourcePaths`), because at that point
the scope-tag attached to a token might shift.

## 14. Caveats / known divergences

- **Vue SFC support**: IntelliJ extracts `<style lang="…">` blocks from
  `.vue` files via `VueStyleBlockExtractor`. VSCode does not — the
  ecosystem there relies on the Volar extension which exposes virtual
  documents that VS Code already routes through `scss`/`css` providers.
  Re-adding a Vue extractor on the TS side would duplicate that work.
- **`TokenNameParser.resolveReference`**: only the mode-segment helpers
  (`stripModeSegment`, `modeSegmentOf`) are ported. The camelCase /
  dot-drift reconciliation used by IntelliJ's call-site rewriter isn't
  needed yet on the VSCode side — Alt+T replacements use the verbatim
  `tokenExpression(token)`.
- **`SuggestionEngine` ranking**: VSCode candidates surface in
  value-index order (source order of declarations). IntelliJ has a
  multi-criterion ranking (category / role / tier / name length). To
  port when usage warrants.
- **Alt+T picker styles**: IntelliJ uses a native funnel popup; VSCode
  ships two modes user-selectable in Preferences — `webviewBeside`
  (default, side-column webview) and `completion` (native IntelliSense
  popup under the caret). See [src/views/alternativesPicker.ts](src/views/alternativesPicker.ts)
  and [src/views/alternativesCompletion.ts](src/views/alternativesCompletion.ts).
- **Programmatic CSS variable injection** (`document.documentElement.style.setProperty(…)`)
  is **not** indexed by either plugin — references to `var(--x)` in
  stylesheets are detected, but the JS write-site that sets the value
  at runtime is out of scope for static analysis.

## 15. Copy Token Value (issue #27)

Port of the IntelliJ v0.2.3 "Copy resolved value" gesture
(`CopyTokenValueShower` + `ColorConversions`). Copies the token under
the caret as its resolved value, name, or — for colours — one of four
CSS formats.

- **Gesture mapping**: IntelliJ uses `⌘/Ctrl+Shift+Click`; VS Code
  reserves Ctrl/Cmd+Click for Go-to-Definition and exposes no editor
  mouse hook, so the port ships **command + keybinding (`Alt+V`) +
  editor context menu + hover copy links**. See
  [doc/copy-token-value.md](doc/copy-token-value.md).
- **Resolution**: same alias chain as hover / go-to-definition —
  `scanner/resolveTokenReference.ts` (`resolveTokenByReference`) on top
  of the value the scanner already resolved to the primitive
  (`DesignToken.resolvedValue`).
- **Dropdown order** (invariant): **Resolved value** first + preselected,
  then colour alternates (skipping the source format, §9 output
  conversions), then the **token name** (`tokenExpression`) when it
  differs.
- **Inert when irrelevant**: the keybinding + menu are gated on the
  scan-backed `tokenFlow.onTokenReference` context key — true only when
  the reference under the caret resolves to a token in the active scope.
- **Toggle**: `tokenFlow.copyValue.enabled` (default `true`) gates the
  command, the menu entry and the hover links.

---

**Last sync'd against**: IntelliJ token-flow `v0.1.2` baseline, plus
Phase 1–5 JS-parser port (commit pending), helper-call synthesis,
14-category parity, and mode-segment collapsing. VS Code port is now
at functional parity with IntelliJ for the **detection engine**
(capabilities 1–7 + 9 in the project's tracked list).
