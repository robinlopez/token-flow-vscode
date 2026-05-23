<div align="center">

<img src="media/pluginIcon.png" alt="Token Flow" width="128"/>

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

## Highlights

- 🔎 **Library webview** — searchable side panel with swatches, drag-and-drop, category + kind filter chips, multi-term search, per-row copy & goto buttons.
- ⚡️ **Alternatives picker (`Alt+T`)** — custom webview, not the native QuickPick: real CSS swatches, category grouping, pivot pre-selection, keyboard + mouse navigation.
- 🛟 **Hardcoded value inspection** — `Hint`-level diagnostics on literals that already have a matching token, with a lightbulb quick-fix. Aware of transparent wrappers (`rem-calc(14px)`).
- 🧭 **Go to Token Declaration** — `Ctrl+Click` / `F12` / Peek on any token reference, via VSCode's native Definition flow.
- 🧠 **Hover info** — popup with resolved value & per-mode variants (light / dark / breakpoints) of the token under the caret.
- 📊 **Analyse dashboard** — full Design System health report: global score (A→F) on a circular gauge, sub-axes (semantic coherence, usage coverage, duplication, hardcoded pressure, reference integrity), drilldowns linked to source.
- 🌳 **Scopes** — multi-UI projects (mobile / desktop / preset / common) supported via named scopes with their own root path, source paths, whitelists and excludes. Master-detail Settings webview included.

## Install

### From a local build

Prerequisites: Node 18+.

```bash
npm install
npm run package
# → token-flow-X.Y.Z.vsix
```

Then: **Extensions → ⋯ → Install from VSIX…** and pick the `.vsix`.
Or via CLI:

```bash
code --install-extension token-flow-0.1.0.vsix
```

VSCode Marketplace publication is on the roadmap.

## Use cases

- **Migration** — refactor a hardcoded codebase to design tokens, file by file.
- **Multi-brand audit** — keep a multi-brand or light/dark Design System aligned and free of dead tokens.
- **Theme debugging** — see how a token resolves in Dark vs Light mode via the hover popup.
- **Preset iteration** — work on a PrimeUIX / Style-Dictionary preset with instant feedback.

## Stack

- TypeScript 5 + esbuild (host bundle + per-webview bundles)
- VSCode API 1.85+ (extension host + webviews with `retainContextWhenHidden`)
- Pure-text parsing (no language-server dependency) → works on every VSCode edition, including web

## Project layout

```
src/
├── model/          DesignToken, TokenCategory, TokenKind
├── scanner/        TokenScanner, parsers, DesignSystemAnalyzer
├── providers/      hover, completion, definition, code-action, drop
├── actions/        commands (Alt+T, refresh, configure scopes…)
├── settings/       scope resolver, settings I/O
├── services/       active-scope tracker, diagnostics
├── views/          webview hosts (Library, Hardcoded, Analyse, Settings, Alt+T picker)
├── webview/        per-webview clients (TS + CSS) bundled separately
└── extension.ts    activation entry point
```

## Roadmap & changelog

- 📍 [`PLAN.md`](PLAN.md) — phases, what's done, what's next
- 📝 [`CHANGELOG.md`](CHANGELOG.md) — detailed change log per version
- 📋 [`SHARED_LOGIC.md`](SHARED_LOGIC.md) — invariants shared with the IntelliJ edition

## Contributing

Bug reports, feature requests and PRs are welcome. Open an issue first
for non-trivial changes so we can align on direction.

## License

[MIT](LICENSE) · © Robin Lopez

## About

Built by **Robin Lopez** — designer & front-end engineer.

[robinlopez.fr](https://www.robinlopez.fr/) · [LinkedIn](https://www.linkedin.com/in/robin-lopez-designer/) · [Bluesky](https://bsky.app/profile/lopezrobin.bsky.social) · [Bento](https://robinlopez.github.io/robinlopezbento/)

If Token Flow saves you time, you can support its development:

<a href="https://www.buymeacoffee.com/robinlopez">
  <img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee&emoji=&slug=robinlopez&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee" width="180"/>
</a>
