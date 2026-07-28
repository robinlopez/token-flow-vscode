// Port of the placeholder guard added to `inspection/LiteralFinder.kt`
// (IntelliJ 0.2.4). Answers one question about a `'{…}'` match: *where*
// is this string?
//
// The Style-Dictionary / PrimeVue alias syntax (`'{color.primary}'`)
// collides head-on with the most common message-placeholder convention
// in application code:
//
//   currentPageReportTemplate = input<string>('{first} - {last} sur {totalRecords}');
//   …
//   template.replace('{first}', String(state.first))
//
// A `'{…}'` string handed to `replace` / `split` / `t` / `instant` /
// `format` … is a runtime placeholder, never a token path. Such matches
// must be dropped entirely — neither counted as a reference nor reported
// as broken — otherwise a single paginator inflates both the broken-ref
// list and the coverage ratio.
//
// This guard applies to the `'{…}'` syntax ONLY. `var(--x)`, `$x` and
// `dt('a.b')` are unambiguous and are never routed through it.

/** Max chars walked back when looking for the enclosing call. */
const CALLEE_LOOKBACK = 400;

/**
 * Callees whose string arguments are message templates / regex patterns,
 * never token paths. Compared on the trailing identifier, lowercased, so
 * `String.prototype.replace`, `this.translate.instant` and
 * `TranslateService.transform` are all covered.
 */
const PLACEHOLDER_CALLEES = new Set([
  "replace",
  "replaceall",
  "split",
  "join",
  "match",
  "matchall",
  "search",
  "test",
  "exec",
  "includes",
  "indexof",
  "lastindexof",
  "startswith",
  "endswith",
  "regexp",
  "t",
  "$t",
  "translate",
  "instant",
  "transform",
  "format",
  "formatmessage",
  "sprintf",
  "interpolate",
  "i18n",
]);

function isCalleeNameChar(c: string): boolean {
  return /[A-Za-z0-9_$.]/.test(c);
}

/**
 * Name of the function whose argument list encloses [offset], or null
 * when [offset] isn't inside a call. Walks backwards to the nearest
 * unmatched `(` — skipping nested calls, skipping quoted arguments so
 * `.replace('(', '')` doesn't unbalance the walk, and stopping at a
 * statement boundary.
 *
 * The `{` case in that boundary set is what keeps an object literal
 * safe: `primary: '{color.primary}'` hits the block's opening brace
 * before any `(` and is therefore never mistaken for a call argument.
 */
export function enclosingCallee(text: string, offset: number): string | null {
  let depth = 0;
  const floor = Math.max(0, offset - CALLEE_LOOKBACK);
  for (let i = offset - 1; i >= floor; i--) {
    const c = text[i];
    if (c === ")") {
      depth++;
      continue;
    }
    if (c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      let nameEnd = i;
      while (nameEnd > 0 && /\s/.test(text[nameEnd - 1])) nameEnd--;
      let nameStart = nameEnd;
      while (nameStart > 0 && isCalleeNameChar(text[nameStart - 1])) nameStart--;
      return nameStart === nameEnd ? null : text.slice(nameStart, nameEnd);
    }
    if (c === ";" || c === "{" || c === "}") return null;
    if (c === "'" || c === '"' || c === "`") {
      // Jump over the whole quoted argument — its content may contain
      // unbalanced parens/braces that would derail the walk.
      i--;
      while (i >= floor && text[i] !== c) i--;
    }
  }
  return null;
}

/**
 * True when the `'{…}'` literal starting at [offset] is an argument of a
 * string-helper / i18n call, i.e. a runtime placeholder rather than a
 * token alias.
 */
export function isPlaceholderCallArgument(
  text: string,
  offset: number,
): boolean {
  const callee = enclosingCallee(text, offset);
  if (!callee) return false;
  const trailing = callee.slice(callee.lastIndexOf(".") + 1).toLowerCase();
  return PLACEHOLDER_CALLEES.has(trailing);
}
