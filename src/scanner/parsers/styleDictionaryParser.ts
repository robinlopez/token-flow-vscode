// Port of `StyleDictionaryParser.kt`.
//
// Parses TS/JS files written in the Style-Dictionary / PrimeUIX preset
// style:
//   `export const tokens = { … }`  or  `export default { … }`
//
// Leaves are emitted WITHOUT the exported binding name as a prefix
// because references in code use only the inner path:
//   `'{primitive.neutral.500}'`  or  `dt('primitive.neutral.500')`
//
// Type-annotated exports (`export const x: SomeType = { … }`) and bare
// `const x = { … }` declarations are intentionally NOT handled here —
// those shapes belong to `RuntimeObjectParser` (Phase 4).
//
// Self-registers under the STYLE_DICTIONARY mode at module load. The
// scanner imports this file from `parsers/index.ts` so the dispatcher
// picks up the real parser instead of the Phase-1 no-op.

import { JsTokenFileParser, ParsedLeaf } from "./jsTokenFileParser";
import { parse as walkObjects } from "./jsObjectWalker";
import { registerParser } from "./jsTokenFileParserRegistry";

export const StyleDictionaryParser: JsTokenFileParser = {
  kind: "JS_OBJECT_PATH",
  parse(text: string): readonly ParsedLeaf[] {
    return walkObjects(text);
  },
};

registerParser("STYLE_DICTIONARY", StyleDictionaryParser);
