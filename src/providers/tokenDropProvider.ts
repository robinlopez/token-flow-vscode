// `DocumentDropEditProvider` for token drag-drops inside JS/TS
// files. VSCode normally pastes the drag payload (a Style-Dictionary
// alias `'{a.b.c}'`) verbatim at the drop position. That's the right
// thing in plain JS object positions:
//
//   const theme = { color: '{primitive.primary.500}' };
//
// …but wrong inside a CSS-in-JS template literal where the codebase
// expects a `dt(…)` call interpolation. PrimeUIX presets — and most
// styled-components / Emotion patterns — look like:
//
//   css: ({ dt }) => `
//     .button {
//       background: ${dt('primitive.primary.500')};
//       padding: ${dt('units.default')};
//     }
//   `;
//
// This provider intercepts drops whose payload is a SD alias literal
// and whose drop position lives inside a backticked template. It
// rewrites the inserted text to `${dt('a.b.c')}`. Outside of
// templates we leave the payload alone so the standard "drop into
// JS object" flow keeps working.
//
// Detection is a single backwards-scan from the drop offset, counting
// unescaped backticks. Odd count of backticks before the drop → we're
// inside a template. Cheap (O(file size) once per drop) and accurate
// enough for the canonical PrimeUIX shape.

import * as vscode from "vscode";
import { injectModeSegment } from "../scanner/tokenNameParser";

const JS_LIKE = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

/** Matches a Style-Dictionary alias literal payload like `'{a.b.c}'`. */
const SD_ALIAS_PAYLOAD = /^["'`]\{([A-Za-z_][A-Za-z0-9_.\-]*)\}["'`]$/;

export class TokenDropEditProvider
  implements vscode.DocumentDropEditProvider
{
  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
  ): Promise<vscode.DocumentDropEdit | null> {
    if (!JS_LIKE.has(document.languageId)) return null;
    const item = dataTransfer.get("text/plain");
    if (!item) return null;
    const raw = await item.asString();
    const match = raw.trim().match(SD_ALIAS_PAYLOAD);
    if (!match) return null;

    // PrimeUIX-style preset files split light/dark variants under
    // `colorScheme.light.{…}` / `colorScheme.dark.{…}`. The dragged
    // token name is canonical (mode-stripped) so a naive drop
    // produces `'{global.high.surface.default}'` even when the user
    // drops it under `colorScheme.light` — losing the mode segment
    // the file structure implies. Re-inject `modeLight` / `modeDark`
    // from the surrounding context so the drop matches what's
    // already there. Inferred from the closest enclosing
    // `colorScheme: { light: { … } }` block.
    const inferredMode = inferModeFromContext(document, position);
    const path = inferredMode
      ? injectModeSegment(match[1], inferredMode.raw, inferredMode.index)
      : match[1];

    const inTemplate = isInsideTemplateLiteral(document, position);
    // `label` was added to DocumentDropEdit in newer VS Code APIs;
    // the engines line in package.json targets ^1.85.0, where it
    // isn't part of the type yet. Constructing without the label is
    // enough — the edit applies on drop regardless.
    return new vscode.DocumentDropEdit(
      inTemplate ? "${dt('" + path + "')}" : `'{${path}}'`,
    );
  }
}

/**
 * Looks for an enclosing `colorScheme: { light: { … } }` /
 * `colorScheme: { dark: { … } }` block above the drop position. When
 * found, returns the mode-injection plan that mirrors what the rest of
 * the file already does for sibling tokens (so the drop preserves the
 * project's existing mode-aware structure).
 *
 * Implementation: walk lines upwards counting `{`/`}` to find the
 * matching opener, then look at the preceding identifier(s). Stops at
 * the first scope opener encountered — keeps it linear and avoids
 * confusing nested unrelated `light:` / `dark:` keys.
 *
 * `index = 1` matches PrimeUIX's convention `{component.modeLight.…}`,
 * which is what the indexer's `stripModeSegment` operates on. The
 * raw segment (`modeLight` / `modeDark`) preserves casing.
 */
function inferModeFromContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): { raw: string; index: number } | null {
  const text = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position),
  );
  // Walk backwards through chars, tracking brace depth. Each time
  // depth drops to -1 we've found an unclosed `{` — peek the few
  // tokens before it for `(light|dark):`.
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        // Found an unclosed brace. Read the property name preceding
        // it (`light:` / `dark:`).
        const head = text.substring(0, i);
        // Trim trailing whitespace + the optional `:`.
        let j = head.length - 1;
        while (j >= 0 && /\s/.test(head[j])) j--;
        if (j < 0 || head[j] !== ":") return null;
        j--;
        while (j >= 0 && /\s/.test(head[j])) j--;
        const idEnd = j + 1;
        while (j >= 0 && /[A-Za-z_]/.test(head[j])) j--;
        const ident = head.substring(j + 1, idEnd).toLowerCase();
        if (ident === "light") return { raw: "modeLight", index: 1 };
        if (ident === "dark") return { raw: "modeDark", index: 1 };
        return null;
      }
      depth--;
    }
  }
  return null;
}

/**
 * Heuristic: are we inside a backticked template literal?
 *
 * We count unescaped backticks from file start to [position]. An odd
 * count means there's an unclosed template that we're inside of.
 *
 * Limitations (deliberate, simple > clever):
 *   • String literals containing literal "`" characters in single-
 *     or double-quoted form will skew the count. Real-world template
 *     boundaries dominate, false positives are very rare.
 *   • Comments containing backticks will likewise skew the count.
 *     The TS source files we target don't typically embed backticks
 *     in comments.
 */
function isInsideTemplateLiteral(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  const text = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position),
  );
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++; // skip the next char (escape)
      continue;
    }
    if (c === "`") count++;
  }
  return count % 2 === 1;
}
