// MVP completion. Suggests tokens after `var(--` (any CSS-flavoured file)
// and after `$` (SCSS/SASS). The IntelliJ side does smart-category boosting
// based on the surrounding CSS property — left out of v0.1.0 to keep this
// thin; the simple sort-by-name already feels right in practice.
//
// Trigger characters are declared in `extension.ts` when this provider is
// registered (one registration per language so the trigger set can differ
// — `$` should not auto-trigger in plain CSS).

import * as vscode from "vscode";
import { DesignToken } from "../model/designToken";
import { TokenScanner } from "../scanner/tokenScanner";
import { ActiveScopeTracker } from "../services/activeScopeTracker";

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

    const tokens = await this.scanner.scan();
    const active = this.scopes.activeNames();
    return tokens
      .filter((t) => active.has(t.scope) && matchesTrigger(t, trigger))
      .map((t) => buildItem(t, trigger));
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
): vscode.CompletionItem {
  // The item's insertion text drops the trigger prefix VSCode already typed
  // for us. For CSS_VAR the trigger is `var(--`; for SCSS the trigger is
  // `$`. The label is the bare token name so fuzzy filter behaves well.
  const bareName =
    trigger.kind === "CSS_VAR"
      ? token.name.replace(/^--/, "")
      : token.name.replace(/^\$/, "");
  const item = new vscode.CompletionItem(
    bareName,
    completionKindFor(token),
  );
  item.detail = token.resolvedValue;
  item.documentation = new vscode.MarkdownString(
    `\`${token.category.toLowerCase()}\` · \`${token.resolvedValue}\``,
  );
  item.insertText = bareName;
  // Sort tokens alphabetically — matches the IntelliJ v0.1.2 choice
  // (`CandidateSorter` removed, alphabetical by name).
  item.sortText = bareName;
  return item;
}

function completionKindFor(token: DesignToken): vscode.CompletionItemKind {
  if (token.category === "COLOR") return vscode.CompletionItemKind.Color;
  if (token.category === "TYPOGRAPHY") return vscode.CompletionItemKind.Text;
  return vscode.CompletionItemKind.Variable;
}
