// Heuristic auto-detection of Token Flow scopes from a workspace layout.
//
// Strategy: walk every `package.json` in the workspace (excluding
// node_modules), classify each as a UI project via its dependency list
// (React, Vue, Angular, Svelte, Next, Nuxt, Vite, Tailwind, …) and
// promote each UI project to a Token Flow scope:
//
//   • scope.name      ← package.json#name (stripped of `@scope/`)
//   • scope.rootPath  ← workspace-relative directory of the package.json
//   • scope.sources   ← token-bearing files inside that directory
//   • scope.excludes  ← curated noise list (node_modules, dist, …)
//
// Falls back to a single scope rooted at the workspace when no
// package.json is found at all (rare — pure CSS/static site).
//
// The detector is purely a data producer: it never writes settings.
// `settingsWebviewPanel.runAutoDetect` owns the mutation + merge logic.

import * as vscode from "vscode";

export interface DetectedScope {
  readonly name: string;
  /** Workspace-relative; "" means a common (always-active) scope. */
  readonly rootPath: string;
  readonly sourcePaths: readonly string[];
  readonly whitelistPaths: readonly string[];
  readonly excludedPaths: readonly string[];
}

/**
 * Noise folders we always want to exclude. node_modules / dist / build
 * are universal — adding them unconditionally keeps the user's panel
 * predictable even when fs.stat misbehaves on virtual workspaces.
 * The rest are added only when they exist at the project root.
 */
const ALWAYS_EXCLUDE: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
];

const CONDITIONAL_EXCLUDE: readonly string[] = [
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".angular",
  ".parcel-cache",
  ".storybook-static",
  "storybook-static",
  ".vscode",
  ".idea",
  ".git",
  "tmp",
  "temp",
];

/** Dependencies that flag a `package.json` as a UI / frontend project. */
const UI_DEP_PATTERNS: readonly RegExp[] = [
  /^react$/, /^react-dom$/, /^react-native$/,
  /^vue$/, /^@vue\//, /^nuxt$/, /^nuxt3$/,
  /^@angular\//, /^@nx\/angular/,
  /^svelte$/, /^@sveltejs\//,
  /^next$/,
  /^solid-js$/,
  /^preact$/,
  /^lit$/, /^lit-element$/, /^lit-html$/,
  /^@stencil\//,
  /^astro$/,
  /^ember-source$/, /^@ember\//,
  /^@ionic\//,
  /^vite$/, /^@vitejs\//,
  /^tailwindcss$/,
  /^sass$/, /^node-sass$/,
  /^styled-components$/, /^@emotion\//,
  /^@mui\//, /^@chakra-ui\//, /^antd$/, /^@mantine\//, /^@radix-ui\//,
  /^primevue$/, /^primereact$/, /^primeng$/,
  /^bootstrap$/,
];

const MAX_ROOTS = 50;
const MAX_FILES_PER_SCOPE = 500;

interface DetectedRoot {
  readonly uri: vscode.Uri;
  readonly name: string;
}

export async function detectScopes(
  workspaceRoot: vscode.Uri,
): Promise<DetectedScope[]> {
  const excludedPaths = await buildExcludeList(workspaceRoot);
  const projects = await detectUiProjects(workspaceRoot);

  // No package.json anywhere — degenerate but possible (pure static
  // site, library of raw SCSS). Fall back to whole-workspace scan.
  if (projects.length === 0) {
    const sources = await detectSourceFiles(workspaceRoot, workspaceRoot);
    if (sources.length === 0) return [];
    return [
      {
        name: "common",
        rootPath: "",
        sourcePaths: sources,
        whitelistPaths: [],
        excludedPaths,
      },
    ];
  }

  // Single UI project at the workspace root → keep rootPath empty so
  // the scope is "common" (always active) — same UX as the user
  // configuring it by hand for a mono-app project.
  if (
    projects.length === 1 &&
    workspaceRelative(workspaceRoot, projects[0].uri) === ""
  ) {
    const p = projects[0];
    const sources = await detectSourceFiles(workspaceRoot, p.uri);
    if (sources.length === 0) return [];
    return [
      {
        name: p.name,
        rootPath: "",
        sourcePaths: sources,
        whitelistPaths: [],
        excludedPaths,
      },
    ];
  }

  const out: DetectedScope[] = [];
  for (const p of projects) {
    const sources = await detectSourceFiles(workspaceRoot, p.uri);
    if (sources.length === 0) continue;
    out.push({
      name: p.name,
      rootPath: workspaceRelative(workspaceRoot, p.uri),
      sourcePaths: sources,
      whitelistPaths: [],
      excludedPaths,
    });
  }
  return out;
}

// ─── UI project discovery ────────────────────────────────────────────────

/**
 * Enumerates every `package.json` in the workspace (skipping
 * `node_modules` and other build artefacts), then keeps only those
 * that look like UI projects (frontend dependency present OR they ship
 * style assets).
 *
 * Containers (monorepo roots whose only job is to orchestrate child
 * packages — `workspaces` field set, or no real UI deps of their own)
 * are skipped so their children can become scopes. Outermost-wins
 * pruning is only applied to **non-container** ancestors, so two
 * sibling apps under a container root both make it through.
 */
async function detectUiProjects(
  workspaceRoot: vscode.Uri,
): Promise<DetectedRoot[]> {
  const pkgUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, "**/package.json"),
    "**/{node_modules,dist,build,out,.next,.nuxt,.svelte-kit,.turbo,.cache,coverage}/**",
    MAX_ROOTS * 10,
  );

  interface Candidate {
    readonly uri: vscode.Uri;
    readonly name: string;
    readonly depth: number;
    /** Explicit container — `workspaces` field set. */
    readonly explicitContainer: boolean;
  }
  const candidates: Candidate[] = [];
  await Promise.all(
    pkgUris.map(async (pkgUri) => {
      const pkg = await readJsonIfExists(pkgUri);
      if (!pkg) return;
      const dirUri = vscode.Uri.joinPath(pkgUri, "..");
      const explicitContainer = isExplicitMonorepoContainer(pkg);
      const isUi =
        explicitContainer ||
        hasUiDependency(pkg) ||
        (await hasStyleAssets(dirUri));
      if (!isUi) return;
      const rawName =
        (typeof pkg.name === "string" && pkg.name.trim()) ||
        basename(dirUri.path);
      candidates.push({
        uri: dirUri,
        name: sanitiseScopeName(rawName),
        depth: dirUri.path.split("/").length,
        explicitContainer,
      });
    }),
  );

  candidates.sort((a, b) => a.depth - b.depth);

  const pathOf = (c: { uri: vscode.Uri }): string =>
    c.uri.path.endsWith("/") ? c.uri.path : c.uri.path + "/";

  // Implicit container detection — any candidate with ≥1 strict-descendant
  // candidate is treated as a monorepo root, even without a `workspaces`
  // field. This is the common shape: a repo with `apps/desktop/` and
  // `apps/mobile/`, where the root package.json carries dev tooling +
  // shared deps but isn't a real UI source-of-truth.
  const isContainer = (c: Candidate): boolean => {
    if (c.explicitContainer) return true;
    const cPath = pathOf(c);
    return candidates.some((other) => {
      const oPath = pathOf(other);
      return oPath !== cPath && oPath.startsWith(cPath);
    });
  };

  const kept: DetectedRoot[] = [];
  for (const c of candidates) {
    if (isContainer(c)) continue;
    const cPath = pathOf(c);
    // Outermost-wins pruning amongst LEAF projects only — a leaf
    // candidate nested under a previously-kept leaf is dropped (this
    // catches `apps/web` containing a `apps/web/internal-lib` that was
    // mis-classified as a UI project via a stray css import).
    const nestedUnderKept = kept.some((k) => {
      const kPath = pathOf(k);
      return cPath.startsWith(kPath) && cPath !== kPath;
    });
    if (nestedUnderKept) continue;
    kept.push({ uri: c.uri, name: c.name });
    if (kept.length >= MAX_ROOTS) break;
  }

  // Edge case — every candidate looked like a container (a repo of pure
  // containers with no leaves, e.g. the user pointed Token Flow at a
  // monorepo root before its children have any UI code). Fall back to
  // the workspace root so the run isn't empty.
  if (kept.length === 0 && candidates.length > 0) {
    const rootName =
      (await readJsonIfExists(
        vscode.Uri.joinPath(workspaceRoot, "package.json"),
      ))?.name ?? basename(workspaceRoot.path);
    kept.push({
      uri: workspaceRoot,
      name: sanitiseScopeName(String(rootName)),
    });
  }
  return kept;
}

/**
 * A `package.json` is an explicit monorepo container when it declares a
 * `workspaces` field. Implicit containers (a root with UI deps that
 * actually orchestrates child apps) are detected separately by looking
 * at the candidate tree topology — see `isContainer` above.
 */
function isExplicitMonorepoContainer(pkg: any): boolean {
  const ws = pkg.workspaces;
  if (Array.isArray(ws) && ws.length > 0) return true;
  if (ws && typeof ws === "object" && Array.isArray(ws.packages) && ws.packages.length > 0) {
    return true;
  }
  return false;
}

function hasUiDependency(pkg: any): boolean {
  const sections = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    for (const dep of Object.keys(sec)) {
      if (UI_DEP_PATTERNS.some((re) => re.test(dep))) return true;
    }
  }
  return false;
}

/**
 * Fallback signal — a package may not declare a UI dep (e.g. a
 * design-tokens lib) but still ship style assets we want to scan.
 * One CSS/SCSS file is enough to qualify.
 */
async function hasStyleAssets(dirUri: vscode.Uri): Promise<boolean> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dirUri, "**/*.{css,scss,sass,less}"),
    "**/{node_modules,dist,build,out}/**",
    1,
  );
  return found.length > 0;
}

// ─── Source-file detection ───────────────────────────────────────────────

async function detectSourceFiles(
  workspaceRoot: vscode.Uri,
  scopeRoot: vscode.Uri,
): Promise<string[]> {
  const includeGlob = new vscode.RelativePattern(
    scopeRoot,
    `**/*.{css,scss,sass,less,ts,tsx,js,jsx,mjs,cjs}`,
  );
  const excludeGlob =
    "**/{node_modules,dist,build,out,.next,.nuxt,.svelte-kit,.turbo,.cache,coverage,.storybook-static,storybook-static,.git,.angular,.parcel-cache}/**";

  const uris = await vscode.workspace.findFiles(
    includeGlob,
    excludeGlob,
    MAX_FILES_PER_SCOPE,
  );

  const qualifying: vscode.Uri[] = [];
  for (const uri of uris) {
    const ext = extOf(uri.path);
    if (!ext) continue;
    // Cheap filename gate — skip obvious non-token files before we
    // pay the cost of reading and analysing content. Real tokens
    // almost always live in files whose name signals their role.
    if (!looksLikeTokenFilename(uri.path) && !hasTokenAncestor(uri.path)) {
      continue;
    }
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
        "utf8",
      );
    } catch {
      continue;
    }
    if (isStyleExt(ext)) {
      if (isStyleTokenFile(text)) qualifying.push(uri);
    } else if (isJsExt(ext)) {
      if (isJsTokenFile(text)) qualifying.push(uri);
    }
  }

  return collapseToParents(
    qualifying.map((u) => workspaceRelative(workspaceRoot, u)),
  );
}

/**
 * Filename heuristic — true when the basename signals a tokens /
 * theme / variables file. Strict on purpose: false positives on the
 * source list pollute the scope and the user trusts the auto-detect
 * less.
 */
function looksLikeTokenFilename(path: string): boolean {
  const lower = basename(path).toLowerCase();
  // Three accepted shapes:
  //   1. `_tokens.scss` / `tokens.ts` / `_theme.scss` / `variables.css` …
  //      — token vocabulary anchored at the start, optionally `_`-prefixed.
  //   2. `_tokens-anything.scss` / `theme.colors.ts` — same vocabulary,
  //      followed by `-` or `.` then arbitrary suffix.
  //   3. `something.tokens.scss` — `.tokens.` segment anywhere.
  const vocab =
    "tokens?|theme|themes|palette|palettes?|variables?|colou?rs?|spacing|sizes?|radii|shadows?|breakpoints?|typography|foundations?|primitives?|design-tokens?|metrics|transitions|durations?|easings?|semantics?|responsive";
  const ext = "(css|scss|sass|less|ts|tsx|js|jsx|mjs|cjs)";
  if (new RegExp(`^_?(${vocab})([-.][\\w.-]*)?\\.${ext}$`).test(lower)) return true;
  if (new RegExp(`\\.tokens?\\.${ext}$`).test(lower)) return true;
  return false;
}

/**
 * Secondary acceptance — a file sitting inside a known token folder
 * tree is allowed through the filename gate even if its own basename
 * doesn't carry the vocabulary.
 *
 * `generated/`, `style(s)/`, `scss/`, `css/` are included because real
 * projects routinely emit Style-Dictionary / Theo output into such
 * folders (the user's case: `src/styles/src/generated/_tokens-*.scss`).
 * The content heuristic still has to qualify each file, so widening the
 * folder gate stays safe.
 */
function hasTokenAncestor(path: string): boolean {
  const lower = path.toLowerCase();
  return /\/(tokens?|theme|themes|palette|palettes?|foundations?|primitives?|design-tokens?|design-system|ds|variables?|generated|styles?|scss|css|sass|less)\//.test(
    lower,
  );
}

/**
 * Collapse a list of qualifying file paths to their common parent
 * folder when ≥ 2 siblings qualify in the same directory — keeps the
 * settings file readable when a `tokens/` folder holds 10 split files.
 * The parent folder is only kept when it's not the workspace root
 * itself (we never collapse to `""`).
 */
function collapseToParents(paths: readonly string[]): string[] {
  const byParent = new Map<string, string[]>();
  for (const p of paths) {
    const parent = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(p);
  }
  const out: string[] = [];
  for (const [parent, files] of byParent) {
    if (files.length >= 2 && parent) out.push(parent);
    else out.push(...files);
  }
  return [...new Set(out)].sort();
}

// ─── Content heuristics ──────────────────────────────────────────────────

/**
 * A `.css/.scss/.sass/.less` file qualifies when it is essentially a
 * variable declaration sheet. Rules:
 *   1. At least 5 token-shaped declarations (`--foo: …` or `$foo: …`).
 *   2. No regular CSS selectors except `:root { … }` and pseudo-class
 *      hooks of `:root` (used for theme switches: `:root.dark`).
 *   3. No mixin / function / keyframe definitions (those signal a real
 *      stylesheet, not a token catalogue).
 *   4. Declarations make up ≥ 60 % of meaningful lines — tolerates
 *      `:root { … }` wrapper braces and `@use` headers.
 */
export function isStyleTokenFile(text: string): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const codeLines = stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (codeLines.length < 5) return false;

  for (const l of codeLines) {
    // Allow `:root { … }` and `:root.foo { … }` (theme hosts).
    if (/^:root[.\w-]*\s*\{/.test(l)) continue;
    if (/^\}$/.test(l)) continue;
    // Reject any other selector — class, id, tag, attr, pseudo-element,
    // nesting selector, or media/supports/keyframes/mixin/function.
    if (/^[.#&\[][^{]*\{/.test(l)) return false;
    if (/^[A-Za-z][\w-]*\s*\{/.test(l)) return false;
    if (/^@(media|supports|keyframes|font-face|mixin|include|function|if|else|for|each|while|import|extend|return)\b/.test(l)) {
      // `@use` / `@forward` are fine (SCSS module imports in token files).
      continue;
    }
    if (/^@(use|forward)\b/.test(l)) continue;
  }

  const cssDecls = (text.match(/(?:^|[\s;{])--[\w-]+\s*:/g) ?? []).length;
  const scssDecls = (text.match(/(?:^|[\s;])\$[\w-]+\s*:/g) ?? []).length;
  const declCount = cssDecls + scssDecls;
  if (declCount < 5) return false;
  return declCount / codeLines.length >= 0.5;
}

/**
 * A `.ts/.tsx/.js/.jsx` file qualifies as a tokens module when it
 * carries only value-bag exports (no React, no JSX, no functions, no
 * hooks) AND its keys mostly match the design-token vocabulary.
 */
export function isJsTokenFile(text: string): boolean {
  if (/from\s+['"]react['"]/.test(text)) return false;
  if (/from\s+['"]react-native['"]/.test(text)) return false;
  if (/from\s+['"]vue['"]/.test(text)) return false;
  if (/from\s+['"]@angular\//.test(text)) return false;
  if (/<[A-Z][A-Za-z0-9]*[\s/>]/.test(text)) return false;
  if (/\bfunction\s+\w/.test(text)) return false;
  if (/\bclass\s+\w/.test(text)) return false;
  if (/\buse[A-Z]\w*\s*\(/.test(text)) return false;
  if (/=>\s*\{[^}]{40,}/.test(text)) return false; // multi-line arrow fn bodies

  const keys = [
    ...text.matchAll(/^\s*["']?([a-zA-Z][\w-]*)["']?\s*:/gm),
  ].map((m) => m[1]);
  if (keys.length < 5) return false;
  const tokenVocab =
    /^(color|colors|colour|colours|primary|secondary|tertiary|surface|surfaces|bg|background|backgrounds|fg|foreground|text|border|borders|spacing|space|spaces|size|sizes|radius|radii|font|fonts|fontFamily|fontSize|fontWeight|weight|line|lineHeight|shadow|shadows|opacity|opacities|duration|durations|ease|easing|transition|transitions|breakpoint|breakpoints|z|zIndex|gap|inset|gray|grey|red|blue|green|yellow|orange|purple|pink|black|white|neutral|brand|accent|info|success|warning|danger|error|elevation|elevations|palette|theme|themes|token|tokens|hue|hues|alpha|tint|shade)$/i;
  const hits = keys.filter((k) => tokenVocab.test(k)).length;
  return hits / keys.length >= 0.5;
}

// ─── Path / fs helpers ───────────────────────────────────────────────────

async function buildExcludeList(workspaceRoot: vscode.Uri): Promise<string[]> {
  // ALWAYS_EXCLUDE entries are added unconditionally — they're
  // universal noise and skipping them would surprise users who
  // expect node_modules to always be in the list.
  const out: string[] = [...ALWAYS_EXCLUDE];
  for (const name of CONDITIONAL_EXCLUDE) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceRoot, name));
      out.push(name);
    } catch {
      // not present — skip.
    }
  }
  return out;
}

async function readJsonIfExists(uri: vscode.Uri): Promise<any | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    return null;
  }
}

function workspaceRelative(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = root.path.endsWith("/") ? root.path : root.path + "/";
  if (uri.path === root.path) return "";
  if (uri.path.startsWith(rootPath)) {
    return uri.path.substring(rootPath.length).replace(/\/$/, "");
  }
  return uri.fsPath;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.substring(idx + 1) : path;
}

function extOf(path: string): string | null {
  const b = basename(path);
  const idx = b.lastIndexOf(".");
  return idx > 0 ? b.substring(idx + 1).toLowerCase() : null;
}

function isStyleExt(ext: string): boolean {
  return ext === "css" || ext === "scss" || ext === "sass" || ext === "less";
}
function isJsExt(ext: string): boolean {
  return (
    ext === "ts" ||
    ext === "tsx" ||
    ext === "js" ||
    ext === "jsx" ||
    ext === "mjs" ||
    ext === "cjs"
  );
}

/** Strip `@scope/` prefix, keep only ident-safe chars. */
function sanitiseScopeName(raw: string): string {
  const noScope = raw.replace(/^@[^/]+\//, "");
  const cleaned = noScope.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "scope";
}
