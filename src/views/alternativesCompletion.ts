// Native-IntelliSense flavour of the Alt+T picker. Lives next to the
// webview variant in `alternativesPicker.ts` — pick one or the other via
// the `tokenFlow.alternatives.pickerStyle` setting.
//
// Why a completion provider at all?
//   • The VSCode API has no popup webview that floats over the editor
//     (issue microsoft/vscode#39959). The only built-in surface that
//     does float under the caret is the IntelliSense suggest widget,
//     so we piggy-back on it.
//   • `CompletionItemKind.Color` renders a real native swatch next to
//     the item label when `documentation` starts with a parsable color
//     literal — gives us free pastilles without the SVG-decoration dance.
//   • Sort + grouping is conveyed via `sortText` + `label.description`
//     (the right-aligned grey segment in the suggest widget). No real
//     dividers, but visually close enough.
//
// Lifecycle: a single CompletionItemProvider is registered for the life
// of the extension. It only returns items while `pending` is set — i.e.
// only during a live `openAlternativesAsCompletion` call. Selection of
// an item runs `tokenFlow._altCompletionAccepted` with the candidate
// index, which resolves the outstanding promise. Cancellation paths:
//   • User presses Esc → suggest closes silently, no event. We rely on
//     `onDidChangeTextEditorSelection` (cursor moved without an accept)
//     and `onDidChangeActiveTextEditor` (focus left the doc) as cancel
//     signals.
//   • The provider itself is queried; if no item is accepted within the
//     same tick, the widget just disappears. We never time out — the
//     pending state lives until either accept or one of the cancel
//     signals fires.

import * as vscode from "vscode";
import {
  DesignToken,
  TokenCategory,
  tokenExpression,
} from "../model/designToken";
import { parseColor, rgbaToCacheKey } from "../ui/colorParser";

export interface AltCompletionInput {
  readonly candidates: readonly DesignToken[];
  readonly pivot: DesignToken | null;
  readonly replaceRange: vscode.Range;
  /** Mirrors the subtitle of the webview picker — shown on the doc panel of each item. */
  readonly subtitle: string;
}

interface Pending {
  readonly editor: vscode.TextEditor;
  readonly input: AltCompletionInput;
  readonly groupKeyByIndex: readonly string[];
  readonly groupOrder: ReadonlyMap<string, number>;
  readonly resolve: (chosen: DesignToken | null) => void;
  /** Caret position when the suggest was triggered. Used to detect cursor-moved cancels. */
  readonly anchorPosition: vscode.Position;
}

let pending: Pending | null = null;

/**
 * Opens the suggest widget under the current caret and resolves with the
 * chosen token (or `null` if the user dismissed). The replacement edit
 * is applied by VSCode itself via the CompletionItem's `range` +
 * `insertText` — the caller MUST NOT re-apply it.
 */
export function openAlternativesAsCompletion(
  editor: vscode.TextEditor,
  input: AltCompletionInput,
): Promise<DesignToken | null> {
  // Make sure we don't leak a previous unresolved session.
  if (pending) {
    const stale = pending;
    pending = null;
    stale.resolve(null);
  }

  const { groupKeyByIndex, groupOrder } = computeGroupKeys(input.candidates);
  return new Promise<DesignToken | null>((resolve) => {
    pending = {
      editor,
      input,
      groupKeyByIndex,
      groupOrder,
      resolve,
      anchorPosition: editor.selection.active,
    };
    // Fire-and-forget. The suggest widget is async and we observe the
    // outcome via the accept command / cancel listeners wired in
    // `registerAlternativesCompletion`.
    void vscode.commands.executeCommand("editor.action.triggerSuggest");
  });
}

/**
 * Wires the provider + accept command + cancel listeners. Called once
 * from `activate`. Returns a disposable bundle for the extension's
 * subscriptions array.
 */
export function registerAlternativesCompletion(
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  const subs: vscode.Disposable[] = [];

  // We scope the provider to the stylesheet languages — same set as the
  // Alt+T keybinding `when` clause.
  const selector: vscode.DocumentSelector = [
    { language: "scss", scheme: "file" },
    { language: "sass", scheme: "file" },
    { language: "css", scheme: "file" },
    { language: "less", scheme: "file" },
  ];
  subs.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new AltCompletionProvider(),
    ),
  );

  subs.push(
    vscode.commands.registerCommand(
      "tokenFlow._altCompletionAccepted",
      (index: number) => {
        const current = pending;
        if (!current) return;
        pending = null;
        const chosen = current.input.candidates[index] ?? null;
        current.resolve(chosen);
      },
    ),
  );

  // Cancellation: the suggest widget closes silently on Esc / blur. We
  // treat any selection change or active-editor change while `pending`
  // is set as a cancel. The accept command nulls `pending` synchronously
  // BEFORE VSCode applies the insertion, so the resulting cursor move
  // doesn't accidentally double-fire as a cancel.
  subs.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!pending) return;
      if (e.textEditor !== pending.editor) return;
      // Ignore micro-jitters within the same line — only fire when the
      // cursor genuinely leaves the anchor offset.
      const newPos = e.selections[0]?.active;
      if (newPos && newPos.isEqual(pending.anchorPosition)) return;
      const current = pending;
      pending = null;
      current.resolve(null);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (!pending) return;
      const current = pending;
      pending = null;
      current.resolve(null);
    }),
  );

  return vscode.Disposable.from(...subs);
}

// ─── Provider ───────────────────────────────────────────────────────────

class AltCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
  ): vscode.CompletionItem[] | null {
    const current = pending;
    if (!current) return null;
    if (document.uri.toString() !== current.editor.document.uri.toString()) {
      return null;
    }
    return current.input.candidates.map((token, i) =>
      buildItem(token, i, current),
    );
  }
}

function buildItem(
  token: DesignToken,
  index: number,
  ctx: Pending,
): vscode.CompletionItem {
  const groupKey = ctx.groupKeyByIndex[index];
  const groupIndex = ctx.groupOrder.get(groupKey) ?? 0;

  // Right-aligned grey segment in the suggest widget. Empty for the
  // common-prefix group ("the unprefixed siblings") so the eye anchors
  // on the actual differentiator only.
  const description = groupKey.length > 0 ? groupKey : "";

  const item = new vscode.CompletionItem(
    { label: token.name, description },
    completionKindFor(token.category),
  );

  // `detail` is shown inline to the right of the label, before the
  // description. We surface the resolved value there since it's the
  // single most useful disambiguator between siblings.
  item.detail = token.resolvedValue;

  // The doc panel (right-hand pane of the suggest widget) gets a richer
  // markdown card — large swatch, value, variant count, scope hint.
  item.documentation = buildDocumentation(token, ctx.input.subtitle);

  // The replace range is the one resolved by the action layer (covers
  // the full `var(--x)` call, the bare `--x`, the `$x`, or the literal).
  // VSCode applies this edit when the user accepts the item.
  item.insertText = tokenExpression(token);
  item.range = ctx.input.replaceRange;

  // Group items together with a stable numeric prefix, then alphabetical
  // inside the group. The pivot's group floats to the top via index 0.
  const padded = String(groupIndex).padStart(4, "0");
  item.sortText = `${padded}_${token.name}`;

  // Always preselect the first item (the pivot or the first sibling) so
  // Enter from the keyboard accepts it without arrow-key navigation.
  if (index === (ctx.input.pivot
    ? ctx.input.candidates.findIndex((c) => c.name === ctx.input.pivot!.name)
    : 0)) {
    item.preselect = true;
  }

  item.command = {
    command: "tokenFlow._altCompletionAccepted",
    title: "Apply token alternative",
    arguments: [index],
  };
  return item;
}

function buildDocumentation(
  token: DesignToken,
  subtitle: string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  md.isTrusted = false;

  // A large inline swatch (data-URI SVG) for colors — gives the doc
  // panel a real visual identity beyond the small native pastille on
  // the list item.
  const swatch = colorSwatchMarkdown(token.resolvedValue);
  if (swatch) md.appendMarkdown(`${swatch}\n\n`);

  md.appendMarkdown(`**${token.name}**\n\n`);
  md.appendMarkdown(`\`${token.resolvedValue}\`\n\n`);
  md.appendMarkdown(`_${subtitle}_`);

  if (token.variants.length > 0) {
    md.appendMarkdown(`\n\n---\n\n**Variants** (${token.variants.length})\n`);
    for (const v of token.variants.slice(0, 5)) {
      md.appendMarkdown(`- \`${v.value}\` — ${v.condition}\n`);
    }
    if (token.variants.length > 5) {
      md.appendMarkdown(`- …and ${token.variants.length - 5} more\n`);
    }
  }
  return md;
}

function colorSwatchMarkdown(value: string): string | null {
  const rgba = parseColor(value);
  if (!rgba) return null;
  const hex = rgbaToCacheKey(rgba);
  const fill = `rgba(${rgba.r},${rgba.g},${rgba.b},${(rgba.a / 255).toFixed(3)})`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24" viewBox="0 0 64 24">` +
    `<rect x="0.5" y="0.5" width="63" height="23" rx="4" ry="4" fill="${fill}" stroke="#888" stroke-width="1"/>` +
    `</svg>`;
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return `![#${hex}](${dataUri})`;
}

function completionKindFor(category: TokenCategory): vscode.CompletionItemKind {
  switch (category) {
    case "COLOR":
      // The killer feature: VSCode renders the native swatch icon for
      // Color items by parsing `detail` / `documentation` for a hex.
      return vscode.CompletionItemKind.Color;
    case "TYPOGRAPHY":
      return vscode.CompletionItemKind.Text;
    case "SPACING":
    case "RADIUS":
      return vscode.CompletionItemKind.Unit;
    case "DURATION":
      return vscode.CompletionItemKind.Value;
    case "SHADOW":
      return vscode.CompletionItemKind.Struct;
    case "Z_INDEX":
      return vscode.CompletionItemKind.Constant;
    default:
      return vscode.CompletionItemKind.Variable;
  }
}

// ─── Grouping (mirrors the webview picker's prefix algorithm) ───────────

interface GroupAssignment {
  readonly groupKeyByIndex: readonly string[];
  /** group key → numeric order used for `sortText` */
  readonly groupOrder: ReadonlyMap<string, number>;
}

function computeGroupKeys(
  candidates: readonly DesignToken[],
): GroupAssignment {
  if (candidates.length === 0) {
    return { groupKeyByIndex: [], groupOrder: new Map() };
  }
  const common = computeCommonPrefix(candidates);
  const keys: string[] = [];
  const seen = new Map<string, number>();
  let nextOrder = 0;
  for (const t of candidates) {
    const parts = splitName(t.name).slice(common.length, -1);
    const key = parts.join(" › ").toUpperCase();
    keys.push(key);
    if (!seen.has(key)) seen.set(key, nextOrder++);
  }
  return { groupKeyByIndex: keys, groupOrder: seen };
}

function splitName(name: string): string[] {
  return name
    .replace(/^(--|\$)/, "")
    .split("-")
    .filter((s) => s.length > 0);
}

function computeCommonPrefix(candidates: readonly DesignToken[]): string[] {
  const splits = candidates.map((c) => splitName(c.name));
  const minLen = Math.min(...splits.map((s) => s.length));
  let commonLen = 0;
  for (let i = 0; i < minLen; i++) {
    const seg = splits[0][i];
    if (splits.every((s) => s[i] === seg)) commonLen = i + 1;
    else break;
  }
  return splits[0].slice(0, commonLen);
}
