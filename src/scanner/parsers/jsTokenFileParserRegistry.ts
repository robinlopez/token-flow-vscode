// Port of `parsers/JsTokenFileParserRegistry.kt`.
//
// Dispatches a TS/JS file to the right parser. Per-file detection
// (instead of running every parser unconditionally) keeps the index
// clean — no duplicated leaves under different kinds for the same
// physical declaration — and produces suggestions whose replacement
// syntax matches the surrounding source style.
//
// Phase 1: the dispatcher is wired but every parser slot is a no-op.
// Phase 2 will fill `StyleDictionaryParser`; Phase 4 `RuntimeObjectParser`;
// Phase 5 `RuntimeFunctionParser`. The registry's contract is stable so
// downstream code (tokenScanner) won't need to move once the parsers
// arrive.

import { JsTokenFileParser, ParsedLeaf } from "./jsTokenFileParser";

export type ParserMode = "STYLE_DICTIONARY" | "RUNTIME";

/** Alias literal as it appears in Style-Dictionary presets: `'{a.b.c}'`. */
const STYLE_DICT_ALIAS = /["'`]\{[A-Za-z][\w.\-]*\}["'`]/;

/**
 * Hints that strongly imply a runtime / object-access theme file.
 * Kept verbatim from the Kotlin version so file-mode detection stays
 * in lockstep across the two implementations.
 */
const RUNTIME_HINTS =
  /from\s+["'`]react-native["'`/]|StyleSheet\.create\s*\(|(?:^|\n)\s*export\s+const\s+\w+\s*:\s*\w+(?:<[^>]*>)?\s*=/;

/**
 * Picks a mode for `text`. Order matters:
 *  1. Presence of `{path.like.this}` alias literals is a near-certain
 *     marker of a Style-Dictionary preset.
 *  2. Otherwise, runtime hints (RN import, typed export, StyleSheet) win.
 *  3. Fallback to Style-Dictionary to preserve historic behaviour for
 *     files that match neither (e.g. plain primitive presets).
 */
export function detectMode(text: string): ParserMode {
  if (STYLE_DICT_ALIAS.test(text)) return "STYLE_DICTIONARY";
  if (RUNTIME_HINTS.test(text)) return "RUNTIME";
  return "STYLE_DICTIONARY";
}

// ─── Parser slots (Phase-2/4/5 fill these in) ──────────────────────────
//
// Each slot is a `JsTokenFileParser` whose `parse()` returns an empty
// array until the corresponding parser ports. Keeping them in a single
// `parsers` map (vs. lazy imports) means a single place to swap in the
// real implementation later — no need to touch the dispatcher.

const NoopStyleDictionary: JsTokenFileParser = {
  kind: "JS_OBJECT_PATH",
  parse: () => [],
};

const NoopRuntime: JsTokenFileParser = {
  kind: "JS_RUNTIME_PROPERTY",
  parse: () => [],
};

const parsers: Record<ParserMode, JsTokenFileParser> = {
  STYLE_DICTIONARY: NoopStyleDictionary,
  RUNTIME: NoopRuntime,
};

/**
 * Swaps the parser registered for [mode]. Public so the Phase-2 +
 * Phase-4 modules can self-register their concrete implementations
 * (avoids a cyclic import between the registry and each parser file).
 */
export function registerParser(
  mode: ParserMode,
  parser: JsTokenFileParser,
): void {
  parsers[mode] = parser;
}

export function parserFor(mode: ParserMode): JsTokenFileParser {
  return parsers[mode];
}

/**
 * Convenience: detect + parse in one call.
 *
 * Fallback behaviour: if the detected mode produces zero leaves we
 * try the OTHER parser. This catches the common "primitive" pattern
 * where a file holds only `const primitive = { … }` (no `export`,
 * no runtime hint) — detectMode picks STYLE_DICTIONARY, the SD
 * parser ignores unexported blocks, but the RUNTIME parser walks
 * them happily. Without this retry the alias chain breaks at that
 * file: downstream tokens can't resolve `{primitive.primary.500}`
 * because primitive is silently unindexed.
 *
 * The returned `mode` reflects which parser ACTUALLY yielded the
 * leaves, so downstream code (e.g. the scanner's kind assignment)
 * sees the right TokenKind.
 *
 * JSON shortcut: when [filePath] points at a `.json` / `.jsonc`
 * file, the regex-based parsers don't apply (no `export const`
 * keyword anywhere). We walk the first top-level `{` directly as
 * one big Style-Dictionary object literal instead — preserves the
 * binding-less path convention (`primitive.neutral.50`, not
 * `tokens.primitive.neutral.50`).
 */
export function parseJsTokenFile(
  text: string,
  filePath?: string,
): {
  readonly mode: ParserMode;
  readonly leaves: readonly ParsedLeaf[];
} {
  if (filePath && /\.jsonc?$/i.test(filePath)) {
    return { mode: "STYLE_DICTIONARY", leaves: parseJsonAsObject(text) };
  }
  const primary = detectMode(text);
  const primaryLeaves = parserFor(primary).parse(text);
  if (primaryLeaves.length > 0) {
    return { mode: primary, leaves: primaryLeaves };
  }
  const other: ParserMode =
    primary === "STYLE_DICTIONARY" ? "RUNTIME" : "STYLE_DICTIONARY";
  const otherLeaves = parserFor(other).parse(text);
  if (otherLeaves.length > 0) {
    return { mode: other, leaves: otherLeaves };
  }
  return { mode: primary, leaves: primaryLeaves };
}

/**
 * Walks the first top-level object literal in a JSON document. We
 * route through `parseAt` (the same walker that powers JS object
 * traversal) so the leaf shape and offset semantics stay identical
 * across .ts / .js / .json. The walker already tolerates the JSON
 * subset (string keys, no trailing commas needed, no comments in
 * strict JSON — but our `.jsonc` callers may emit `//` comments
 * which the walker also handles).
 */
function parseJsonAsObject(text: string): readonly ParsedLeaf[] {
  // Lazy import to avoid a cycle: jsObjectWalker imports nothing
  // from the registry, but this file should not import it at the
  // module level either since registerParser() side-effects would
  // already have run.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseAt } = require("./jsObjectWalker") as typeof import("./jsObjectWalker");
  const open = text.indexOf("{");
  if (open < 0) return [];
  const leaves = parseAt(text, open, []);
  return leaves.map((l) => ({ path: l.path, value: l.value, offset: l.offset }));
}

// ─── Helper functions (Phase-5 slot) ───────────────────────────────────
//
// Callable helpers (`const spacing = (v) => 8 * v`) only matter for
// runtime-mode files; Style-Dictionary presets don't expose them. We
// keep a separate slot so Phase 5 can land independently of the object
// parsers.

export interface ParsedHelper {
  /** Identifier (`spacing`, `normalize`). */
  readonly name: string;
  /** Name of the single parameter (`v`, `scale`). */
  readonly paramName: string;
  /** Optional TS annotation (`number`). Null when untyped. */
  readonly paramType: string | null;
  /** Numeric multiplier extracted from the helper's body. */
  readonly unit: number;
  /**
   * How the unit appeared in source (`8` or `spacingUnit`). Used by
   * display layers so a helper declared as `spacingUnit * v` shows
   * "spacingUnit × v" rather than the resolved `8 × v`.
   */
  readonly unitSource: string;
  /** Absolute offset of the helper declaration (the `const` keyword). */
  readonly offset: number;
}

export interface HelperParser {
  parse(text: string): readonly ParsedHelper[];
}

const NoopHelperParser: HelperParser = {
  parse: () => [],
};

let helperParser: HelperParser = NoopHelperParser;

export function registerHelperParser(parser: HelperParser): void {
  helperParser = parser;
}

export interface FileTokens {
  readonly mode: ParserMode;
  readonly leaves: readonly ParsedLeaf[];
  readonly helpers: readonly ParsedHelper[];
}

/**
 * Detect + parse, AND extract function helpers when the file is in
 * runtime mode. Style-Dictionary presets don't expose callable
 * helpers so we skip the helper pass entirely there to keep parsing
 * fast.
 *
 * Same fallback strategy as `parseJsTokenFile` — if the detected
 * mode produces zero leaves, try the other parser. Helper extraction
 * follows the EFFECTIVE mode (post-fallback), so a file detected as
 * SD that turned out to be a runtime token bag still gets its
 * `spacing(v) => 8 * v` helpers extracted.
 */
export function parseJsTokenFileFull(
  text: string,
  filePath?: string,
): FileTokens {
  const detected = parseJsTokenFile(text, filePath);
  const helpers =
    detected.mode === "RUNTIME" ? helperParser.parse(text) : [];
  return { mode: detected.mode, leaves: detected.leaves, helpers };
}

// ─── File-type gate ────────────────────────────────────────────────────

/**
 * True when the file path is a candidate for the JS/TS pipeline.
 * Centralised so the file watcher, scanner ingestion path, and any
 * future analyse tooling agree on the extension list.
 */
export function isJsTokenFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(filePath);
}
