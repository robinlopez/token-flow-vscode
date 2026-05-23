// Builds the HTML envelope every webview shares: VSCode-themed reset CSS,
// CSP with a per-invocation nonce, and `<script src>` / `<link href>`
// pointing at the bundled JS + copied CSS in `out/webview/`.
//
// Why a nonce: VSCode webviews enforce a strict CSP that defaults to
// blocking inline scripts. Each render generates a random nonce, stamps
// it onto the CSP `script-src` directive AND on the `<script>` tag, so
// the IDE accepts our bundle but not anything injected at runtime.

import * as vscode from "vscode";

interface WebviewHtmlOpts {
  /** Logical name used to locate `<name>.js` and `<name>.css` in `out/webview/`. */
  readonly name:
    | "library"
    | "hardcoded"
    | "analyse"
    | "settings"
    | "alternatives";
  /** The view's `<title>` element (mostly debug-visible). */
  readonly title: string;
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  /** Optional body markup appended before the closing `</body>`. Used for
   *  the initial skeleton each webview ships with — keeps the HTML
   *  template here generic. */
  readonly bodyHtml?: string;
}

export function buildWebviewHtml(opts: WebviewHtmlOpts): string {
  const nonce = randomNonce();
  const jsUri = opts.webview.asWebviewUri(
    vscode.Uri.joinPath(opts.extensionUri, "out", "webview", `${opts.name}.js`),
  );
  const cssUri = opts.webview.asWebviewUri(
    vscode.Uri.joinPath(opts.extensionUri, "out", "webview", `${opts.name}.css`),
  );
  const csp = [
    `default-src 'none'`,
    `style-src ${opts.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${opts.webview.cspSource} data:`,
    `font-src ${opts.webview.cspSource}`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    <link rel="stylesheet" href="${cssUri}">
  </head>
  <body>
    ${opts.bodyHtml ?? ""}
    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
}

function randomNonce(): string {
  // 32-char alphanumeric — comfortably above the 16-char minimum that
  // most CSP guides recommend. Using Math.random is fine here: the
  // nonce is per-render, never compared against user input, only
  // checked by the browser against itself.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
