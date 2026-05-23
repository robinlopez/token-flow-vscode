// Tiny status-bar item that announces the active Token Flow scope so
// the user always knows which token set applies to the current file.
// Clicking the item opens the configuration command — a QuickPick that
// jumps to the JSON settings (until we ship a dedicated Settings
// webview).
//
// Visible only when a stylesheet is the active editor, to keep the
// status bar uncluttered when the user is in unrelated files. Hidden
// states use `item.hide()` (cheaper than recreating).

import * as vscode from "vscode";
import {
  ActiveScopeTracker,
  isTokenRelevantLanguage,
} from "../services/activeScopeTracker";
import { COMMON_SCOPE_NAME } from "../settings/scopes";

const STATUSBAR_PRIORITY = 100; //                                left-side, default placement

export function createScopeStatusBar(
  tracker: ActiveScopeTracker,
  context: vscode.ExtensionContext,
): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUSBAR_PRIORITY,
  );
  item.command = "tokenFlow.openSettings";
  item.tooltip = "Token Flow — current scope (click to open the Scopes editor)";

  const refresh = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isTokenRelevantLanguage(editor.document.languageId)) {
      item.hide();
      return;
    }
    const specific = tracker.specific();
    // The icon `$(layers)` reads as "stack of scopes" — visual hint
    // that this controls a multi-layer concept, not a single mode.
    item.text = specific
      ? `$(layers) ${specific.name}`
      : `$(layers) ${COMMON_SCOPE_NAME}`;
    item.show();
  };

  const subs = [
    item,
    tracker.onDidChange(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
  ];
  context.subscriptions.push(...subs);
  refresh();
  return {
    dispose: () => {
      for (const s of subs) s.dispose();
    },
  };
}

