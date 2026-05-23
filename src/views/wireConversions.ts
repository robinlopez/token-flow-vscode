// Serialisation helpers — translate the host-side rich types into the
// wire-format used by webview clients. Centralising this keeps the
// protocol (`src/webview/shared/protocol.ts`) and the consumers in lockstep
// when fields are added.

import { DesignToken, tokenExpression } from "../model/designToken";
import { WireToken, WireVariantColumn } from "../webview/shared/protocol";
import { parseColor, rgbaToCacheKey } from "../ui/colorParser";
import { buildTokenMarkdown } from "../ui/tokenMarkdown";
import { collectColumns } from "../ui/tokenMarkdown";

export function toWireToken(token: DesignToken): WireToken {
  return {
    name: token.name,
    resolvedValue: token.resolvedValue,
    rawValue: token.rawValue,
    category: token.category,
    kind: token.kind,
    variantCount: token.variants.length,
    hex: colorHex(token.resolvedValue, token.category === "COLOR"),
    // Pre-compute the column model so the Library popover can render
    // a real HTML table without re-parsing on the client. Each cell
    // carries its own hex (for swatch rendering) computed once with
    // the same `colorParser` the Library swatches use — single source
    // of truth across the plugin.
    variantColumns: collectColumns(token).map<WireVariantColumn>((c) => ({
      theme: c.theme,
      sub: c.sub,
      value: c.value,
      hex: colorHex(c.value, token.category === "COLOR"),
    })),
    tooltipMarkdown: buildTokenMarkdown(token),
    // Copy / drag-and-drop emit the canonical insertion form per kind
    // (`var(--x)` for CSS custom property, `$x` for SCSS variable,
    // `'{path}'` for JS preset, …). Centralising here means the
    // webview never has to know about kinds.
    insertText: tokenExpression(token),
  };
}

/**
 * Returns the canonical `#rrggbb` (or `#rrggbbaa` when alpha < 255) for
 * a value that parses as a color, or `null` otherwise. Used both for
 * the row swatch and per-variant swatches in the popover.
 */
function colorHex(value: string, isColorCategory: boolean): string | null {
  if (!isColorCategory) return null;
  const rgba = parseColor(value);
  if (!rgba) return null;
  const key = rgbaToCacheKey(rgba);
  return rgba.a === 255 ? "#" + key.substring(0, 6) : "#" + key;
}
