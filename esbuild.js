// esbuild configuration for the extension.
//
// Two distinct bundles are produced because the host and the webviews
// run in completely different execution environments:
//
//   • Extension host  — Node CommonJS module, has the `vscode` API
//     injected by the IDE at load time.
//   • Webview clients — Browser-ish iframes with no Node APIs. Each
//     webview gets its own IIFE bundle whose only outside contract is
//     `acquireVsCodeApi()` (provided by the IDE) and the `postMessage`
//     protocol declared in `src/webview/shared/protocol.ts`.
//
// CSS files are copied verbatim from `src/webview/<name>/style.css` to
// `out/webview/<name>.css` so the host providers can serve them via
// `webview.asWebviewUri`. We deliberately skip esbuild's CSS bundling
// (no transforms needed yet, and keeping the source CSS readable makes
// theming-via-VSCode-CSS-variables straightforward).

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const WEBVIEW_NAMES = [
  "library",
  "hardcoded",
  "analyse",
  "settings",
  "alternatives",
];

const hostOpts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const webviewOpts = (name) => ({
  entryPoints: [`src/webview/${name}/main.ts`],
  bundle: true,
  outfile: `out/webview/${name}.js`,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

/** Copy the per-webview CSS into `out/webview/` so the host can serve it. */
function copyCss() {
  const outDir = path.join(__dirname, "out", "webview");
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of WEBVIEW_NAMES) {
    const src = path.join(__dirname, "src", "webview", name, "style.css");
    const dst = path.join(outDir, `${name}.css`);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
}

(async () => {
  const tasks = [hostOpts, ...WEBVIEW_NAMES.map(webviewOpts)];

  if (watch) {
    const ctxs = await Promise.all(tasks.map((o) => esbuild.context(o)));
    for (const ctx of ctxs) await ctx.watch();
    // Naive CSS sync: re-copy on every file change inside src/webview.
    const watcher = fs.watch(
      path.join(__dirname, "src", "webview"),
      { recursive: true },
      (_event, file) => {
        if (file && file.endsWith(".css")) copyCss();
      },
    );
    process.on("SIGINT", () => watcher.close());
    copyCss();
    console.log("[esbuild] watching host + webviews…");
  } else {
    await Promise.all(tasks.map((o) => esbuild.build(o)));
    copyCss();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
