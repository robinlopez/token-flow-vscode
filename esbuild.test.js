// Test-bundle configuration.
//
// The extension has no test runner of its own — it ships as a single
// esbuild bundle and the scanner is deliberately pure text processing.
// That lets us test the parsing/decision layer with plain `node --test`
// and zero extra dependencies: esbuild transpiles each `*.test.ts` into
// `out-test/`, then Node's built-in test runner picks them up.
//
// Only `vscode`-free modules can be covered this way. `referenceScan`,
// `placeholderGuard`, `tokenPathShape` and `tokenNameParser` were kept
// free of the host API precisely so the reference-resolution rules
// (SHARED_LOGIC.md) are testable.
//
//   npm test

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const TEST_DIR = path.join(__dirname, "src", "test");
const OUT_DIR = path.join(__dirname, "out-test");

const entryPoints = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(TEST_DIR, f));

if (entryPoints.length === 0) {
  console.error("[esbuild:test] no *.test.ts found under src/test");
  process.exit(1);
}

esbuild
  .build({
    entryPoints,
    bundle: true,
    outdir: OUT_DIR,
    format: "cjs",
    platform: "node",
    target: "node18",
    // `vscode` must never end up in a test bundle. Marking it external
    // turns an accidental import into a clear runtime failure instead of
    // a confusing esbuild resolution error.
    external: ["vscode", "node:test", "node:assert"],
    sourcemap: "inline",
    logLevel: "warning",
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
