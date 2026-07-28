// End-to-end coverage of the reference-collection decision order —
// §4.A (placeholders), §4.B (vocabulary), §4.C (externalPrefixes).
//
// `referenceScan` is the single normative implementation shared by the
// Analyse dashboard; asserting on it here is what keeps the coverage
// ratio and the broken-reference list honest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanReferences, ReferenceScanResult } from "../scanner/referenceScan";
import { TokenPathShape } from "../scanner/tokenPathShape";

interface ScanOpts {
  readonly externalPrefixes?: readonly string[];
  readonly dynamicCssVars?: readonly string[];
}

function scan(
  text: string,
  tokenNames: readonly string[],
  opts: ScanOpts = {},
): ReferenceScanResult {
  const names = new Set(tokenNames);
  const dynamic = new Set(opts.dynamicCssVars ?? []);
  return scanReferences(text, {
    filePath: "/ws/src/app.scss",
    tokenNames: names,
    externalPrefixes: opts.externalPrefixes ?? [],
    pathShape: TokenPathShape.of(names),
    dynamicCssVars: { has: (n) => dynamic.has(n) },
  });
}

/** Raw text of each reported broken reference. */
function brokenNames(r: ReferenceScanResult): string[] {
  return r.broken.map((b) => b.name);
}

// The real-world regression: an Angular paginator whose message
// template collides with the Style-Dictionary alias syntax.
const PAGINATOR = `
currentPageReportTemplate = input<string>('{first} - {last} sur {totalRecords}');

protected readonly reportText = computed(() => {
  const state = this.state();
  return this.currentPageReportTemplate()
    .replace('{first}', String(state.first))
    .replace('{last}', String(state.last))
    .replace('{rows}', String(state.rows))
    .replace('{page}', String(state.page + 1))
    .replace('{pageCount}', String(state.pageCount))
    .replace('{totalRecords}', String(state.totalRecords));
});
`;

// ─── §4.A — placeholders are dropped, not merely un-broken ──────────────

test("paginator placeholders yield no reference at all (CSS-only catalog)", () => {
  const r = scan(PAGINATOR, ["--radius-full", "$track-thickness"]);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 0, "must not inflate the coverage ratio");
  assert.deepEqual([...r.referenced], []);
});

test("paginator placeholders stay dropped even when the name IS a token", () => {
  // `first` is in the catalog here, so the vocabulary filter would wave
  // `'{first}'` through. The syntactic guard is what must fire — the two
  // layers are independent, and this pins the first one down.
  const r = scan(PAGINATOR, ["color.primary", "spacing.sm", "first"]);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 0);
});

test("i18n and regex helpers are covered too", () => {
  const text = `
    const a = this.translate.instant('{count}');
    const b = raw.split('{sep}');
    const c = pattern.test('{x}');
    const d = raw.replace('(', '').replace('{first}', '1');
  `;
  const r = scan(text, ["color.primary"]);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 0);
});

test("an alias in an object literal survives the guard", () => {
  const text = `export const theme = { primary: '{color.primary}' };`;
  const r = scan(text, ["color.primary"]);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 1);
  assert.deepEqual([...r.referenced], ["color.primary"]);
});

test("an alias passed to a non-blacklisted callee survives the guard", () => {
  const text = `const v = resolveToken('{color.primary}');`;
  const r = scan(text, ["color.primary"]);
  assert.equal(r.tokenised, 1);
  assert.deepEqual([...r.referenced], ["color.primary"]);
});

// ─── §4.B — vocabulary filter ───────────────────────────────────────────

const JS_CATALOG = ["color.primary", "color.surface.default", "spacing.sm"];

test("a typo inside a known namespace is a broken reference", () => {
  const r = scan(`const t = { p: '{color.primry}' };`, JS_CATALOG);
  assert.deepEqual(brokenNames(r), [`'{color.primry}'`]);
  assert.equal(r.tokenised, 1);
});

test("a typo on the root segment is a broken reference", () => {
  const r = scan(`const t = { s: '{spacng.sm}' };`, JS_CATALOG);
  assert.deepEqual(brokenNames(r), [`'{spacng.sm}'`]);
  assert.equal(r.tokenised, 1);
});

test("an application path is not a reference at all", () => {
  const r = scan(`const id = '{route.params.id}';`, JS_CATALOG);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 0);
});

test("dt() is never routed through the vocabulary filter", () => {
  const r = scan(`const a = dt('color.primary'); const b = dt('nope.thing');`, JS_CATALOG);
  assert.deepEqual(brokenNames(r), [`dt('nope.thing')`]);
  assert.equal(r.tokenised, 2);
  assert.deepEqual([...r.referenced], ["color.primary"]);
});

// ─── §4.C — externalPrefixes ────────────────────────────────────────────

const SLIDER = `
.ui-slider {
  height: var(--ui-slider-handle-size, #{$handle-size});
  width: var(--ui-slider-thickness, #{$track-thickness});
  background: var(--p-button-primary-background);
  border-radius: var(--radius-fulll);
  gap: var(--ui-toggle-size, 20px);
}
`;

test("external prefixes are neutral: tokenised, never broken, never referenced", () => {
  const r = scan(SLIDER, ["--radius-full", "$track-thickness"], {
    externalPrefixes: ["--ui-slider-", "--p-"],
  });
  // The two unprefixed misses are still reported — a covered prefix must
  // not become a blanket amnesty.
  assert.deepEqual(brokenNames(r), [
    "var(--radius-fulll)",
    "var(--ui-toggle-size, 20px)",
  ]);
  // Every `var()` still counts as a tokenised assignment, external or not.
  assert.equal(r.tokenised, 5);
  // No canonical token behind an external prefix → nothing marked used,
  // so unused-token detection stays correct.
  assert.deepEqual([...r.referenced], []);
});

test("without the prefixes the same file reports every miss", () => {
  const r = scan(SLIDER, ["--radius-full", "$track-thickness"]);
  assert.equal(r.broken.length, 5);
});

test("a resolved token is recorded as used", () => {
  const r = scan(`.a { border-radius: var(--radius-full); }`, [
    "--radius-full",
  ]);
  assert.deepEqual(brokenNames(r), []);
  assert.deepEqual([...r.referenced], ["--radius-full"]);
});

test("a runtime-declared CSS var is not broken", () => {
  const r = scan(`.a { color: var(--runtime-accent); }`, ["--radius-full"], {
    dynamicCssVars: ["--runtime-accent"],
  });
  assert.deepEqual(brokenNames(r), []);
  assert.deepEqual([...r.referenced], ["--runtime-accent"]);
});

// ─── Invariants preserved from earlier versions ─────────────────────────

test("SCSS variables are counted and resolved but never broken", () => {
  const r = scan(`.a { width: $nope; height: $track-thickness; }`, [
    "$track-thickness",
  ]);
  assert.deepEqual(brokenNames(r), []);
  assert.deepEqual([...r.referenced], ["$track-thickness"]);
  assert.equal(r.tokenised, 2);
});

test("commented-out references are ignored", () => {
  const text = `
    /* background: var(--gone); */
    // color: var(--also-gone);
    .a { color: var(--radius-full); }
  `;
  const r = scan(text, ["--radius-full"]);
  assert.deepEqual(brokenNames(r), []);
  assert.equal(r.tokenised, 1);
});

test("broken references carry a 0-based line number", () => {
  const r = scan(`.a {\n  color: var(--gone);\n}`, []);
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].line, 1);
  assert.equal(r.broken[0].filePath, "/ws/src/app.scss");
});
