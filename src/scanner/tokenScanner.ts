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

// Full glob used when a scope explicitly opts into JS/TS/JSON ingestion
// via `sourcePaths` / `rootPath` / `whitelistPaths`. The CSS/JS branch
// happens inside `scanText` based on the file extension, so we walk
// one tree and route per file — cheaper than two passes for projects
// where SCSS and TS catalogues live side by side.
const SOURCE_GLOB = "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json}";
// Stylesheet-only glob used in the legacy "no scope configured"
// fallback. Walking the entire workspace's TS/JSX tree there was the
// dominant freeze cause — a typical React project has 10x more
// components than stylesheets, and not one of those components is a
// token catalogue without explicit configuration anyway. Stylesheets
// are typically thinner and bounded, so a workspace-wide sweep stays
// cheap even without per-scope configuration.
const STYLESHEET_GLOB = "**/*.{scss,sass,css,less}";
// Heavy directories excluded from EVERY `findFiles` call (not just the
// no-scope fallback). When a user points a scope at `src` we still
// don't want to walk `src/.next` or `src/node_modules`. Mirrors what
// IntelliJ's project scope excludes by default and explains why the
// JB plugin feels markedly faster than the VSCode one used to.
const EXCLUDE_GLOB =
  "**/{node_modules,dist,out,build,coverage,.next,.nuxt,.git,.cache,.turbo,.parcel-cache,target}/**";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Yield to the event loop every this-many files so a large scan
// doesn't block the extension host. 50 keeps the per-yield budget
// around 5-15ms on typical hardware while leaving keystroke handling
// responsive between batches.
const YIELD_EVERY_N_FILES = 50;
// Cap the concurrent `readFile` count. Higher values starve the
// event loop with fs syscalls, lower values waste throughput on
// SSD-backed projects. 16 matches the IntelliJ scanner's worker
// pool size.
const READ_CONCURRENCY = 16;

interface CachedFile {
  /** Filesystem mtime in ms — keys the freshness check. */
  readonly mtime: number;
  /** Verbatim file text — needed by `resolve()` to compute variant labels. */
  readonly text: string;
  /** Per-scope raw tokens harvested from this file. */
  readonly raw: readonly RawToken[];
}

export class TokenScanner {
  private cache: DesignToken[] | null = null;
  private valueIndex: TokenValueIndex | null = null;
  // In-flight dedup. Concurrent callers (visible editors firing
  // diagnostics in parallel after an invalidate()) would otherwise each
  // start their own scan because the first `await` inside `runScan()`
  // yields before `this.cache` is filled. Storing the pending promise
  // lets every concurrent caller await the SAME scan.
  private pending: Promise<DesignToken[]> | null = null;
  // Bumped on every `invalidate()`. A `runScan()` started before the bump
  // checks this counter before writing to `cache` — a stale scan that
  // raced an invalidation MUST NOT overwrite a fresher cache.
  private generation = 0;
  // Per-file cache keyed by absolute path. Survives `invalidate()` —
  // only entries whose mtime moved are re-read on the next scan. This
  // is the single biggest perf lever on repeat scans: a workspace-wide
  // invalidation now reduces to `stat()` calls on unchanged files
  // (~ms per 100 files) instead of `readFile()` + regex.
  private fileCache = new Map<string, CachedFile>();
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

  scan(): Promise<DesignToken[]> {
    if (this.cache) return Promise.resolve(this.cache);
    if (this.pending) return this.pending;
    this.pending = this.runScan().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async runScan(): Promise<DesignToken[]> {
    const startGeneration = this.generation;
    const raw: RawToken[] = [];
    const textCache = new Map<string, string>();
    const seen = new Set<string>();
    const scopes = readScopes();
    // Track which paths are still referenced by an active scope. Paths
    // that fell out of every scope's coverage (file deleted, scope
    // shrunk) get pruned from `fileCache` at the end of the scan so
    // memory doesn't grow forever across long sessions.
    const referenced = new Set<string>();
    // Files we've stat-checked but found unchanged — their cached
    // tokens get re-emitted directly. Counter used purely for the
    // yield cadence so we don't pump events too aggressively when the
    // scan is just walking a warm cache.
    let processed = 0;

    const ingestBatch = async (
      uris: readonly vscode.Uri[],
      scope: string,
      external: boolean,
    ): Promise<void> => {
      for (let i = 0; i < uris.length; i += READ_CONCURRENCY) {
        const slice = uris.slice(i, i + READ_CONCURRENCY);
        await Promise.all(
          slice.map((uri) => {
            if (seen.has(uri.fsPath)) return Promise.resolve();
            seen.add(uri.fsPath);
            referenced.add(uri.fsPath);
            return this.ingestFile(uri, scope, external, raw, textCache);
          }),
        );
        processed += slice.length;
        if (processed >= YIELD_EVERY_N_FILES) {
          processed = 0;
          // Cooperative yield: hands the event loop back so VSCode can
          // service keystrokes / commands between batches.
          await new Promise<void>((resolve) => setImmediate(resolve));
          // Mid-scan invalidation? Bail early — generation guard at the
          // end will prevent the stale result from being committed.
          if (this.generation !== startGeneration) return;
        }
      }
    };

    for (const scope of scopes) {
      if (this.generation !== startGeneration) break;
      const sourceFiles = await this.resolveScopeFiles(scope);
      await ingestBatch(sourceFiles, scope.name, /* external */ false);
      if (scope.whitelistPaths.length > 0) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) {
          const wlFiles = await this.resolveSourcePaths(
            root,
            scope.whitelistPaths,
          );
          await ingestBatch(wlFiles, scope.name, /* external */ true);
        }
      }
    }

    // Prune cache entries for files no longer covered by any scope.
    // Keeps memory bounded on long-lived hosts.
    if (referenced.size > 0) {
      for (const key of this.fileCache.keys()) {
        if (!referenced.has(key)) this.fileCache.delete(key);
      }
    }

    const resolved = this.resolve(raw, textCache);
    if (this.generation === startGeneration) {
      this.cache = resolved;
    }
    return resolved;
  }

  /**
   * Reads + scans a single file. Uses the mtime-keyed cache so an
   * unchanged file pays only a `stat()` on repeat scans instead of a
   * full `readFile` + regex pass — the dominant cost on warm scans.
   *
   * The cached entry stores both the raw tokens AND the file text so
   * `resolve()` can still compute variant labels (`describeAt`) without
   * re-reading from disk. Memory cost is bounded by the workspace's
   * token-file count (typically dozens, not thousands), so the trade
   * is favourable.
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
      const cached = this.fileCache.get(uri.fsPath);
      if (cached && cached.mtime === stat.mtime) {
        textCache.set(uri.fsPath, cached.text);
        for (const t of cached.raw) raw.push(t);
        return;
      }
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      textCache.set(uri.fsPath, text);
      const before = raw.length;
      this.scanText(text, uri.fsPath, scope, external, raw);
      // Snapshot the tokens this file contributed so a later scan
      // can replay them without re-running the regex/parser.
      this.fileCache.set(uri.fsPath, {
        mtime: stat.mtime,
        text,
        raw: raw.slice(before),
      });
    } catch {
      // Unreadable file — drop it from the cache too so a subsequent
      // create event re-ingests cleanly.
      this.fileCache.delete(uri.fsPath);
    }
  }

  /**
   * Resolves the set of files a scope owns. Three layers, top-down:
   *   1. Explicit `sourcePaths` win — file or directory list expanded
   *      with `findFiles`.
   *   2. Otherwise a non-empty `rootPath` scans recursively inside it.
   *   3. Otherwise (implicit common scope, no paths) the whole
   *      workspace is swept for **stylesheets only**. The JS/TS/JSON
   *      pipeline used to also run here, which on a typical React
   *      project meant the scanner crawled every component file in
   *      `src/` — the dominant cause of extension-host freezes on
   *      no-scope projects. JS token catalogues are inherently
   *      explicit by convention (one or two files at known paths),
   *      so requiring the user to declare them via `sourcePaths` or
   *      `rootPath` costs nothing in real workflows and avoids the
   *      blow-up.
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
        return await vscode.workspace.findFiles(
          new vscode.RelativePattern(rootUri, SOURCE_GLOB),
          EXCLUDE_GLOB,
        );
      } catch {
        return [];
      }
    }
    // Implicit common scope: stylesheets only. See class docstring.
    return vscode.workspace.findFiles(STYLESHEET_GLOB, EXCLUDE_GLOB);
  }

  invalidate(): void {
    this.cache = null;
    this.valueIndex = null;
    // Drop the pending reference too — its result reflects state from
    // before the invalidation. The generation bump prevents any
    // already-running scan from committing its stale result into
    // `cache` once it eventually resolves.
    this.pending = null;
    this.generation++;
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
            EXCLUDE_GLOB,
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
