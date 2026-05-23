// Regex constants — direct port from the IntelliJ Kotlin scanner.
// IMPORTANT: any edit here must mirror the matching constant in
// `TokenScanner.kt` so both plugins extract the same set of tokens.
// See SHARED_LOGIC.md for the canonical reference.

/** `$name: value;` at the start of a line (SCSS variables). */
export const SCSS_VAR_REGEX =
  /^\s*\$([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;\n]+)\s*;?/gm;

/** `--name: value` anywhere (CSS custom properties). */
export const CSS_VAR_REGEX =
  /--([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;}\n]+)\s*;?/g;

/**
 * `"<token-name>": value,` SCSS map keys. The trailing comma keeps the
 * pattern specific enough to skip the surrounding map header lines like
 * `"themeOne": (` — those would not have a comma directly after the value.
 */
export const SCSS_MAP_KEY_REGEX =
  /"([a-z][a-z0-9_-]*)"\s*:\s*([^,\n}]+),/g;

/** Aliases that resolve to another declaration. */
export const SCSS_ALIAS_REGEX = /^\$([A-Za-z_][A-Za-z0-9_-]*)$/;
export const CSS_VAR_CALL_REGEX = /^var\(\s*--([A-Za-z_][A-Za-z0-9_-]*)\s*\)$/;
/** Style-Dictionary-style alias: `{a.b.c}` referring to another token path. */
export const JS_OBJECT_ALIAS_REGEX = /^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/;

/**
 * Bare runtime property-access alias — `colors.PRIMARY_500`.
 * At least one dot is required so plain identifiers aren't treated
 * as aliases. Surfaces in React-Native themes where one typed object
 * (`nomTheme`) reuses values from a primitive bag (`colors`).
 */
export const JS_RUNTIME_ALIAS_REGEX =
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$0-9][\w$]*)+$/;
