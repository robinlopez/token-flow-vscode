// Renders the small circular swatch shown next to COLOR tokens in the
// Library tree. VSCode tree items can't accept arbitrary inline color
// data — they only take an `iconPath` (Uri | ThemeIcon), so we generate
// a per-color 16×16 SVG once and reference it by URI.
//
// Files are cached under `<globalStorage>/swatches/<rrggbbaa>.svg`. The
// cache key is the canonical RGBA hex, so equivalent literals
// (`#ff0000`, `rgb(255, 0, 0)`, `red`) share a single file.
//
// Alpha < 255 renders over a small grey checkerboard so semi-transparent
// tokens are visually distinct from their opaque siblings.

import * as vscode from "vscode";
import { parseColor, rgbaToCacheKey, RGBA } from "./colorParser";

/**
 * Returns the URI of the swatch SVG for [value], or `null` if [value]
 * isn't a parsable color literal (caller should fall back to a codicon).
 * Creates the file on first call; subsequent calls do a single `stat`.
 */
export async function colorSwatchUri(
  context: vscode.ExtensionContext,
  value: string,
): Promise<vscode.Uri | null> {
  const rgba = parseColor(value);
  if (!rgba) return null;

  const dir = vscode.Uri.joinPath(context.globalStorageUri, "swatches");
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // Already exists — `createDirectory` on an existing folder is a noop
    // in spec but throws on some FS impls; swallowing is safe.
  }

  const file = vscode.Uri.joinPath(dir, `${rgbaToCacheKey(rgba)}.svg`);
  try {
    await vscode.workspace.fs.stat(file);
    return file;
  } catch {
    // Missing — fall through and create it.
  }

  await vscode.workspace.fs.writeFile(file, Buffer.from(buildSvg(rgba), "utf8"));
  return file;
}

/**
 * Builds the 16×16 SVG. Layers (bottom → top):
 *  1. Optional checkerboard pattern (only when `alpha < 255`).
 *  2. The color fill clipped to a 6-px-radius circle.
 *  3. A 0.5-px grey stroke for legibility on both light and dark themes.
 */
function buildSvg(c: RGBA): string {
  const fill = `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;
  // Transparency-aware: render a tiny 4×4 checkerboard behind the swatch so
  // a fully transparent token doesn't look identical to an empty cell.
  const checker = c.a < 255 ? checkerboardPattern() : "";
  const checkerLayer =
    c.a < 255
      ? `<circle cx="8" cy="8" r="6" fill="url(#swatch-checker)"/>`
      : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">`,
    checker,
    checkerLayer,
    `<circle cx="8" cy="8" r="6" fill="${fill}"/>`,
    `<circle cx="8" cy="8" r="6" fill="none" stroke="#888" stroke-width="0.5"/>`,
    `</svg>`,
  ].join("");
}

function checkerboardPattern(): string {
  return [
    `<defs>`,
    `<pattern id="swatch-checker" width="4" height="4" patternUnits="userSpaceOnUse">`,
    `<rect width="4" height="4" fill="#e0e0e0"/>`,
    `<rect width="2" height="2" fill="#a0a0a0"/>`,
    `<rect x="2" y="2" width="2" height="2" fill="#a0a0a0"/>`,
    `</pattern>`,
    `</defs>`,
  ].join("");
}
