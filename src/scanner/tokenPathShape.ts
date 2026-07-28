// Port of `analyze/TokenPathShape.kt` (IntelliJ 0.2.4). Answers the
// second question about a `'{…}'` match: does this name belong to the
// project's *token vocabulary* at all?
//
// The guard in `placeholderGuard.ts` catches placeholders passed to a
// string helper. This one catches the rest — a `'{…}'` sitting in an
// object literal, a decorator, a template binding — by comparing the
// name against the shape of the token names the scan actually indexed.
//
// Verdict for a brace-string reference (`'{…}'`, `"{…}"`, `` `{…}` ``),
// first match wins:
//
//   1. the project declares NO JS-path token at all (no dotted name, no
//      bare dot-less name — only `--x` / `$x`)   → ❌ not a reference
//   2. the name resolves exactly                 → ✅ reference
//   3. its root segment is a known namespace
//      (`{color.primry}` → `color`)              → ✅ reference, and the
//                                                    typo is still
//                                                    reported as broken
//   4. its root segment is ≤ 1 edit from a known
//      namespace (`{colr.primary}`)              → ✅ reference
//   5. single-segment name AND the project has
//      flat JS names (`brand`, `ink`)            → ✅ reference
//                                                    (historic behaviour)
//   6. otherwise (`{first}`, `{totalRecords}`,
//      `{user.name}`)                            → ❌ not a reference
//
// Every other syntax (`var(--x)`, `$x`, `dt('a.b')`) is unambiguous and
// always returns ✅.
//
// Instantiate ONCE per scan (`TokenPathShape.of(tokenNames)`) — the two
// pre-computed sets make each verdict O(1) apart from the bounded
// edit-distance sweep in rule 4.

export class TokenPathShape {
  private constructor(
    private readonly tokenNames: ReadonlySet<string>,
    /** First segment of every dotted JS-path token name (`color.primary` → `color`). */
    private readonly pathRoots: ReadonlySet<string>,
    /** True when at least one JS token name is a bare, dot-less identifier. */
    private readonly hasFlatPathTokens: boolean,
  ) {}

  static of(tokenNames: ReadonlySet<string>): TokenPathShape {
    const roots = new Set<string>();
    let flat = false;
    for (const name of tokenNames) {
      // CSS custom properties (`--x`) and SCSS variables (`$x`) live in
      // their own syntaxes and never appear as `'{…}'`.
      if (name.startsWith("--") || name.startsWith("$")) continue;
      const dot = name.indexOf(".");
      if (dot > 0) roots.add(name.slice(0, dot));
      else flat = true;
    }
    return new TokenPathShape(tokenNames, roots, flat);
  }

  /** `'{…}'`, `"{…}"`, `` `{…}` `` — the Style-Dictionary alias syntax. */
  static isBraceStringReference(text: string): boolean {
    return (
      text.length >= 4 &&
      (text[0] === "'" || text[0] === '"' || text[0] === "`") &&
      text[1] === "{"
    );
  }

  /**
   * @param refText raw reference text as matched in the file
   * @param name    token name already extracted from [refText]
   */
  isPlausibleReference(refText: string, name: string): boolean {
    if (!TokenPathShape.isBraceStringReference(refText)) return true;
    if (this.pathRoots.size === 0 && !this.hasFlatPathTokens) return false;
    if (this.tokenNames.has(name)) return true;
    const dot = name.indexOf(".");
    const root = dot > 0 ? name.slice(0, dot) : name;
    if (this.pathRoots.has(root)) return true;
    for (const r of this.pathRoots) if (isOneEditApart(root, r)) return true;
    return this.hasFlatPathTokens && !name.includes(".");
  }
}

/**
 * Bounded edit distance (≤ 1). Skipped for short roots, where a
 * single-character difference carries no signal (`ink` vs `int` would
 * match anything).
 */
export function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) i++;
    j++;
  }
  return true;
}
