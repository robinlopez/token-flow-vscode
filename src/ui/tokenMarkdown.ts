// Shared markdown renderer for a `DesignToken`. Used by:
//   - the HoverProvider (popup at the caret),
//   - the LibraryTreeProvider (tooltip on tree items).
//
// Mirrors the IntelliJ `VariantTableHtml.buildBody` output as closely as
// markdown allows — see SHARED_LOGIC.md §6 (`parseCondition`) for the
// header-cell logic. The two-row header (theme spanning its modes) is
// emulated by inlining the theme name into the column header ("themeOne ·
// light") because markdown tables don't support colspan.

import { DesignToken } from "../model/designToken";

export function buildTokenMarkdown(token: DesignToken): string {
  const lines: string[] = [];
  lines.push(`**\`${token.name}\`** · _${token.category.toLowerCase()}_`);
  lines.push("");
  if (token.rawValue !== token.resolvedValue) {
    lines.push(`\`${token.rawValue}\` → \`${token.resolvedValue}\``);
  } else {
    lines.push(`\`${token.resolvedValue}\``);
  }
  lines.push("");

  const cols = collectColumns(token);
  const themes = [...new Set(cols.map((c) => c.theme).filter((t) => t))];
  if (themes.length >= 2) {
    lines.push(...renderTable(cols, /* grouped */ true));
  } else if (cols.length > 1) {
    lines.push(...renderTable(cols, /* grouped */ false));
  }
  return lines.join("\n");
}

// ─── Column model ────────────────────────────────────────────────────────

export interface Col {
  readonly theme: string | null;
  readonly sub: string;
  readonly value: string;
}

/**
 * Builds the column model for a token — exported so both the hover
 * provider (markdown rendering) and the Library webview (HTML popover
 * + pre-computed `WireVariantColumn[]`) read from the same source of
 * truth. Order matches the IntelliJ side: primary first, then variants
 * in declaration order.
 */
export function collectColumns(token: DesignToken): Col[] {
  const cols: Col[] = [];
  const primary = parseCondition(token.primaryConditionLabel ?? "");
  cols.push({ theme: primary.theme, sub: primary.sub, value: token.resolvedValue });
  for (const v of token.variants) {
    const p = parseCondition(v.condition);
    cols.push({ theme: p.theme, sub: p.sub, value: v.value });
  }
  return cols;
}

/** Direct port of `VariantTableHtml.parseCondition` — see SHARED_LOGIC.md §6.
 *  Rewritten to be robust against CSS comments, garbage strings, SCSS maps,
 *  media queries (min/max-width), class selectors, data-attributes, etc.
 */
export function parseCondition(condition: string): {
  theme: string | null;
  sub: string;
} {
  // ── Strip CSS/SCSS comments before any analysis ───────────────────────
  const stripped = condition
    .replace(/\/\*[\s\S]*?\*\//g, "")   // /* block comment */
    .replace(/\/\/[^\n]*/g, "")          // // line comment
    .trim();

  if (!stripped || stripped.toLowerCase() === "(top level)") {
    return { theme: null, sub: "default" };
  }

  // ── Media queries: min-width → "≥Npx" ────────────────────────────────
  const minW = /min-width\s*:\s*(\d+(?:\.\d+)?)\s*(px|rem|em)/i.exec(stripped);
  if (minW) return { theme: null, sub: `\u2265${minW[1]}${minW[2]}` };

  // ── Media queries: max-width → "<Npx" ────────────────────────────────
  const maxW = /max-width\s*:\s*(\d+(?:\.\d+)?)\s*(px|rem|em)/i.exec(stripped);
  if (maxW) return { theme: null, sub: `<${maxW[1]}${maxW[2]}` };

  // ── Named viewport breakpoints ────────────────────────────────────────
  const vp = /\b(mobile|tablet|desktop|sm|md|lg|xl|xxl|2xl)\b/i.exec(stripped);
  if (vp && !/[{};*]/.test(stripped)) {
    return { theme: null, sub: vp[1].toLowerCase() };
  }

  const isMode = (w: string) => /^(light|dark|auto)$/i.test(w);

  // ── Simple word-only condition (SCSS map key, class name without dots) ─
  if (/^[\w\- ]+$/.test(stripped)) {
    const parts = stripped.split(/[\s\-_]+/).filter((p) => p.length > 0 && /^[a-zA-Z0-9]+$/.test(p));
    const modeWord = parts.find(isMode);
    const themeWord = parts.find(
      (p) => !isMode(p) && p.toLowerCase() !== "default" && p.length > 1,
    );
    if (themeWord && modeWord) return { theme: themeWord, sub: modeWord.toLowerCase() };
    if (modeWord) return { theme: null, sub: modeWord.toLowerCase() };
    if (themeWord) return { theme: themeWord, sub: "default" };
    // If all parts are "default" or single char, return "default"
    const last = parts[parts.length - 1];
    if (last && last.length > 1) return { theme: null, sub: last.substring(0, 24) };
    return { theme: null, sub: "default" };
  }

  // ── Light / dark patterns anywhere in the string ─────────────────────
  const dl = /(?:^|[^A-Za-z0-9_-])(dark(?:[\w-]*)?|light(?:[\w-]*)?)(?:[^A-Za-z0-9_-]|$)/i.exec(stripped);
  if (dl) return { theme: null, sub: dl[1].toLowerCase() };

  // ── CSS class selectors (".theme-dark", ".dark-mode") ────────────────
  const classMatch = /\.([a-zA-Z][a-zA-Z0-9\-_]{2,})/g;
  let m;
  while ((m = classMatch.exec(stripped)) !== null) {
    const name = m[1];
    if (isMode(name)) return { theme: null, sub: name.toLowerCase() };
    if (/dark|light|mode|theme/i.test(name)) return { theme: null, sub: name.substring(0, 24) };
  }

  // ── data-theme / data-mode attributes ────────────────────────────────
  const attrMatch = /\[data-(?:theme|mode|color-scheme)[=*~|^$]?['"]?([a-zA-Z][a-zA-Z0-9\-_]*)/i.exec(stripped);
  if (attrMatch) {
    const val = attrMatch[1];
    if (isMode(val)) return { theme: null, sub: val.toLowerCase() };
    return { theme: val, sub: "default" };
  }

  // ── Fallback: aggressive clean — never expose comments or garbage ─────
  const cleaned = stripped
    .replace(/:root\b/g, "")
    .replace(/@media\s*/g, "")
    .replace(/[^a-zA-Z0-9\-_\u2265<>.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 2) return { theme: null, sub: "default" };
  return { theme: null, sub: cleaned.substring(0, 24).trimEnd() };
}

// ─── Rendering ───────────────────────────────────────────────────────────

function renderTable(cols: Col[], grouped: boolean): string[] {
  const headers = cols.map((c) =>
    grouped && c.theme ? `${c.theme} · ${c.sub}` : c.sub,
  );
  const values = cols.map((c) => "`" + c.value + "`");
  return [
    "| " + headers.join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    "| " + values.join(" | ") + " |",
  ];
}
