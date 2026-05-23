<div align="center">

<img src="https://res.cloudinary.com/doiw6rqul/image/upload/v1779532090/Token%20Flow/token-flow-cover-vs-code.png" alt="Token Flow — VSCode Edition" width="100%"/>

# Token Flow — VSCode Edition

Find, insert, swap and audit design tokens (SCSS · CSS · TS/JS) from inside VSCode — without ever leaving your editor.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![VSCode 1.85+](https://img.shields.io/badge/VSCode-1.85%2B-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![IntelliJ edition](https://img.shields.io/badge/IntelliJ%20edition-companion-orange?logo=jetbrains)](https://github.com/robinlopez/token-flow)

</div>

---

## Why?

Make using your tokens intuitive. Token Flow helps you find the right
variable and keep your styles flawless without ever leaving your VSCode
editor.

Supported formats:

- SCSS variables (`$color-primary-500`)
- CSS Custom Properties (`--color-primary-500`)
- SCSS Maps (`("color-primary-500": #5d3fd3)`)
- TS/JS preset objects — `'{path.to.token}'`

---

## 🔎 Library — every token at a glance

A dedicated **Token Flow** entry in the activity bar opens a rich
panel listing every indexed token, grouped by category. Inline color
swatches, two-line name + resolved-value previews, variant badges,
multi-term search (`"informative content"` finds
`--token-informative-highlight-content-hover`), category + kind filter
chips. Drag any row into the editor to insert the canonical
`var(--x)` / `$x` / `'{path}'` form at the drop position.

---

## ⚡️ Smart swapping — `Alt+T`

<img src="https://res.cloudinary.com/doiw6rqul/image/upload/v1779532089/Token%20Flow/token-flow-smart-swapping-vs-code.png" alt="Smart swapping with Alt+T" width="100%"/>

Pick a sibling token of the same category — swap a `var(--…)` for
another, or "tokenize" a hardcoded `14px` literal in one keystroke.
A custom webview picker (not the native QuickPick) renders real CSS
color swatches, groups candidates by category, floats exact-value
matches to the top, and pre-selects the pivot on open. Keyboard or
mouse, your choice.

---

## 🛟 Smart refactoring — hardcoded value detection

<img src="https://res.cloudinary.com/doiw6rqul/image/upload/v1779532089/Token%20Flow/token-flow-smart-refactoring-vs-code.png" alt="Hardcoded value detection and replacement" width="100%"/>

Literals that already exist as tokens (`#fff`, `14px`, `200ms`, …)
get a `Hint`-severity diagnostic with a lightbulb quick-fix that
replaces them with the canonical reference. A dedicated **Hardcoded**
panel follows the active editor and lists every match in the current
file, with inline swatches, alternative-candidate cycling, jump-to-source
and one-click replacement (workspace edit — undoable like any edit).
Aware of transparent wrappers like `rem-calc(14px)`.

---

## 📊 Health audit — Analyse dashboard

<img src="https://res.cloudinary.com/doiw6rqul/image/upload/v1779532088/Token%20Flow/token-flow-health-audit-vs-code.png" alt="Design system health audit dashboard" width="100%"/>

A full-tab Design System health report. Global score (A→F) on a
circular gauge, five sub-axes (semantic coherence, usage coverage,
duplication, hardcoded pressure, reference integrity), and accordion
drilldowns for hardcoded clusters, broken refs, unused / duplicate /
incoherent tokens, per-file coverage. Every row links straight to the
source.

---

## 🧠 More inside

- **Hover info** — popup with resolved value & per-mode variants
  (light / dark / breakpoints) of the token under the caret.
  Multi-theme aware: nested SCSS maps render with theme-grouped
  column headers.
- **Go to Token Declaration** — `Ctrl+Click` / `F12` / Peek on any
  `var(--x)`, `--x` or `$x` reference, via VSCode's native Definition
  flow. Works with stylesheets and TS/JS preset paths.
- **Code completion** — triggered after `var(--` or `$`, sorted
  alphabetically, filtered by VSCode's fuzzy matcher.
- **Named scopes** — multi-UI projects (mobile / desktop / preset /
  common) supported via named scopes with their own root path, source
  paths, whitelists and excludes. A master-detail **Settings webview**
  ships with native folder/file pickers and saves directly to workspace
  settings — no JSON hand-editing needed.

---

## Use cases

- **Migration** — refactor a hardcoded codebase to design tokens, file by file.
- **Multi-brand audit** — keep a multi-brand or light/dark Design System aligned and free of dead tokens.
- **Theme debugging** — see how a token resolves in Dark vs Light mode via the hover popup.
- **Preset iteration** — work on a PrimeUIX / Style-Dictionary preset with instant feedback.

## About

Built by **Robin Lopez** — designer & front-end engineer.

[robinlopez.fr](https://www.robinlopez.fr/) · [LinkedIn](https://www.linkedin.com/in/robin-lopez-designer/) · [Bluesky](https://bsky.app/profile/lopezrobin.bsky.social) · [Bento](https://robinlopez.github.io/robinlopezbento/)

If Token Flow saves you time, you can support its development:

<a href="https://www.buymeacoffee.com/robinlopez">
  <img src="https://res.cloudinary.com/doiw6rqul/image/upload/v1778160520/Token%20Flow/buy-coffee-btn.png" alt="Buy Me A Coffee" width="180"/>
</a>
