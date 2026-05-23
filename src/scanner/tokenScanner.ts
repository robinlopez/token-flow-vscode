// Port of `TokenScanner.kt`. Builds an in-memory index of every design
// token in the workspace by globbing source files and running the same
// regexes / parsers as the IntelliJ plugin. Resolution of aliases
// (SCSS `$x`, `var(--y)`, Style-Dictionary `{a.b.c}`) happens once
// after the raw scan.
//
// Two pipelines feed `raw`:
//   • CSS/SCSS — regex-based `scanText` (in this file).
//   • JS/TS/JSON — `parseJsTokenFileFull` dispatcher in `parsers/`.
// Phase 1 wires the JS pipeline as a dormant pass-through: every parser
// slot returns `[]` until Phase 2+ fills them in. The plumbing here is
// stable, so individual parsers can land independently without touching
// this orchestrator again.

import * as vscode from "vscode";
import {
  CSS_VAR_CALL_REGEX,
  CSS_VAR_REGEX,
  JS_OBJECT_ALIAS_REGEX,
  JS_RUNTIME_ALIAS_REGEX,
  SCSS_ALIAS_REGEX,
  SCSS_MAP_KEY_REGEX,
  SCSS_VAR_REGEX,
} from "./regexes";
import { modeSegmentOf, stripModeSegment } from "./tokenNameParser";
import { describeAt } from "./declarationContext";
import { categorize } from "./tokenCategorizer";
import { TokenValueIndex } from "./tokenValueIndex";
import {
  DesignToken,
  TokenKind,
  TokenVariant,
} from "../model/designToken";
import { ConfiguredScope, COMMON_SCOPE_NAME, readScopes } from "../settings/scopes";
import {
  isJsTokenFile,
  parseJsTokenFileFull,
} from "./parsers/jsTokenFileParserRegistry";
// Side-effect import: every parser file in the barrel self-registers
// into the dispatcher at module-load. Without this line the dispatcher
// still resolves but only the Phase-1 no-op parsers are wired, and the
// scanner gets zero leaves out of JS/TS files even when the real
// parser code is present in the bundle.
import "./parsers";

interface RawToken {
  readonly name: string; // `$foo` or `--foo`
  readonly rawValue: string;
  readonly kind: TokenKind;
  readonly filePath: string;
  readonly offset: number;
  /** Scope this raw token was harvested under — copied verbatim to the resolved DesignToken. */
  readonly scope: string;
  /** True when the token came from a whitelist path (external library). */
  readonly external: boolean;
  /**
   * Only populated for JS_RUNTIME_FUNCTION helpers. Carries the
   * numeric multiplier so the resolver can compute `spacing(scale)`
   * call values: `value = unit × scale`. Other kinds leave this null.
   */
  readonly functionUnit?: number;
}

// Single glob for both pipelines. The CSS/JS branch happens inside
// `scanText` based on the file extension, so we walk one tree and
// route per file — cheaper than two passes for projects where SCSS
// and TS catalogues live side by side.
const SOURCE_GLOB = "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json}";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class TokenScanner {
  private cache: DesignToken[] | null = null;
  private valueIndex: TokenValueIndex | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * `value → tokens` index used by the hardcoded-value diagnostics.
   * Built lazily alongside `cache` so a single workspace scan feeds
   * every downstream consumer.
   */
  async getValueIndex(): Promise<TokenValueIndex> {
    if (!this.valueIndex) {
      const tokens = await this.scan();
      this.valueIndex = new TokenValueIndex(tokens);
    }
    return this.valueIndex;
  }

  async scan(): Promise<DesignToken[]> {
    if (this.cache) return this.cache;
    const raw: RawToken[] = [];
    // File texts read during the scan are kept around so `describeAt`
    // (called by `resolve`) doesn't have to re-read them from disk. Critical
    // for the multi-theme grouping: the primary token's declaration chain
    // is recovered from this cache.
    const textCache = new Map<string, string>();
    // A given physical file is processed by at most one scope (whichever
    // scope claims it first wins). The seen-set keeps the cost linear in
    // the workspace, not in scopes × files.
    const seen = new Set<string>();
    const scopes = readScopes();

    for (const scope of scopes) {
      // Source files (project's own tokens) — flagged external=false.
      const sourceFiles = await this.resolveScopeFiles(scope);
      for (const uri of sourceFiles) {
        if (seen.has(uri.fsPath)) continue;
        seen.add(uri.fsPath);
        await this.ingestFile(uri, scope.name, /* external */ false, raw, textCache);
      }
      // Whitelist files (external/known library tokens) — same indexing
      // pipeline but tagged external=true so downstream consumers can
      // tell project tokens from third-party ones.
      if (scope.whitelistPaths.length > 0) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) {
          const wlFiles = await this.resolveSourcePaths(root, scope.whitelistPaths);
          for (const uri of wlFiles) {
            if (seen.has(uri.fsPath)) continue;
            seen.add(uri.fsPath);
            await this.ingestFile(uri, scope.name, /* external */ true, raw, textCache);
          }
        }
      }
    }
    this.cache = this.resolve(raw, textCache);
    return this.cache;
  }

  /**
   * Reads + scans a single file. Centralised here so source and
   * whitelist passes share the same MAX_FILE_BYTES guard and silent
   * skip-on-error behaviour.
   */
  private async ingestFile(
    uri: vscode.Uri,
    scope: string,
    external: boolean,
    raw: RawToken[],
    textCache: Map<string, string>,
  ): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return;
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      textCache.set(uri.fsPath, text);
      this.scanText(text, uri.fsPath, scope, external, raw);
    } catch {
      // Unreadable file — skip silently, like the IntelliJ side does.
    }
  }

  /**
   * Resolves the set of files a scope owns. Three layers, top-down:
   *   1. Explicit `sourcePaths` win — file or directory list expanded
   *      with `findFiles`.
   *   2. Otherwise a non-empty `rootPath` scans recursively inside it.
   *   3. Otherwise (common scope, no paths) the whole workspace is
   *      scanned — preserves the day-one "no config" behaviour.
   */
  private async resolveScopeFiles(
    scope: ConfiguredScope,
  ): Promise<vscode.Uri[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return [];

    if (scope.sourcePaths.length > 0) {
      return this.resolveSourcePaths(root, scope.sourcePaths);
    }
    if (scope.rootPath) {
      try {
        const rootUri = vscode.Uri.joinPath(root, scope.rootPath);
        // SOURCE_GLOB already starts with `**/` which, in a
        // RelativePattern, recurses into subdirectories of the base.
        // Earlier code stripped the prefix here — that was a bug:
        // findFiles then matched only top-level files of the
        // rootPath, silently dropping nested catalogues like
        // `tokens/primitives/*.ts`. Pass the glob verbatim.
        return await vscode.workspace.findFiles(
          new vscode.RelativePattern(rootUri, SOURCE_GLOB),
        );
      } catch {
        return [];
      }
    }
    // No scope-level paths configured — fall back to a workspace-wide
    // sweep. Per the design call ("Uniquement sourcePaths"), this only
    // fires for the implicit common scope with empty config; once the
    // user sets up real sourcePaths the broad sweep is skipped.
    return vscode.workspace.findFiles(SOURCE_GLOB, "**/node_modules/**");
  }

  invalidate(): void {
    this.cache = null;
    this.valueIndex = null;
    this._onDidChange.fire();
  }

  private async resolveSourcePaths(
    root: vscode.Uri,
    paths: readonly string[],
  ): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    for (const rel of paths) {
      const uri = vscode.Uri.joinPath(root, rel);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          // Recurse into subdirectories — see the comment in
          // resolveScopeFiles for why the `**/` prefix matters here.
          const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(uri, SOURCE_GLOB),
          );
          out.push(...found);
        } else {
          out.push(uri);
        }
      } catch {
        // Path doesn't exist — skip.
      }
    }
    return out;
  }

  private scanText(
    text: string,
    filePath: string,
    scope: string,
    external: boolean,
    sink: RawToken[],
  ): void {
    // JS/TS/JSON files go through the dedicated parser pipeline. The
    // dispatcher decides per-file whether it's a Style-Dictionary
    // preset (emits JS_OBJECT_PATH) or a runtime theme (emits
    // JS_RUNTIME_PROPERTY + helpers). In Phase 1 both parser slots
    // are no-ops, so this branch returns nothing — but the wiring is
    // in place so a real parser can ship without touching this file.
    if (isJsTokenFile(filePath)) {
      const result = parseJsTokenFileFull(text, filePath);
      const leafKind: TokenKind =
        result.mode === "STYLE_DICTIONARY"
          ? "JS_OBJECT_PATH"
          : "JS_RUNTIME_PROPERTY";
      for (const leaf of result.leaves) {
        sink.push({
          name: leaf.path,
          rawValue: leaf.value,
          kind: leafKind,
          filePath,
          offset: leaf.offset,
          scope,
          external,
        });
      }
      for (const helper of result.helpers) {
        // Helpers carry their multiplier on `functionUnit`. The
        // rawValue is the human-readable formula (`spacingUnit × v`)
        // — matches the IntelliJ display and lets the Library row's
        // "value" column read as a real expression instead of a
        // bare number. Resolution at call sites (`spacing(2) → 16`)
        // is computed by consumers from `functionUnit` + the call's
        // argument; the scanner stays a pure indexer.
        sink.push({
          name: helper.name,
          rawValue: `${helper.unitSource} × ${helper.paramName}`,
          kind: "JS_RUNTIME_FUNCTION",
          filePath,
          offset: helper.offset,
          scope,
          external,
          functionUnit: helper.unit,
        });
      }
      return;
    }

    // SCSS top-level $vars (anchored at line start).
    if (filePath.endsWith(".scss") || filePath.endsWith(".sass")) {
      for (const m of text.matchAll(SCSS_VAR_REGEX)) {
        sink.push({
          name: "$" + m[1],
          rawValue: m[2].trim(),
          kind: "SCSS_VARIABLE",
          filePath,
          offset: m.index ?? 0,
          scope,
          external,
        });
      }
      // SCSS map keys — `"name": value,`
      for (const m of text.matchAll(SCSS_MAP_KEY_REGEX)) {
        sink.push({
          name: "--" + m[1],
          rawValue: m[2].trim(),
          kind: "CSS_CUSTOM_PROPERTY",
          filePath,
          offset: m.index ?? 0,
          scope,
          external,
        });
      }
    }
    // CSS custom properties — anywhere.
    for (const m of text.matchAll(CSS_VAR_REGEX)) {
      sink.push({
        name: "--" + m[1],
        rawValue: m[2].trim().replace(/;$/, "").trim(),
        kind: "CSS_CUSTOM_PROPERTY",
        filePath,
        offset: m.index ?? 0,
        scope,
        external,
      });
    }
  }

  /**
   * Group raw declarations by name (preserving source order), promote the
   * first occurrence to the primary, and turn the rest into variants tagged
   * with their declaration context.
   */
  private resolve(
    raw: RawToken[],
    textCache: Map<string, string>,
  ): DesignToken[] {
    // For JS_OBJECT_PATH tokens carrying a `modeLight` / `modeDark`
    // segment, group by the mode-stripped canonical name. Sibling
    // mode declarations otherwise look like unrelated tokens and the
    // dashboard would render them as duplicates instead of two
    // columns of the same logical token. Every other kind keeps its
    // verbatim name as the group key.
    const grouped = new Map<string, RawToken[]>();
    for (const t of raw) {
      const key =
        t.kind === "JS_OBJECT_PATH"
          ? stripModeSegment(t.name) ?? t.name
          : t.name;
      const list = grouped.get(key) ?? [];
      list.push(t);
      grouped.set(key, list);
    }

    // Alias-resolution index — uses the primary value. Keyed by both
    // the canonical name and the original (mode-bearing) name so a
    // `{a.modeLight.b}` alias still hits when the index entry was
    // promoted to the canonical `a.b`.
    const firstByName = new Map<string, RawToken>();
    for (const [name, list] of grouped) firstByName.set(name, list[0]);
    for (const t of raw) {
      if (!firstByName.has(t.name)) firstByName.set(t.name, t);
    }

    const textOf = (path: string): string => textCache.get(path) ?? "";

    const out: DesignToken[] = [];
    for (const [name, list] of grouped) {
      const primary = list[0];
      const resolvedValue = resolveValue(
        primary.rawValue,
        firstByName,
        new Set([primary.name]),
      );
      const variants = buildVariants(list, textOf, primary, firstByName);
      // Primary column header logic mirrors the IntelliJ TokenScanner:
      //   • JS_OBJECT_PATH whose name carries a mode segment surfaces
      //     the mode (`light` / `dark`) so the variant table groups
      //     by it cleanly.
      //   • CSS / SCSS surface their declaration context (e.g.
      //     `:root.dark @media …`) — same as before.
      //   • Runtime kinds keep the default "default" header.
      let primaryLabel: string | null = null;
      if (primary.kind === "JS_OBJECT_PATH") {
        primaryLabel = modeSegmentOf(primary.name);
      } else if (
        primary.kind === "CSS_CUSTOM_PROPERTY" ||
        primary.kind === "SCSS_VARIABLE"
      ) {
        primaryLabel =
          describeAt(textOf(primary.filePath), primary.offset).trim() || null;
      }
      out.push({
        name,
        rawValue: primary.rawValue,
        resolvedValue,
        category: categorize(name, resolvedValue),
        kind: primary.kind,
        filePath: primary.filePath,
        offset: primary.offset,
        variants,
        primaryConditionLabel: primaryLabel,
        // Helper multiplier (only set for JS_RUNTIME_FUNCTION).
        // Carried through from the parser via RawToken.functionUnit;
        // null for every other kind.
        functionUnit: primary.functionUnit ?? null,
        scope: primary.scope || COMMON_SCOPE_NAME,
        external: primary.external,
      });
    }
    return out;
  }
}

function buildVariants(
  group: RawToken[],
  textOf: (path: string) => string,
  primary: RawToken,
  firstByName: Map<string, RawToken>,
): TokenVariant[] {
  const out: TokenVariant[] = [];
  const seen = new Set<string>();
  // JS_OBJECT_PATH mode group: non-primary entries are other modes of
  // the same logical token. Label them with their mode (`dark`) and
  // resolve their value through the alias chain so the variant table
  // renders the final hex, not the `{…}` alias.
  const isJsMode =
    primary.kind === "JS_OBJECT_PATH" && modeSegmentOf(primary.name) !== null;
  for (let i = 1; i < group.length; i++) {
    const v = group[i];
    let condition: string;
    let value: string;
    if (isJsMode) {
      condition = modeSegmentOf(v.name) ?? "(top level)";
      value = resolveValue(v.rawValue, firstByName, new Set([v.name]));
    } else {
      condition =
        describeAt(textOf(v.filePath), v.offset).trim() || "(top level)";
      value = v.rawValue;
    }
    const key = condition + "|" + value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ condition, value });
  }
  return out;
}

function resolveValue(
  value: string,
  index: Map<string, RawToken>,
  seen: Set<string>,
): string {
  // 1. SCSS alias — `$foo`.
  const scssAlias = value.match(SCSS_ALIAS_REGEX);
  if (scssAlias) {
    const ref = "$" + scssAlias[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      const target = index.get(ref);
      if (target) return resolveValue(target.rawValue, index, seen);
    }
  }
  // 2. CSS alias — `var(--foo)`.
  const cssAlias = value.match(CSS_VAR_CALL_REGEX);
  if (cssAlias) {
    const ref = "--" + cssAlias[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      const target = index.get(ref);
      if (target) return resolveValue(target.rawValue, index, seen);
    }
  }
  // 3. Runtime property-access alias — `colors.PRIMARY_500`. Bare JS
  //    identifier expression (no braces). The full match itself is the
  //    referenced token name.
  const runtimeAlias = value.match(JS_RUNTIME_ALIAS_REGEX);
  if (runtimeAlias) {
    const ref = runtimeAlias[0];
    if (!seen.has(ref)) {
      seen.add(ref);
      const target = index.get(ref);
      if (target) return resolveValue(target.rawValue, index, seen);
    }
  }
  // 4. Style-Dictionary alias — `{a.b.c}`. Goes through three
  //    progressively looser lookups before giving up:
  //      a. exact name
  //      b. mode-segment stripped (`primitive.modeLight.x` → `primitive.x`)
  //      c. lead-segment strip (`primitive.neutral.700` → `neutral.700` → `700`)
  //      d. suffix match (any indexed name ending in `.ref` or equal to it)
  const jsAlias = value.match(JS_OBJECT_ALIAS_REGEX);
  if (jsAlias) {
    const ref = jsAlias[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      // (a) exact.
      const target = index.get(ref);
      if (target) return resolveValue(target.rawValue, index, seen);

      // (b) mode-stripped retry.
      const canonical = stripModeSegment(ref);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        const t = index.get(canonical);
        if (t) return resolveValue(t.rawValue, index, seen);
      }

      // (c) lead-segment strip — JsObjectTokenParser does NOT prefix
      // emitted paths with the `export const NAME` identifier, so an
      // alias `{primitive.neutral.700}` whose target file is
      // `export const primitive = { neutral: { 700: '#fff' } }` ends
      // up indexed under `neutral.700`. Drop leading segments until
      // a match (or exhaustion) hits.
      const segs = ref.split(".");
      for (let skip = 1; skip < segs.length; skip++) {
        const sub = segs.slice(skip).join(".");
        if (seen.has(sub)) continue;
        seen.add(sub);
        const t = index.get(sub);
        if (t) return resolveValue(t.rawValue, index, seen);
      }

      // (d) Reverse mode-strip — when the alias points at a name
      //     WITHOUT a mode segment but the indexed entry CARRIES one
      //     (typical of JS_RUNTIME_PROPERTY tokens which keep their
      //     binding verbatim and don't get the canonical grouping
      //     that JS_OBJECT_PATH benefits from). Iterate the index
      //     once, accept the first entry whose mode-stripped name
      //     equals `ref`. Linear but rare to hit — the prior cheaper
      //     paths cover the common cases.
      const modeHit = reverseModeStripMatch(ref, index);
      if (modeHit && !seen.has(modeHit.name)) {
        seen.add(modeHit.name);
        return resolveValue(modeHit.rawValue, index, seen);
      }

      // (e) suffix-match fallback — last resort, also linear. Only
      //     acceptable because the seen-set short-circuits repeat
      //     lookups on the same chain.
      const hit = jsAliasSuffixMatch(ref, index);
      if (hit) return resolveValue(hit.rawValue, index, seen);
    }
  }
  return value;
}

/**
 * Inverse of `stripModeSegment`: given an alias `ref` that does NOT
 * carry a mode, find an indexed token whose name carries one but
 * whose mode-stripped form matches `ref`. Solves the recurring
 * "primitive.neutral.400 referenced from a typed theme, primitive
 * itself indexed as primitive.modeLight.neutral.400" case.
 */
function reverseModeStripMatch(
  ref: string,
  index: Map<string, RawToken>,
): RawToken | null {
  for (const [k, v] of index) {
    if (k === ref) continue;
    if (stripModeSegment(k) === ref) return v;
  }
  return null;
}

/**
 * PrimeUIX / Style-Dictionary presets sometimes alias a SHORTER path
 * that addresses the leaf via the last few segments only. Look up the
 * first indexed token whose name ends with `.ref` (or equals `ref`).
 */
function jsAliasSuffixMatch(
  ref: string,
  index: Map<string, RawToken>,
): RawToken | null {
  const needle = "." + ref;
  for (const [k, v] of index) {
    if (k === ref || k.endsWith(needle)) return v;
  }
  return null;
}
