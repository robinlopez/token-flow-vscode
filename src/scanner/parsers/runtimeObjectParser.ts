// Port of `parsers/RuntimeObjectParser.kt`.
//
// Parses TS/JS files where design tokens are exposed as a typed
// runtime object — the convention used by most React-Native themes
// and CSS-in-JS setups:
//
//   const colors = { PRIMARY_500: '#FE5716', … };
//   export const nomTheme: Theme = { colors: { … }, radius: { sm: 8 } };
//
// Two declaration shapes are distinguished because they translate to
// different call-site expressions:
//
//   1. Typed theme aggregator — `export const X: SomeType = { … }`.
//      The binding is the umbrella object; barrel files re-export its
//      children (`colors`, `radius`, …) by name, not the whole `X`.
//      Emitted token names DROP the binding prefix:
//
//        export const nomTheme: Theme = {
//          fontPresets: { h1: { fontSize: 34 } },
//        };
//        // → token name = `fontPresets.h1.fontSize`
//
//   2. Token bag — `const X = { … }` (with or without `export`,
//      never typed). The binding IS the import name at the call
//      site, so the token name KEEPS the prefix:
//
//        const colors = { PRIMARY_500: '#FE5716' };
//        // → token name = `colors.PRIMARY_500`
//
// When the same logical value appears under both shapes (e.g.
// `nomTheme` aliases the local `colors` bag), the names collide
// intentionally and the scanner's `resolve()` collapses them — the
// user sees a single `colors.PRIMARY_500` entry regardless of which
// file authored the leaf.
//
// `export default { … }` is intentionally skipped — it has no binding
// name to inspect and is the canonical entry point of Style-Dictionary
// presets.

import { JsTokenFileParser, ParsedLeaf } from "./jsTokenFileParser";
import { parseAt } from "./jsObjectWalker";
import { registerParser } from "./jsTokenFileParserRegistry";

// Group 1 = binding identifier. Group 2 (when present) captures the
// type-annotation portion `: SomeType` — the discriminator between
// "typed theme aggregator" (strip prefix) and "token bag" (keep
// prefix). The `m` flag anchors `^` to line starts so we only pick up
// top-level declarations.
const DECL_REGEX =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(:\s*[^=\n]+?)?\s*=\s*\{/gm;

export const RuntimeObjectParser: JsTokenFileParser = {
  kind: "JS_RUNTIME_PROPERTY",
  parse(text: string): readonly ParsedLeaf[] {
    const out: ParsedLeaf[] = [];
    for (const match of text.matchAll(DECL_REGEX)) {
      const name = match[1];
      const hasTypeAnnotation = !!(match[2] && match[2].length > 0);
      const initialPath = hasTypeAnnotation ? [] : [name];
      // The trailing `{` is the last char of the match. Its index
      // sits at (match.index + match[0].length - 1).
      const openBrace = (match.index ?? 0) + match[0].length - 1;
      const leaves = parseAt(text, openBrace, initialPath);
      for (const leaf of leaves) {
        out.push({
          path: leaf.path,
          value: leaf.value,
          offset: leaf.offset,
        });
      }
    }
    return out;
  },
};

registerParser("RUNTIME", RuntimeObjectParser);
