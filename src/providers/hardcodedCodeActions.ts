// CodeActionProvider companion to `HardcodedDiagnostics`. For each
// hardcoded-value diagnostic at the cursor (or in the lightbulb range),
// emits one "Replace with `var(--token)`" QuickFix per candidate token.
//
// Replacement form is picked via `tokenExpression(token)` so SCSS_VARIABLE
// stays bare-`$name`, CSS_CUSTOM_PROPERTY gets wrapped in `var(…)`, and
// future JS kinds (JS_OBJECT_PATH, JS_RUNTIME_*) plug in without changes
// here.
//
// Replace range comes from the diagnostic's stashed `hit.replaceStart` /
// `replaceEndExclusive`, so a literal sitting inside `rem-calc(14px)` is
// swapped wholesale (the wrapper goes with the literal).

import * as vscode from "vscode";
import { tokenExpression } from "../model/designToken";
import { getHitMeta } from "./hardcodedDiagnostics";

export class HardcodedCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      const meta = getHitMeta(diag);
      if (!meta) continue;
      for (const token of meta.matches) {
        actions.push(buildAction(document, diag, meta, token));
      }
    }
    return actions;
  }
}

function buildAction(
  document: vscode.TextDocument,
  diag: vscode.Diagnostic,
  meta: ReturnType<typeof getHitMeta>,
  token: import("../model/designToken").DesignToken,
): vscode.CodeAction {
  if (!meta) throw new Error("buildAction called without meta");
  const replacement = tokenExpression(token);
  const action = new vscode.CodeAction(
    `Replace with \`${replacement}\``,
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diag];
  // The top candidate becomes the "preferred" fix — VSCode picks it for
  // the `editor.action.autoFix` shortcut (default Cmd/Ctrl+. on a quick
  // fix). Mirrors the IntelliJ "first match wins" UX.
  action.isPreferred = meta.matches[0] === token;
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(meta.hit.replaceStart),
      document.positionAt(meta.hit.replaceEndExclusive),
    ),
    replacement,
  );
  return action;
}
