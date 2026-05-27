// MVP completion. Suggests tokens after `var(--` (any CSS-flavoured file)
// and after `$` (SCSS/SASS). The sort order now uses the multi-criteria
// semantic scorer from `model/semantics.ts` so that contextual tokens
// (Semantic tier, correct role) surface before primitives and role conflicts.
//
// The CSS property is extracted from the current line prefix so that, for
// example, `background: var(--` ranks SURFACE tokens above CONTENT tokens.
//
// Trigger characters are declared in `extension.ts` when this provider is
// registered (one registration per language so the trigger set can differ
// — `$` should not auto-trigger in plain CSS).

import * as vscode from "vscode";
import { DesignToken } from "../model/designToken";
import { TokenScanner } from "../scanner/tokenScanner";
import { ActiveScopeTracker } from "../services/activeScopeTracker";
import {
  getExpectedRoleForProperty,
  scoreCandidate,
  scoreToSortText,
  ScoreContext,
} from "../model/semantics";

export class TokenCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly scanner: TokenScanner,
    private readonly scopes: ActiveScopeTracker,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | null> {
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    const trigger = detectTrigger(linePrefix, document.languageId);
    if (!trigger) return null;

    // Extract the CSS property name from the current line (e.g. `background`)
    // so we can weight token roles accordingly.
    const cssProperty = extractPropertyFromLine(linePrefix);
    const expectedRole = cssProperty
      ? getExpectedRoleForProperty(cssProperty)
      : null;

    const tokens = await this.scanner.scan();
    const active = this.scopes.activeNames();

    return tokens
      .filter((t) => active.has(t.scope) && matchesTrigger(t, trigger))
      .map((t) => buildItem(t, trigger, { expectedRole }));
  }
}

// ─── Trigger detection ────────────────────────────────────────────────────

type TriggerKind = "CSS_VAR" | "SCSS_VAR";

interface Trigger {
  readonly kind: TriggerKind;
  /** What the user has already typed after the trigger char(s). */
  readonly prefix: string;
}

const SCSS_LIKE = new Set(["scss", "sass"]);

function detectTrigger(linePrefix: string, languageId: string): Trigger | null {
  // `var(--foo` — last unclosed `var(` on the line, then capture the bit
  // after `--`. We don't require `--` to be already typed so the very
  // first completion popup right after `var(` works.
  const cssMatch = linePrefix.match(/var\(\s*(--[A-Za-z0-9_-]*)?$/);
  if (cssMatch) {
    return { kind: "CSS_VAR", prefix: (cssMatch[1] ?? "").replace(/^--/, "") };
  }
  // `$prefix` — only in SCSS/SASS, and only when `$` is the start of an
  // identifier (not a value reference inside an interpolation, but the
  // string-prefix check is good enough at this scope).
  if (SCSS_LIKE.has(languageId)) {
    const scssMatch = linePrefix.match(/(^|[\s,:(){]|\W)\$([A-Za-z0-9_-]*)$/);
    if (scssMatch) return { kind: "SCSS_VAR", prefix: scssMatch[2] };
  }
  return null;
}

/**
 * Extract the CSS property name from the current line prefix.
 * Looks for `<property-name>:` before `var(`. Returns `null` when the
 * property cannot be determined (e.g. complex shorthands).
 */
function extractPropertyFromLine(linePrefix: string): string | null {
  // Match `  background-color: var(--` or `  color: var(--`
  const m = linePrefix.match(/([a-zA-Z][a-zA-Z0-9-]*)\s*:(?:[^;{]*)$/);
  if (!m) return null;
  const prop = m[1].toLowerCase();
  // Reject pseudo-matches like `--my-var: var(--` (CSS custom property decl)
  if (prop.startsWith("--")) return null;
  return prop;
}

function matchesTrigger(token: DesignToken, trigger: Trigger): boolean {
  if (trigger.kind === "CSS_VAR") {
    return token.kind === "CSS_CUSTOM_PROPERTY";
  }
  return token.kind === "SCSS_VARIABLE";
}

// ─── Item building ────────────────────────────────────────────────────────

function buildItem(
  token: DesignToken,
  trigger: Trigger,
  ctx: ScoreContext,
): vscode.CompletionItem {
  const bareName =
    trigger.kind === "CSS_VAR"
      ? token.name.replace(/^--/, "")
      : token.name.replace(/^\$/, "");

  const item = new vscode.CompletionItem(bareName, completionKindFor(token));
  item.detail = token.resolvedValue;
  item.documentation = new vscode.MarkdownString(
    `\`${token.category.toLowerCase()}\` · \`${token.resolvedValue}\``,
  );
  item.insertText = bareName;

  // Use the semantic score as sortText so contextually relevant tokens
  // surface first. scoreToSortText converts the signed score to a
  // zero-padded 4-char string that VSCode can sort lexicographically.
  const score = scoreCandidate(token, ctx);
  item.sortText = scoreToSortText(score);

  return item;
}

function completionKindFor(token: DesignToken): vscode.CompletionItemKind {
  if (token.category === "COLOR") return vscode.CompletionItemKind.Color;
  if (token.category === "TYPOGRAPHY") return vscode.CompletionItemKind.Text;
  return vscode.CompletionItemKind.Variable;
}
