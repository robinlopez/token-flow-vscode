# Development

Build, package and contribute to **Token Flow — VSCode Edition**.

## Stack

- TypeScript 5 + esbuild (host bundle + per-webview bundles)
- VSCode API 1.85+ (extension host + webviews with `retainContextWhenHidden`)
- Pure-text parsing (no language-server dependency) → works on every
  VSCode edition, including web

## Prerequisites

- Node 18+
- VSCode 1.85+ (for the Extension Host launch task)

## Install & run

```bash
npm install
npm run watch      # esbuild in watch mode
# Open this folder in VSCode → F5 to launch a sandboxed Extension Host
```

The watcher rebuilds the host (`out/extension.js`) and every webview
bundle (`out/webview/*.js`) on every change. Reload the Extension
Host window (`Cmd/Ctrl+R`) to pick up the rebuild.

## Tests

```bash
npm test
```

`esbuild.test.js` transpiles every `src/test/*.test.ts` into `out-test/`
and Node's built-in runner executes them — no extra dependency, no
Extension Host round-trip.

Only `vscode`-free modules can be covered this way. The reference
resolution rules (`scanner/referenceScan.ts`,
`scanner/placeholderGuard.ts`, `scanner/tokenPathShape.ts`,
`scanner/tokenNameParser.ts`) are kept free of the host API precisely so
the invariants in [`SHARED_LOGIC.md`](SHARED_LOGIC.md) §16 stay testable.
Anything touching those rules should ship with a case.

## Package a `.vsix`

```bash
npm run package    # produces token-flow-X.Y.Z.vsix
```

Install the resulting file in any VSCode via:

```bash
code --install-extension token-flow-X.Y.Z.vsix
```

Or from the UI: **Extensions → ⋯ → Install from VSIX…**.

## Publish to the Marketplace

```bash
npx vsce login robin-lopez   # one-time — needs a Personal Access Token
npx vsce publish              # reads version from package.json, publishes
```

`vsce publish` also re-reads `README.md` and refreshes the marketplace
listing — image edits and copy fixes ship via a normal version bump.

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

## Bundling model

Each webview ships as a separate esbuild bundle under `out/webview/`.
The host loads the bundle via a `vscode-resource:` URI and posts
messages through the typed protocol in `src/webview/shared/protocol.ts`.
Keeping every webview self-contained lets us treat the UI layer like a
tiny SPA without dragging a framework in.

## Cross-IDE parity

[`SHARED_LOGIC.md`](SHARED_LOGIC.md) lists the invariants that must
hold between this implementation and the [IntelliJ edition](https://github.com/robinlopez/token-flow).
Any PR that touches shared behaviour should update that doc and tick
the matching item in [`PLAN.md`](PLAN.md).

## Roadmap

See [`PLAN.md`](PLAN.md) for the phased roadmap and
[`CHANGELOG.md`](CHANGELOG.md) for the detailed per-version log.
