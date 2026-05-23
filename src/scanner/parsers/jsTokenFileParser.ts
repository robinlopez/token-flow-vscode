// Port of `parsers/JsTokenFileParser.kt`. Shared shape used by every
// JS/TS token-file parser (Style-Dictionary, runtime themes, etc.).
//
// A "leaf" is a single `path → value` produced by walking an object —
// it carries no kind here; the registry stamps the right `TokenKind`
// when it routes the parsed file. Offsets are absolute against the
// passed-in source so the scanner can keep declaration-context lookups
// consistent across CSS/SCSS and JS/TS files.

import { TokenKind } from "../../model/designToken";

export interface ParsedLeaf {
  /**
   * Dot-joined sequence of object keys.
   *
   * Includes the binding name for runtime parsers (`colors.PRIMARY_500`),
   * excludes it for Style-Dictionary parsers (`global.mode.light.surface.default`).
   * The registry knows which flavour applies; consumers downstream just
   * read this verbatim.
   */
  readonly path: string;
  /** Verbatim leaf value, quotes stripped. */
  readonly value: string;
  /** Absolute offset of the value (or its opening quote) inside the source. */
  readonly offset: number;
}

export interface JsTokenFileParser {
  /** The `TokenKind` every leaf returned by `parse` will carry. */
  readonly kind: TokenKind;

  /** Extracts the leaves declared in `text`. Offsets refer to `text` verbatim. */
  parse(text: string): readonly ParsedLeaf[];
}
