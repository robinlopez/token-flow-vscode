// "Copy Token Value" — VS Code port of the IntelliJ v0.2.3 gesture
// (issue #27). A command (default keybinding `Alt+V`, also on the editor
// context menu) opens a QuickPick on the token reference under the
// caret, offering its **resolved value** (preselected), colour alternates
// (HEX/RGB/HSL/OKLCH, skipping the source format) and its **token
// name/reference**. The hover popup additionally renders the same list
// as clickable copy links.
//
// VS Code reserves Ctrl/Cmd+Click for Go-to-Definition and exposes no
// editor mouse hook, so the IntelliJ "modifier+click → dropdown" gesture
// becomes command + keybinding + context-menu + hover links — see
// doc/copy-token-value.md §2.

import * as vscode from "vscode";
import { TokenScanner } from "../scanner/tokenScanner";
import { ActiveScopeTracker } from "../services/activeScopeTracker";
import { DesignToken, tokenExpression } from "../model/designToken";
import { tokenReferenceAt } from "../scanner/tokenReferenceAt";
import { resolveTokenByReference } from "../scanner/resolveTokenReference";
import { parseColor } from "../ui/colorParser";
import {
  COLOR_FORMATS,
  detectFormat,
  toFormat,
} from "../ui/colorConversions";

export interface CopyOption {
  /** Short row label shown as the QuickPick description / hover suffix. */
  readonly label: string;
  /** The text copied to the clipboard. */
  readonly value: string;
}

/** Whether the feature is enabled (gates the command, keybinding, menu and hover links). */
export function copyValueEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("tokenFlow")
    .get<boolean>("copyValue.enabled", true);
}

/**
 * Resolves the token under the caret, scope-filtered. Shared by the
 * command and by the `tokenFlow.onTokenReference` context-key updater so
 * the keybinding/menu only light up when a value is actually copyable.
 */
export async function findTokenAtCursor(
  editor: vscode.TextEditor,
  scanner: TokenScanner,
  scopes: ActiveScopeTracker,
): Promise<DesignToken | null> {
  const hit = tokenReferenceAt(editor.document, editor.selection.active);
  if (!hit) return null;
  const tokens = await scanner.scan();
  const active = scopes.activeNames();
  return resolveTokenByReference(
    tokens.filter((t) => active.has(t.scope)),
    hit.name,
  );
}

export async function copyTokenValue(
  scanner: TokenScanner,
  scopes: ActiveScopeTracker,
): Promise<void> {
  if (!copyValueEnabled()) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const hit = tokenReferenceAt(editor.document, editor.selection.active);
  if (!hit) {
    vscode.window.setStatusBarMessage(
      "Token Flow: place the cursor on a token reference.",
      2500,
    );
    return;
  }
  const tokens = await scanner.scan();
  const active = scopes.activeNames();
  const token = resolveTokenByReference(
    tokens.filter((t) => active.has(t.scope)),
    hit.name,
  );
  if (!token) {
    vscode.window.setStatusBarMessage(
      `Token Flow: no token resolves for "${hit.name}".`,
      2500,
    );
    return;
  }

  // `showQuickPick` preselects the first item, so listing "Resolved
  // value" first matches IntelliJ's "default = resolved value" behaviour.
  const options = buildCopyOptions(token);
  const pick = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o.value, description: o.label, value: o.value })),
    {
      title: `Copy value of ${token.name}`,
      placeHolder: "Resolved value",
    },
  );
  if (!pick) return;
  await copyText(pick.value);
}

/** Writes [value] to the clipboard with the `📋 Copied "…"` status-bar feedback. */
export async function copyText(value: string): Promise<void> {
  await vscode.env.clipboard.writeText(value);
  vscode.window.setStatusBarMessage(`📋 Copied "${value}"`, 2000);
}

/**
 * Builds the dropdown rows for [token]:
 *   1. Resolved value (always first, preselected).
 *   2. Colour alternates HEX/RGB/HSL/OKLCH — only when the resolved
 *      value parses as a colour, skipping its own source format.
 *   3. Token name / reference expression — when it differs from the
 *      resolved value (it always does, except for self-referential
 *      primitives).
 */
export function buildCopyOptions(token: DesignToken): CopyOption[] {
  const out: CopyOption[] = [
    { label: "Resolved value", value: token.resolvedValue },
  ];

  const color = parseColor(token.resolvedValue);
  if (color) {
    const source = detectFormat(token.resolvedValue);
    for (const fmt of COLOR_FORMATS) {
      if (fmt === source) continue;
      out.push({ label: fmt, value: toFormat(color, fmt) });
    }
  }

  const ref = tokenExpression(token);
  if (ref !== token.resolvedValue) out.push({ label: "Token name", value: ref });

  return out;
}
