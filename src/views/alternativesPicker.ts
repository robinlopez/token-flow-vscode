// Custom webview picker for the Alt+T action. Replaces the native
// `vscode.window.showQuickPick` because:
//
//   • `QuickPickItem.iconPath` is unreliable in recent VSCode builds
//     (silent no-op on Uri form, unpredictable on `{light, dark}`),
//     which means real color swatches don't render — the single
//     biggest UX miss for a tool aimed at designers/integrators.
//   • `QuickPickItemKind.Separator` rows render inline with the next
//     item (the user reported the divider showing against the first
//     row rather than between groups) — also breaks the IntelliJ
//     funnel popup vibe.
//
// This webview gives us:
//   • CSS-native pastilles (`background-color: #hex`) at any size,
//     with stroke and shadow for crisp visibility on both light and
//     dark themes.
//   • Proper group dividers between sections.
//   • Full keyboard control (↑ / ↓ / Enter / Esc / typing-to-filter).
//   • Modal-style centered card with a backdrop — feels like a
//     real picker, not a tab.
//
// Lifecycle: one-shot. The picker resolves a Promise<DesignToken | null>
// on `select` / `cancel` / panel-disposed and never reopens (a fresh
// call to `openAlternativesPicker` always creates a new panel).

import * as vscode from "vscode";
import { DesignToken } from "../model/designToken";
import { parseColor, rgbaToCacheKey } from "../ui/colorParser";
import {
  AltClientMessage,
  AltHostMessage,
  WireAltCandidate,
  WireAltGroup,
} from "../webview/shared/protocol";
import { buildWebviewHtml } from "./webviewHtml";

const CATEGORY_THEME_ICONS: Record<string, string> = {
  COLOR: "symbol-color",
  SPACING: "symbol-ruler",
  TYPOGRAPHY: "symbol-text",
  SHADOW: "symbol-misc",
  RADIUS: "symbol-namespace",
  DURATION: "watch",
  Z_INDEX: "layers",
  OTHER: "symbol-misc",
};

export interface AltPickerInput {
  readonly title: string;
  readonly subtitle: string;
  readonly candidates: readonly DesignToken[];
  readonly pivot: DesignToken | null;
}

export interface AltPickerOptions {
  /**
   * Where to open the panel. `Active` covers the current editor (legacy);
   * `Beside` opens a small split column next to it so the code stays
   * visible — paired with `autoDisposeOnBlur` to mimic an ephemeral popup.
   */
  readonly viewColumn?: vscode.ViewColumn;
  /**
   * When true, the panel disposes as soon as it loses visibility (user
   * clicks back into the editor without picking). Resolves with `null`.
   */
  readonly autoDisposeOnBlur?: boolean;
}

export function openAlternativesPicker(
  context: vscode.ExtensionContext,
  input: AltPickerInput,
  options: AltPickerOptions = {},
): Promise<DesignToken | null> {
  const viewColumn = options.viewColumn ?? vscode.ViewColumn.Active;
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "tokenFlow.alternatives",
      "Token Flow — Alternatives",
      { viewColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
      },
    );
    panel.webview.html = buildWebviewHtml({
      name: "alternatives",
      title: "Token Flow — Alternatives",
      webview: panel.webview,
      extensionUri: context.extensionUri,
      bodyHtml: skeletonHtml(),
    });

    // Resolve-once guard: select/cancel/dispose all race; whichever
    // wins resolves and disposes; the others are no-ops.
    let settled = false;
    const settle = (token: DesignToken | null) => {
      if (settled) return;
      settled = true;
      // Disposing the panel re-focuses the previous editor automatically.
      try {
        panel.dispose();
      } catch {
        // Already disposing — fine.
      }
      resolve(token);
    };

    panel.webview.onDidReceiveMessage((msg: AltClientMessage) => {
      switch (msg.type) {
        case "ready":
          panel.webview.postMessage(buildInitMessage(input));
          return;
        case "select":
          settle(input.candidates[msg.index] ?? null);
          return;
        case "cancel":
          settle(null);
          return;
      }
    });

    panel.onDidDispose(() => settle(null));

    // Popup-like ephemeral behaviour: the user clicks back into the code
    // → the picker should evaporate, not linger as a stale tab. We arm
    // this only after the panel has first become visible+active, so the
    // initial transition from "creating" to "visible" doesn't fire it.
    if (options.autoDisposeOnBlur) {
      let armed = false;
      panel.onDidChangeViewState((e) => {
        if (!armed) {
          if (e.webviewPanel.active) armed = true;
          return;
        }
        if (!e.webviewPanel.active) settle(null);
      });
    }
  });
}

// ─── Init payload ────────────────────────────────────────────────────────

function buildInitMessage(input: AltPickerInput): AltHostMessage {
  const tokens = input.candidates.map(toWireCandidate);
  const groups = computeGroups(input.candidates);
  const pivotIndex = input.pivot
    ? input.candidates.findIndex((c) => c.name === input.pivot!.name)
    : -1;
  return {
    type: "init",
    title: input.title,
    subtitle: input.subtitle,
    tokens,
    groups,
    preselectIndex: pivotIndex >= 0 ? pivotIndex : 0,
  };
}

function toWireCandidate(token: DesignToken): WireAltCandidate {
  return {
    name: token.name,
    value: token.resolvedValue,
    hex: token.category === "COLOR" ? canonicalHex(token.resolvedValue) : null,
    variantCount: token.variants.length,
    categoryIcon: CATEGORY_THEME_ICONS[token.category] ?? "symbol-misc",
  };
}

function canonicalHex(value: string): string | null {
  const rgba = parseColor(value);
  if (!rgba) return null;
  const key = rgbaToCacheKey(rgba);
  return rgba.a === 255 ? "#" + key.substring(0, 6) : "#" + key;
}

// ─── Name-prefix grouping ───────────────────────────────────────────────

/**
 * Same algorithm as the previous native-QuickPick implementation:
 * group by name segments BETWEEN the longest segment-aligned common
 * prefix and the LAST segment (the variation suffix). The host
 * computes the groups; the client just renders the indices.
 *
 *   `--global-low-surface-default`   common: ["global", "low"]
 *   `--global-low-surface-hover`    → group: ["surface"]   → "SURFACE"
 *   `--global-low-content-default`  → group: ["content"]   → "CONTENT"
 *
 *   `--size-typography-title-sm`     common: ["size"]
 *                                    → group: ["typography", "title"]
 *                                    → "TYPOGRAPHY › TITLE"
 */
function computeGroups(
  candidates: readonly DesignToken[],
): WireAltGroup[] {
  if (candidates.length === 0) return [];
  const common = computeCommonPrefix(candidates);

  const byKey = new Map<
    string,
    { path: string[]; indices: number[] }
  >();
  for (let i = 0; i < candidates.length; i++) {
    const parts = splitName(candidates[i].name).slice(common.length, -1);
    const key = parts.join("|");
    let entry = byKey.get(key);
    if (!entry) {
      entry = { path: parts, indices: [] };
      byKey.set(key, entry);
    }
    entry.indices.push(i);
  }
  return [...byKey.values()].map(({ path, indices }) => ({
    pathSegments: path,
    tokenIndices: indices,
  }));
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

// ─── Skeleton ───────────────────────────────────────────────────────────

function skeletonHtml(): string {
  return /* html */ `
<div id="picker-root">
  <div class="picker">
    <header class="picker__header">
      <h1 class="picker__title">Loading…</h1>
    </header>
  </div>
</div>`;
}
