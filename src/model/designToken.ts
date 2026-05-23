// Mirror of the IntelliJ-side `DesignToken` model (kept aligned with
// `model/DesignToken.kt` from the IntelliJ plugin v0.1.2). Any field added
// here must be reflected in SHARED_LOGIC.md so the two implementations stay
// in lockstep.

export type TokenKind =
  // CSS / SCSS native declarations.
  | "SCSS_VARIABLE" //         $name (SCSS files)
  | "CSS_CUSTOM_PROPERTY" //   --name (CSS / SCSS source / SCSS map keys)
  // JS/TS preset paths — Style-Dictionary / PrimeUIX, referenced as
  // `'{global.modeLight.surface.default}'` or `dt('…')`.
  | "JS_OBJECT_PATH"
  // React-Native-style runtime themes: typed `const` object accessed by
  // property at runtime (`colors.PRIMARY_500`, `nomTheme.radius.sm`). The
  // name IS the JS expression; no alias indirection, no string wrapping.
  | "JS_RUNTIME_PROPERTY"
  // Callable runtime helpers (`spacing(scale)`, `normalize(size, ref)`).
  // Library entries store the bare helper identifier; suggestion outputs
  // are fully applied call expressions (`spacing(1.5)`).
  | "JS_RUNTIME_FUNCTION";

export type TokenCategory =
  | "COLOR"
  | "SPACING"
  | "TYPOGRAPHY"
  | "SHADOW"
  | "RADIUS"
  | "DURATION"
  | "Z_INDEX"
  // Added at parity with IntelliJ — names match TokenCategory.kt verbatim.
  | "EFFECTS"
  | "LAYOUT"
  | "SIZING"
  | "BORDER"
  | "OPACITY"
  | "ICON"
  | "OTHER";

export interface TokenVariant {
  /** Human-readable context, e.g. `@media (min-width: 1024px)`, `themeOne dark`. */
  readonly condition: string;
  readonly value: string;
}

export interface DesignToken {
  readonly name: string;
  readonly rawValue: string;
  readonly resolvedValue: string;
  readonly category: TokenCategory;
  readonly kind: TokenKind;
  readonly filePath: string;
  readonly offset: number;
  /**
   * Additional declarations of the same token name found in different
   * contexts (other `@media`, theme classes, …). Primary value lives on
   * [resolvedValue]; everything else surfaces here.
   */
  readonly variants: readonly TokenVariant[];
  /**
   * Override for the primary's "default" column header. Carries the
   * declaration context of the primary occurrence so that a token defined
   * under `$themes-config -> "themeOne" -> "light"` surfaces
   * `themeOne light` on its primary column instead of `default`.
   */
  readonly primaryConditionLabel: string | null;
  /**
   * Name of the scope this token was indexed under. Defaults to
   * `"common"` when no named scopes are configured (back-compat path).
   * Consumers filter by `scope === activeScope.name || scope === "common"`
   * so the user only sees tokens that apply to the file they're editing.
   */
  readonly scope: string;
  /**
   * Set when the token originates from a `whitelistPaths` entry —
   * i.e. an external library file the user merely catalogues for hover
   * + completion convenience. External tokens:
   *   • appear in Library, Hover and Completion (the user might want
   *     to use them),
   *   • are NOT proposed as replacement candidates for hardcoded
   *     literals (we shouldn't suggest an external lib's variable to
   *     replace project code),
   *   • are NOT counted in Analyse project-health metrics (they're
   *     not "ours" to fix).
   */
  readonly external: boolean;
  /**
   * For `JS_RUNTIME_FUNCTION` callable helpers: the numeric unit in the
   * linear formula `unit × value` (a `12px` literal yields `spacing(1.5)`
   * when an indexed helper has `functionUnit = 8`). `null` for anything
   * that isn't a linear single-argument helper. Mirrors `DesignToken.kt`'s
   * `functionUnit` field — currently unused in the VSCode MVP but reserved
   * so the wire format stays compatible once helpers are ported.
   */
  readonly functionUnit: number | null;
}

/**
 * Centralised mapping from a [DesignToken] to the source-code expression
 * that references it. Mirrors `TokenReference.expression` in `DesignToken.kt`
 * — keep both call-site lists in sync when a new [TokenKind] is added.
 */
export function tokenExpression(token: Pick<DesignToken, "name" | "kind">): string {
  switch (token.kind) {
    case "SCSS_VARIABLE":
      return token.name; //                already prefixed with `$`
    case "CSS_CUSTOM_PROPERTY":
      return `var(${token.name})`; //      wraps `--name`
    case "JS_OBJECT_PATH":
      return `'{${token.name}}'`; //       Style-Dictionary alias
    case "JS_RUNTIME_PROPERTY":
      return token.name; //                bare property access
    case "JS_RUNTIME_FUNCTION":
      return token.name; //                helper or fully-applied call
  }
}
