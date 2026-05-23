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

/** Direct port of `VariantTableHtml.parseCondition` — see SHARED_LOGIC.md §6. */
export function parseCondition(condition: string): {
  theme: string | null;
  sub: string;
} {
  const s = condition.trim();
  if (!s || s.toLowerCase() === "(top level)") {
    return { theme: null, sub: "default" };
  }

  const minW = /min-width\s*:\s*(\d+)\s*px/.exec(s);
  if (minW) return { theme: null, sub: `≥${minW[1]}` };
  const maxW = /max-width\s*:\s*(\d+)\s*px/.exec(s);
  if (maxW) {
    const n = parseInt(maxW[1], 10);
    if (!isNaN(n)) return { theme: null, sub: `<${n + 1}` };
  }

  if (/^[\w\- ]+$/.test(s)) {
    const parts = s.split(" ").filter((p) => p.length > 0);
    const isMode = (w: string) => {
      const l = w.toLowerCase();
      return l === "light" || l === "dark" || l === "auto";
    };
    const modeWord = parts.find(isMode);
    const themeWord = parts.find(
      (p) => !isMode(p) && p.toLowerCase() !== "default",
    );
    if (themeWord && modeWord) return { theme: themeWord, sub: modeWord.toLowerCase() };
    if (modeWord) return { theme: null, sub: modeWord.toLowerCase() };
    if (themeWord) return { theme: themeWord, sub: "default" };
    return { theme: null, sub: parts[parts.length - 1]?.substring(0, 24) ?? "default" };
  }

  const dl = /(?:^|[^A-Za-z0-9_-])(dark[\w-]*|light[\w-]*)(?:[^A-Za-z0-9_-]|$)/i.exec(s);
  if (dl) return { theme: null, sub: dl[1].toLowerCase() };

  const cleaned = s
    .replace(/:root/g, "")
    .replace(/@media\s*/g, "")
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .trim()
    .replace(/^[.:&\s]+/, "");
  return { theme: null, sub: (cleaned || "default").substring(0, 24) };
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
