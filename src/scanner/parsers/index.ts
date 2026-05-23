// Side-effect barrel for the JS/TS parser pipeline. Importing this
// module is enough to register every concrete parser into the
// dispatcher — each parser file calls `registerParser()` /
// `registerHelperParser()` at module load time, so the order here
// matters only for predictability (last-registered wins per mode).
//
// New parsers added in later phases just need to:
//   1. self-register at the bottom of their file,
//   2. get listed here so the scanner picks them up.
//
// Phase 2 ships the Style-Dictionary parser. Phase 4 appends the
// runtime parser. Phase 5 adds the helper-function parser.

import "./styleDictionaryParser";
import "./runtimeObjectParser";
import "./runtimeFunctionParser";
