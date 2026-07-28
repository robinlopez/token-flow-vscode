// §2.B / §4.B — the vocabulary filter. Does a `'{…}'` name belong to
// the project's token vocabulary at all?

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOneEditApart, TokenPathShape } from "../scanner/tokenPathShape";

/** Catalog with CSS custom properties + SCSS vars only — no JS paths. */
const CSS_ONLY = TokenPathShape.of(
  new Set([
    "--actions-high-surface-default",
    "--radius-full",
    "$track-thickness",
  ]),
);

/** Catalog of dotted JS paths. */
const JS_PATHS = TokenPathShape.of(
  new Set(["color.primary", "color.surface.default", "spacing.sm"]),
);

/** Catalog mixing bare names with dotted ones. */
const FLAT_JS = TokenPathShape.of(new Set(["brand", "ink", "radius.sm"]));

test("isBraceStringReference recognises the alias syntax only", () => {
  assert.equal(TokenPathShape.isBraceStringReference(`'{a.b}'`), true);
  assert.equal(TokenPathShape.isBraceStringReference(`"{a.b}"`), true);
  assert.equal(TokenPathShape.isBraceStringReference("`{a.b}`"), true);
  assert.equal(TokenPathShape.isBraceStringReference(`var(--x)`), false);
  assert.equal(TokenPathShape.isBraceStringReference(`dt('a.b')`), false);
  assert.equal(TokenPathShape.isBraceStringReference(`$x`), false);
});

// ─── Rule 1: no JS-path token in the project at all ─────────────────────

for (const name of ["first", "rows", "page", "totalRecords", "color.primary"]) {
  test(`CSS-only catalog rejects '{${name}}'`, () => {
    assert.equal(CSS_ONLY.isPlausibleReference(`'{${name}}'`, name), false);
  });
}

test("CSS-only catalog still accepts the unambiguous syntaxes", () => {
  assert.equal(CSS_ONLY.isPlausibleReference("var(--nope)", "--nope"), true);
  assert.equal(CSS_ONLY.isPlausibleReference("$nope", "$nope"), true);
  assert.equal(
    CSS_ONLY.isPlausibleReference(`dt('color.primary')`, "color.primary"),
    true,
  );
});

// ─── Rules 2–4: dotted JS-path catalog ──────────────────────────────────

const JS_PLAUSIBLE: readonly string[] = [
  "color.primary", //          rule 2 — exact
  "color.primry", //           rule 3 — known root, typo in the leaf
  "spacing.xxl", //            rule 3 — known root, unknown leaf
  "colr.primary", //           rule 4 — root one edit away
  "spacng.sm", //              rule 4 — root one edit away
];

for (const name of JS_PLAUSIBLE) {
  test(`JS-path catalog accepts '{${name}}' as a reference`, () => {
    assert.equal(JS_PATHS.isPlausibleReference(`'{${name}}'`, name), true);
  });
}

const JS_REJECTED: readonly string[] = [
  "user.name",
  "route.params.id",
  "first",
  "totalRecords",
  "pageCount",
];

for (const name of JS_REJECTED) {
  test(`JS-path catalog rejects '{${name}}'`, () => {
    assert.equal(JS_PATHS.isPlausibleReference(`'{${name}}'`, name), false);
  });
}

// ─── Rule 5: flat JS names keep the historic behaviour ──────────────────

test("flat catalog resolves a bare name", () => {
  assert.equal(FLAT_JS.isPlausibleReference(`'{brand}'`, "brand"), true);
});

test("flat catalog keeps a bare typo as a (broken) reference", () => {
  assert.equal(FLAT_JS.isPlausibleReference(`'{inkk}'`, "inkk"), true);
});

test("flat catalog still rejects an unknown dotted path", () => {
  assert.equal(
    FLAT_JS.isPlausibleReference(`'{user.name}'`, "user.name"),
    false,
  );
});

// ─── Bounded edit distance ──────────────────────────────────────────────

test("isOneEditApart accepts substitution, insertion and deletion", () => {
  assert.equal(isOneEditApart("colr", "color"), true); //     insertion
  assert.equal(isOneEditApart("spacng", "spacing"), true); // insertion
  assert.equal(isOneEditApart("colour", "colonr"), true); //  substitution
  assert.equal(isOneEditApart("colors", "color"), true); //   deletion
});

test("isOneEditApart rejects two edits and short roots", () => {
  assert.equal(isOneEditApart("user", "color"), false);
  assert.equal(isOneEditApart("route", "color"), false);
  // Under 4 chars a single edit carries no signal — bail out.
  assert.equal(isOneEditApart("ink", "int"), false);
  assert.equal(isOneEditApart("abc", "abd"), false);
});
