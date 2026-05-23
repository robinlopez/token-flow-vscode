import * as vscode from "vscode";
import { DynamicCssVarIndex, CssVarOccurrence } from "../scanner/dynamicCssVarIndex";
import * as path from "path";

export async function showContextualVarPicker(
  varName: string,
  index: DynamicCssVarIndex,
): Promise<void> {
  const occurrences = index.lookup(varName);
  if (occurrences.length === 0) {
    vscode.window.showInformationMessage(`Token Flow: no declarations or references found for ${varName}.`);
    return;
  }

  // Sort: static CSS first, then runtime injections
  const sorted = [...occurrences].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "static" ? -1 : 1;
    }
    // Then sort by file name
    return a.filePath.localeCompare(b.filePath);
  });

  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "";

  const items = sorted.map((occ) => {
    let relPath = occ.filePath;
    if (rootPath && relPath.startsWith(rootPath)) {
      relPath = relPath.substring(rootPath.length).replace(/^\//, "");
    }
    
    // Attempt to extract a color preview if applicable
    const isColor = /^(?:#|rgb|hsl|color)/i.test(occ.value);
    const icon = isColor ? "$(symbol-color)" : "$(symbol-variable)";

    return {
      label: `${icon} ${occ.value}`,
      description: `at line ${occ.line} — ${occ.selector}`,
      detail: relPath,
      occurrence: occ,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Select a location for ${varName}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (pick) {
    const doc = await vscode.workspace.openTextDocument(pick.occurrence.filePath);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(pick.occurrence.line - 1, 0); // lines are 1-indexed in the occurrence, 0-indexed in Position
    
    // Try to find the exact offset or column if possible. The offset in occurrence is absolute string offset.
    const exactPos = doc.positionAt(pick.occurrence.offset);
    editor.selection = new vscode.Selection(exactPos, exactPos);
    editor.revealRange(
      new vscode.Range(exactPos, exactPos),
      vscode.TextEditorRevealType.InCenter,
    );
  }
}
