// Direct port of `DeclarationContext.kt` — walks the source backwards from a
// token offset and returns the chain of enclosing blocks (CSS rule selectors
// + SCSS map keys), so a token nested under
// `$themes: ( "themeOne": ( "light": ( --x: red ) ) )` reports
// `themeOne light` as its declaration context.
//
// Two block flavours are tracked:
//   - CSS rule blocks delimited by `{}` (selectors, `@media`, …)
//   - SCSS map literals delimited by `()` with a `"key":` (or bare `key:`) label.
//
// Plain function calls like `rgb(…)` are skipped because the `(` isn't preceded
// by a `key:` pattern.

export function describeAt(text: string, offset: number): string {
  const chain: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let i = offset - 1;

  while (i >= 0) {
    const c = text[i];
    if (c === "}") braceDepth++;
    else if (c === ")") parenDepth++;
    else if (c === "{") {
      if (braceDepth === 0) {
        const selector = extractLabelBefore(text, i);
        if (selector.length > 0) chain.unshift(selector);
      } else braceDepth--;
    } else if (c === "(") {
      if (parenDepth === 0) {
        const mapKey = extractMapKeyBefore(text, i);
        if (mapKey !== null) chain.unshift(mapKey);
      } else parenDepth--;
    }
    i--;
  }
  return chain.join(" ");
}

/** Selector text immediately preceding a `{`, stopping at the previous statement boundary. */
function extractLabelBefore(text: string, braceIndex: number): string {
  let end = braceIndex - 1;
  while (end >= 0 && /\s/.test(text[end])) end--;
  if (end < 0) return "";
  let start = end;
  while (start > 0) {
    const c = text[start - 1];
    if (c === "}" || c === ";" || c === "{") break;
    start--;
  }
  return text
    .substring(start, end + 1)
    .trim()
    .replace(/\s+/g, " ")
    .substring(0, 120);
}

/**
 * Returns the bare key of a `"key": (` or `key: (` map entry, or `null`
 * when the `(` is just a function call. Quotes are stripped.
 */
function extractMapKeyBefore(text: string, parenIndex: number): string | null {
  let i = parenIndex - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0 || text[i] !== ":") return null;
  i--;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  const end = i;
  // Quoted key — accept `"…"` or `'…'`.
  if (text[end] === '"' || text[end] === "'") {
    const quote = text[end];
    let start = end - 1;
    while (start >= 0 && text[start] !== quote) start--;
    if (start < 0) return null;
    return text.substring(start + 1, end);
  }
  // Bare identifier — `themeName: (`.
  if (!isIdentChar(text[end])) return null;
  let start = end;
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  return text.substring(start, end + 1);
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}
