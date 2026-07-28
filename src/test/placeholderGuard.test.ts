// §2.A / §4.A — the string-helper guard. A `'{…}'` handed to
// `replace` / `split` / `instant` … is a runtime placeholder, never a
// token alias.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enclosingCallee,
  isPlaceholderCallArgument,
} from "../scanner/placeholderGuard";

/** Offset of the first `'{`, `"{` or `` `{ `` in [text]. */
function braceStringOffset(text: string): number {
  const i = text.search(/['"`]\{/);
  assert.notEqual(i, -1, `no brace-string literal in: ${text}`);
  return i;
}

test("enclosingCallee finds the call a string argument belongs to", () => {
  const text = `template.replace('{first}', '1')`;
  assert.equal(
    enclosingCallee(text, braceStringOffset(text)),
    "template.replace",
  );
});

test("enclosingCallee stops at a block/object brace", () => {
  const text = `const theme = { primary: '{color.primary}' };`;
  assert.equal(enclosingCallee(text, braceStringOffset(text)), null);
});

test("enclosingCallee skips nested calls", () => {
  const text = `format(labelFor(row), '{first}')`;
  assert.equal(enclosingCallee(text, braceStringOffset(text)), "format");
});

test("enclosingCallee skips quoted arguments containing parens", () => {
  const text = `raw.replace('(', '').replace('{first}', '1')`;
  const offset = text.indexOf("'{first}'");
  assert.equal(enclosingCallee(text, offset), ".replace");
});

// ─── §4.A table ─────────────────────────────────────────────────────────

const DROPPED: readonly string[] = [
  `.replace('{first}', String(state.first))`,
  `this.translate.instant('{count}')`,
  `raw.split('{sep}')`,
  `pattern.test('{x}')`,
  `raw.replace('(', '').replace('{first}', '1')`,
  `i18n.t('{count}')`,
  `intl.formatMessage('{total}')`,
  `sprintf('{name}', who)`,
  // Trailing-identifier comparison — the receiver chain is irrelevant.
  `TranslateService.transform('{count}')`,
  `this.i18n.format('{total}')`,
];

for (const snippet of DROPPED) {
  test(`placeholder call argument: ${snippet}`, () => {
    assert.equal(
      isPlaceholderCallArgument(snippet, braceStringOffset(snippet)),
      true,
    );
  });
}

const KEPT: readonly string[] = [
  `primary: '{color.primary}'`,
  `resolveToken('{color.primary}')`,
  `const alias = '{color.primary}';`,
  `{ surface: { default: '{color.surface.default}' } }`,
];

for (const snippet of KEPT) {
  test(`not a placeholder call argument: ${snippet}`, () => {
    assert.equal(
      isPlaceholderCallArgument(snippet, braceStringOffset(snippet)),
      false,
    );
  });
}

test("the lookback is bounded — a far-away callee is not attributed", () => {
  const filler = "x".repeat(600);
  const text = `replace(${filler}, '{first}')`;
  assert.equal(
    isPlaceholderCallArgument(text, braceStringOffset(text)),
    false,
  );
});
