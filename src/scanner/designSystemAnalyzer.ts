// Port of `DesignSystemAnalyzer.kt` (IntelliJ side). Walks every
// stylesheet / JS-token file in the workspace once and produces a
// single [AnalysisReport] consumed by the Analyse dashboard.
//
// Sub-axes computed (each 0..100, weighted into the global score):
//   • Semantic coherence — name says one thing, value says another.
//   • Usage coverage     — tokenised refs vs hardcoded literals.
//   • Duplication        — multiple tokens resolving to the same value.
//   • Hardcoded pressure — count of repeated literals worth tokenising.
//   • Reference integrity — broken `var(--…)` / `'{…}'` refs.
//
// Scope handling mirrors `ScopeResolver.activeScopesFor` on the
// IntelliJ side: when [scopeFile] is set the coverage walk restricts
// itself to the active scopes' rootPaths (minus excludedPaths), and
// only project tokens owned by those scopes are counted toward
// project-health metrics. When [scopeFile] is null, every scope is in
// play (whole-project analysis).
//
// Differences vs the IntelliJ port (out of scope for v1 parity):
//   • No Vue <style> block extraction (works file-wide instead).
//   • No `DynamicCssVarIndex` (runtime-injected CSS vars).

import * as vscode from "vscode";
import { TokenScanner } from "./tokenScanner";
import { DynamicCssVarIndex } from "./dynamicCssVarIndex";
import { findLiterals, LiteralKind } from "./literalFinder";
import { TokenValueIndex } from "./tokenValueIndex";
import { resolveReference } from "./tokenNameParser";
import { findSuggestions } from "./findSuggestions";
import { getExpectedRoleForProperty } from "../model/semantics";
import { DesignToken, TokenCategory } from "../model/designToken";
import {
  activeScopesFor,
  ConfiguredScope,
  readScopes,
} from "../settings/scopes";

const COVERAGE_GLOB = "**/*.{scss,sass,css,less,ts,tsx,js,jsx,mjs,cjs,json,vue}";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MIN_HARDCODED_CLUSTER = 2;
const MAX_HARDCODED_CLUSTERS = 50;

// ─── Public types ───────────────────────────────────────────────────────

export type Axis =
  | "SEMANTIC_COHERENCE"
  | "USAGE_COVERAGE"
  | "DUPLICATION"
  // Split parity with IntelliJ #19 — replaces the legacy
  // HARDCODED_PRESSURE axis with two:
  //   • OPPORTUNITY (weight 15, x1) — repeated literal, no token exists
  //   • DEBT        (weight 10, x2) — token exists; fix is mechanical
  | "HARDCODED_OPPORTUNITY"
  | "HARDCODED_DEBT"
  | "REFERENCE_INTEGRITY";

export interface SubScore {
  readonly axis: Axis;
  readonly score: number;
  readonly weight: number;
  readonly caption: string;
}

export interface Incoherence {
  readonly token: DesignToken;
  readonly expectedCategory: TokenCategory;
  readonly actualCategory: TokenCategory;
  readonly rationale: string;
}

export interface DuplicateCluster {
  readonly resolvedValue: string;
  readonly category: TokenCategory;
  readonly tokens: readonly DesignToken[];
  readonly suggestedCanonical: DesignToken;
}

export interface HardcodedOccurrence {
  readonly filePath: string;
  readonly offset: number;
  readonly line: number;
}

export interface HardcodedCluster {
  readonly literal: string;
  readonly category: TokenCategory | null;
  readonly occurrences: readonly HardcodedOccurrence[];
  readonly matchingTokenName: string | null;
}

/**
 * Literal repeated across the codebase whose token **already exists**
 * in the active scope's design system. Mirror of IntelliJ's
 * `HardcodedValue` — actionable debt, the fix is mechanical.
 *
 * Bucketing key is `(literal + category)`, so `12px` used as `padding`
 * (SPACING) and `12px` used as `font-size` (TYPOGRAPHY) show up as two
 * separate rows, each carrying their own role-aware suggestion.
 */
export interface HardcodedValue {
  readonly literal: string;
  readonly category: TokenCategory | null;
  readonly suggestedToken: DesignToken | null;
  readonly occurrences: readonly HardcodedOccurrence[];
}

export interface BrokenReference {
  readonly name: string;
  readonly filePath: string;
  readonly offset: number;
  readonly line: number;
}

export interface TokenSourceUsage {
  readonly filePath: string;
  readonly declared: number;
  readonly used: number;
  readonly ratio: number;
}

export interface Coverage {
  readonly tokenisedAssignments: number;
  readonly literalAssignments: number;
  readonly ratio: number;
  readonly sources: readonly TokenSourceUsage[];
}

export interface AnalysisReport {
  readonly score: number;
  readonly grade: string;
  readonly subScores: readonly SubScore[];
  readonly incoherences: readonly Incoherence[];
  readonly duplicateClusters: readonly DuplicateCluster[];
  readonly hardcodedClusters: readonly HardcodedCluster[];
  readonly hardcodedValues: readonly HardcodedValue[];
  readonly coverage: Coverage;
  readonly brokenReferences: readonly BrokenReference[];
  readonly unusedTokens: readonly DesignToken[];
  readonly totalTokens: number;
  readonly scannedFiles: number;
  readonly tookMs: number;
}

export interface AnalyzeOptions {
  /** Absolute path of a representative file inside the scope to analyse,
   *  or null for "all project". Mirrors the IntelliJ `scopeFile` param. */
  readonly scopeFile?: string | null;
}

// ─── Entry point ────────────────────────────────────────────────────────

export async function analyzeDesignSystem(
  scanner: TokenScanner,
  dynamicCssVarIndex: DynamicCssVarIndex,
  opts: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  const started = Date.now();
  const allTokens = await scanner.scan();
  const valueIndex = new TokenValueIndex(allTokens);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const rootPath = root?.path ?? null;
  const scopes = readScopes();
  // Pick the scopes in play for this run. `null` (the bare scanner case
  // with no configured scopes) means the legacy "scan the whole
  // workspace" behaviour — same as IntelliJ.
  const activeScopes =
    scopes.length === 0
      ? []
      : activeScopesFor(scopes, rootPath, opts.scopeFile ?? null);

  // Project-health metrics ignore external (whitelisted) tokens AND
  // tokens that don't belong to the active scopes when a scope is
  // selected.
  const tokens = filterTokensByScope(allTokens, activeScopes).filter(
    (t) => !t.external,
  );

  const incoherences = detectIncoherences(tokens);
  const duplicateClusters = detectDuplicates(tokens);

  await dynamicCssVarIndex.ensureReady();
  const coverageScan = await computeCoverage(allTokens, rootPath, activeScopes, dynamicCssVarIndex);

  const unusedTokens = tokens
    .filter((t) => !coverageScan.referencedNames.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { clusters: hardcodedClusters, values: hardcodedValues } =
    collectHardcodedScan(coverageScan.literalsByFile, valueIndex, tokens);

  const subScores = computeSubScores({
    totalTokens: tokens.length,
    incoherences,
    duplicateClusters,
    coverage: coverageScan.coverage,
    hardcodedClusters,
    hardcodedValues,
    brokenCount: coverageScan.brokenReferences.length,
  });
  const score = weightedAverage(subScores);

  return {
    score,
    grade: gradeFor(score),
    subScores,
    incoherences,
    duplicateClusters,
    hardcodedClusters,
    hardcodedValues,
    coverage: coverageScan.coverage,
    brokenReferences: coverageScan.brokenReferences,
    unusedTokens,
    totalTokens: tokens.length,
    scannedFiles: coverageScan.scannedFiles,
    tookMs: Date.now() - started,
  };
}

function filterTokensByScope(
  tokens: readonly DesignToken[],
  activeScopes: readonly ConfiguredScope[],
): DesignToken[] {
  if (activeScopes.length === 0) return [...tokens];
  const activeNames = new Set(activeScopes.map((s) => s.name));
  return tokens.filter((t) => activeNames.has(t.scope));
}

// ─── Incoherence detection ──────────────────────────────────────────────

type ValueFamily = "COLOR" | "LENGTH" | "DURATION" | "SHADOW" | "NUMBER";

const VALUE_FAMILY_HINT: Record<ValueFamily, TokenCategory> = {
  COLOR: "COLOR",
  LENGTH: "SPACING",
  DURATION: "DURATION",
  SHADOW: "SHADOW",
  NUMBER: "Z_INDEX",
};

const COLOR_NAME_RE =
  /(?<![a-z])(color|colour|fill|tint|shade|palette|swatch)(?![a-z])|(?<![a-z])stroke(?!-(width|size|weight|opacity))/i;
const DURATION_NAME_RE = /(?<![a-z])(duration|delay|easing|ease)(?![a-z])/i;
const SHADOW_NAME_RE = /(?<![a-z])(shadow|elevation)(?![a-z])/i;
const ZINDEX_NAME_RE = /(?<![a-z])(z-?index|layer|stack-?level)(?![a-z])/i;

const HEX_VALUE_RE = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_VALUE_RE =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const DURATION_VALUE_RE = /^-?\d*\.?\d+(?:ms|s)$/;
const SHADOW_VALUE_RE = /\d+(?:\.\d+)?(?:px|rem|em)\s+\d+(?:\.\d+)?(?:px|rem|em)/;
const LENGTH_VALUE_RE = /^-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch|ex)$/;
const NUMBER_VALUE_RE = /^-?\d+(?:\.\d+)?$/;

const CSS_KEYWORDS = new Set([
  "inherit",
  "initial",
  "unset",
  "auto",
  "none",
  "transparent",
  "currentcolor",
  "normal",
  "revert",
  "revert-layer",
]);

function detectIncoherences(tokens: readonly DesignToken[]): Incoherence[] {
  const out: Incoherence[] = [];
  for (const token of tokens) {
    const expected = expectedFamilyFromName(token.name);
    if (!expected) continue;
    const raw = token.resolvedValue.trim();
    if (!raw || isUnresolvedReference(raw) || CSS_KEYWORDS.has(raw.toLowerCase()))
      continue;
    const actual = valueFamily(raw);
    if (!actual) continue;
    if (expected.has(actual)) continue;
    if (categoryMatchesValueFamily(token.category, actual)) continue;
    out.push({
      token,
      expectedCategory: VALUE_FAMILY_HINT[expected.values().next().value as ValueFamily],
      actualCategory: VALUE_FAMILY_HINT[actual],
      rationale: describeMismatch(expected, actual, raw),
    });
  }
  return out.sort((a, b) => a.token.name.localeCompare(b.token.name));
}

function expectedFamilyFromName(name: string): Set<ValueFamily> | null {
  const n = name.toLowerCase().replace(/^[-$]+/, "");
  if (COLOR_NAME_RE.test(n)) return new Set(["COLOR"]);
  if (DURATION_NAME_RE.test(n)) return new Set(["DURATION"]);
  if (SHADOW_NAME_RE.test(n)) return new Set(["SHADOW", "LENGTH"]);
  if (ZINDEX_NAME_RE.test(n)) return new Set(["NUMBER"]);
  return null;
}

function valueFamily(value: string): ValueFamily | null {
  const v = value.trim();
  if (COLOR_VALUE_RE.test(v) || HEX_VALUE_RE.test(v)) return "COLOR";
  if (DURATION_VALUE_RE.test(v)) return "DURATION";
  if (SHADOW_VALUE_RE.test(v)) return "SHADOW";
  if (LENGTH_VALUE_RE.test(v)) return "LENGTH";
  if (NUMBER_VALUE_RE.test(v)) return "NUMBER";
  return null;
}

function categoryMatchesValueFamily(
  category: TokenCategory,
  family: ValueFamily,
): boolean {
  switch (family) {
    case "COLOR":
      return category === "COLOR";
    case "DURATION":
      return category === "DURATION";
    case "SHADOW":
      return category === "SHADOW";
    case "NUMBER":
      return category === "Z_INDEX" || category === "OPACITY";
    case "LENGTH":
      return (
        category === "SPACING" ||
        category === "RADIUS" ||
        category === "SIZING" ||
        category === "TYPOGRAPHY" ||
        category === "BORDER" ||
        category === "LAYOUT" ||
        category === "EFFECTS"
      );
  }
}

function isUnresolvedReference(v: string): boolean {
  return (
    v.startsWith("var(") ||
    v.startsWith("$") ||
    v.startsWith("{") ||
    v.includes("#{")
  );
}

function describeMismatch(
  expected: Set<ValueFamily>,
  actual: ValueFamily,
  raw: string,
): string {
  const want = [...expected].map((v) => v.toLowerCase()).join("/");
  const snippet = raw.length > 40 ? raw.substring(0, 40) : raw;
  return `Name implies a ${want} value but the resolved value is ${actual.toLowerCase()} (\`${snippet}\`).`;
}

// ─── Duplicate detection ────────────────────────────────────────────────

function detectDuplicates(
  tokens: readonly DesignToken[],
): DuplicateCluster[] {
  const grouped = new Map<string, DesignToken[]>();
  for (const t of tokens) {
    if (!t.resolvedValue.trim()) continue;
    const key = fullValueSignature(t);
    const list = grouped.get(key) ?? [];
    list.push(t);
    grouped.set(key, list);
  }

  const out: DuplicateCluster[] = [];
  for (const [key, list] of grouped) {
    if (!key || list.length < 2) continue;
    const distinctFiles = new Set(list.map((t) => t.filePath));
    if (distinctFiles.size < 2) continue;
    let canonical = list[0];
    for (const t of list)
      if (t.name.length < canonical.name.length) canonical = t;
    out.push({
      resolvedValue: list[0].resolvedValue,
      category: list[0].category,
      tokens: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      suggestedCanonical: canonical,
    });
  }
  return out.sort((a, b) => b.tokens.length - a.tokens.length);
}

function fullValueSignature(token: DesignToken): string {
  const primary = canonicalValue(token.resolvedValue);
  const variants = token.variants
    .map((v) => `${v.condition.toLowerCase()}=${canonicalValue(v.value)}`)
    .sort()
    .join("|");
  return `${primary}||${variants}`;
}

function canonicalValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Coverage + reference scan ──────────────────────────────────────────

interface CoverageScan {
  readonly coverage: Coverage;
  readonly literalsByFile: Map<string, LiteralWithFile[]>;
  readonly referencedNames: Set<string>;
  readonly brokenReferences: BrokenReference[];
  readonly scannedFiles: number;
}

interface LiteralWithFile {
  readonly filePath: string;
  readonly text: string;
  readonly kind: LiteralKind;
  readonly offset: number;
  readonly line: number;
  /** CSS property in which the literal appears, when detectable. Drives
   *  property-family bucketing — `12px` under `padding` lands in a
   *  different SPACING bucket than `12px` under `font-size`. */
  readonly cssProperty: string | null;
}

const CSS_REF_RE = /var\(\s*--([A-Za-z_][A-Za-z0-9_-]*)(?:\s*,[^)]*)?\)/g;
// SCSS variable reference. Counted toward tokenised refs but **never**
// flagged as broken — SCSS variables come from function args, mixin
// locals, @import-ed partials, and runtime contexts the analyser can't
// see. Flagging them as broken floods the report with noise.
const SCSS_REF_RE = /(?<![A-Za-z0-9_-])\$([A-Za-z_][A-Za-z0-9_-]*)/g;
const JS_PATH_REF_RE = /(['"`])\{([A-Za-z_][A-Za-z0-9_.-]*)\}\1/g;
const DT_REF_RE = /dt\(\s*(['"`])([A-Za-z_][A-Za-z0-9_.-]*)\1\s*\)/g;

// Strip `/* … */`, `// …` and SCSS interpolations `#{…}` before scanning
// references so we don't pick up:
//   • commented-out code (real refs inside a deleted block),
//   • `$type` inside `#{$type}-#{$size}` (function-arg interpolation —
//     never a top-level project token).
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const SCSS_INTERPOLATION_RE = /#\{[^}]*\}/g;

async function computeCoverage(
  allTokens: readonly DesignToken[],
  rootPath: string | null,
  activeScopes: readonly ConfiguredScope[],
  dynamicCssVarIndex: DynamicCssVarIndex,
): Promise<CoverageScan> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || !rootPath) {
    return {
      coverage: { tokenisedAssignments: 0, literalAssignments: 0, ratio: 1, sources: [] },
      literalsByFile: new Map(),
      referencedNames: new Set(),
      brokenReferences: [],
      scannedFiles: 0,
    };
  }
  // Restrict the file walk to active scope rootPaths when a scope is in
  // play — mirrors IntelliJ. Common scopes contribute no restriction
  // (they apply project-wide).
  const rootRestrictions = activeScopes
    .filter((s) => !s.isCommon)
    .map((s) => absolutizeOrNull(rootPath, s.rootPath))
    .filter((p): p is string => p !== null);
  // Exclude both excludedPaths and the active scopes' sourcePaths
  // themselves (those files DECLARE tokens; counting their values as
  // literal hits would polute Hardcoded pressure with the token catalog).
  const excludedAbs: string[] = [];
  for (const s of activeScopes) {
    for (const p of s.excludedPaths) {
      const abs = absolutizeOrNull(rootPath, p);
      if (abs) excludedAbs.push(abs);
    }
    for (const p of s.sourcePaths) {
      const abs = absolutizeOrNull(rootPath, p);
      if (abs) excludedAbs.push(abs);
    }
  }

  const externalPrefixes = collectExternalPrefixes(activeScopes);
  const tokenNames = new Set(allTokens.map((t) => t.name));

  const files = await vscode.workspace.findFiles(
    COVERAGE_GLOB,
    "**/node_modules/**",
  );

  let tokenised = 0;
  let literal = 0;
  const literalsByFile = new Map<string, LiteralWithFile[]>();
  const referenced = new Set<string>();
  const broken: BrokenReference[] = [];

  let scanned = 0;
  for (const uri of files) {
    if (rootRestrictions.length > 0 && !isInsideAny(uri.path, rootRestrictions))
      continue;
    // Only the ACTIVE scopes' excludes (rootPath restriction + their own
    // excludedPaths/sourcePaths, already folded into `excludedAbs`) gate
    // the walk. Applying every configured scope's excludedPaths here was a
    // cross-scope leak: a `mobile` scope excluding `bo` would wipe out the
    // entire `bo/src`-rooted `UI` scope analysis ("0 files scanned").
    if (isInsideAny(uri.path, excludedAbs)) continue;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      scanned++;

      // Literals (hardcoded).
      const literals: LiteralWithFile[] = [];
      for (const hit of findLiterals(text)) {
        literals.push({
          filePath: uri.path,
          text: hit.text,
          kind: hit.kind,
          offset: hit.startOffset,
          line: lineFor(text, hit.startOffset),
          cssProperty: hit.cssProperty,
        });
        literal++;
      }
      if (literals.length > 0) literalsByFile.set(uri.path, literals);

      // Mask comments + SCSS interpolations so the ref regexes don't
      // pick them up. We replace with spaces of equal length so the
      // captured offsets remain valid for line/col lookup.
      const masked = maskNonCodeRanges(text);

      // CSS vars — broken-eligible.
      collectCssRefs(
        masked,
        uri.path,
        tokenNames,
        externalPrefixes,
        referenced,
        broken,
        dynamicCssVarIndex,
      );
      tokenised += countMatches(masked, CSS_REF_RE);

      // SCSS vars — referenced but NEVER broken (IntelliJ parity).
      collectScssRefs(masked, tokenNames, referenced);
      tokenised += countMatches(masked, SCSS_REF_RE);

      // JS object paths + dt() — broken-eligible.
      collectPathRefs(
        masked,
        JS_PATH_REF_RE,
        uri.path,
        tokenNames,
        referenced,
        broken,
      );
      collectPathRefs(
        masked,
        DT_REF_RE,
        uri.path,
        tokenNames,
        referenced,
        broken,
      );
      tokenised += countMatches(masked, JS_PATH_REF_RE);
      tokenised += countMatches(masked, DT_REF_RE);
    } catch {
      // Unreadable file — skip silently.
    }
  }

  const total = tokenised + literal;
  const ratio = total === 0 ? 1 : tokenised / total;

  const sources = perSourceUsage(allTokens, referenced, activeScopes);
  return {
    coverage: {
      tokenisedAssignments: tokenised,
      literalAssignments: literal,
      ratio,
      sources,
    },
    literalsByFile,
    referencedNames: referenced,
    brokenReferences: broken,
    scannedFiles: scanned,
  };
}

function collectExternalPrefixes(
  scopes: readonly ConfiguredScope[],
): readonly string[] {
  const set = new Set<string>();
  for (const s of scopes) for (const p of s.externalPrefixes) set.add(p);
  return [...set];
}

function collectCssRefs(
  text: string,
  filePath: string,
  tokenNames: ReadonlySet<string>,
  externalPrefixes: readonly string[],
  referenced: Set<string>,
  broken: BrokenReference[],
  dynamicCssVarIndex: DynamicCssVarIndex,
): void {
  for (const m of text.matchAll(CSS_REF_RE)) {
    const captured = m[1];
    if (!captured) continue;
    const name = "--" + captured;
    const offset = m.index ?? 0;
    // Skip declarations: `--name: value` — left of the `:` is the
    // declaration site, not a reference.
    if (isDeclarationAt(text, offset)) continue;
    if (tokenNames.has(name)) {
      referenced.add(name);
      continue;
    }
    if (externalPrefixes.some((p) => name.startsWith(p))) continue;
    if (dynamicCssVarIndex.has(name)) continue;
    broken.push({
      name: m[0],
      filePath,
      offset,
      line: lineFor(text, offset),
    });
  }
}

function collectScssRefs(
  text: string,
  tokenNames: ReadonlySet<string>,
  referenced: Set<string>,
): void {
  for (const m of text.matchAll(SCSS_REF_RE)) {
    const captured = m[1];
    if (!captured) continue;
    const name = "$" + captured;
    if (isDeclarationAt(text, m.index ?? 0)) continue;
    if (tokenNames.has(name)) referenced.add(name);
    // No broken-ref bookkeeping for SCSS — IntelliJ parity.
  }
}

function collectPathRefs(
  text: string,
  regex: RegExp,
  filePath: string,
  tokenNames: ReadonlySet<string>,
  referenced: Set<string>,
  broken: BrokenReference[],
): void {
  for (const m of text.matchAll(regex)) {
    const captured = m[2];
    if (!captured) continue;
    const offset = m.index ?? 0;
    // Full `resolveReference` chain — handles binding-prefix strip
    // (`token.global.x` vs indexed `global.x`), mode-segment strip
    // (`global.modeLight.x` vs indexed `global.x`), and camelCase /
    // dot drift between source and tree
    // (`…defaultHigh.surface` vs `…default.high.surface`).
    const resolved = resolveReference(captured, tokenNames);
    if (resolved) {
      referenced.add(resolved.tokenName);
      continue;
    }
    // Last-resort lead-segment strip — handles aliases like
    // `{primitive.neutral.700}` whose target index entry is
    // `neutral.700` (no shared prefix). Mirrors the alias resolver
    // in TokenScanner.resolveValue, step (c).
    const suffix = findSuffixToken(captured, tokenNames);
    if (suffix) {
      referenced.add(suffix);
      continue;
    }
    broken.push({
      name: m[0],
      filePath,
      offset,
      line: lineFor(text, offset),
    });
  }
}

/**
 * Returns true when the captured CSS/SCSS variable at [offset] sits on
 * the **left** side of a `:` (i.e. it's being declared, not referenced).
 * Mirrors `LiteralFinder.variableDeclarationName` from the IntelliJ
 * side — we don't need the name itself, only the boolean.
 */
function isDeclarationAt(text: string, offset: number): boolean {
  // Find the end of the captured identifier — walk forward over
  // identifier chars starting at offset+1 (offset points at `$` or the
  // first `-` of `--`).
  let i = offset;
  // Skip leading `$` or `--` prefix.
  if (text[i] === "$") i++;
  else if (text[i] === "-" && text[i + 1] === "-") i += 2;
  while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++;
  // Peek the next non-whitespace char — `:` means declaration.
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === ":";
}

function maskNonCodeRanges(text: string): string {
  // Replace each match with same-length whitespace so offsets stay
  // aligned for downstream line/col calculations and the masked output
  // still matches the original positions character-for-character.
  let out = text.replace(BLOCK_COMMENT_RE, (m) => " ".repeat(m.length));
  out = out.replace(LINE_COMMENT_RE, (m) => " ".repeat(m.length));
  out = out.replace(SCSS_INTERPOLATION_RE, (m) => " ".repeat(m.length));
  return out;
}

function absolutizeOrNull(rootPath: string, rel: string): string | null {
  if (!rel.trim()) return null;
  if (rel.startsWith("/")) return rel;
  const base = rootPath.replace(/\/$/, "");
  return `${base}/${rel.replace(/^\//, "")}`;
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
  for (const r of roots) {
    if (path === r || path.startsWith(r + "/")) return true;
  }
  return false;
}

function findSuffixToken(name: string, tokenNames: ReadonlySet<string>): string | null {
  if (!name.includes(".")) return null;
  const segs = name.split(".");
  for (let skip = 1; skip < segs.length; skip++) {
    const sub = segs.slice(skip).join(".");
    if (tokenNames.has(sub)) return sub;
  }
  return null;
}

function countMatches(text: string, regex: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(regex)) n++;
  return n;
}

function perSourceUsage(
  tokens: readonly DesignToken[],
  referenced: ReadonlySet<string>,
  activeScopes: readonly ConfiguredScope[],
): TokenSourceUsage[] {
  // When a scope is active, only its source files matter — listing every
  // workspace token catalog under "Token-source usage" dilutes the
  // report. External tokens are also dropped (they're cataloged but not
  // owned by the project).
  const inScope = activeScopes.length === 0
    ? tokens.filter((t) => !t.external)
    : (() => {
        const names = new Set(activeScopes.map((s) => s.name));
        return tokens.filter((t) => !t.external && names.has(t.scope));
      })();
  const byFile = new Map<string, DesignToken[]>();
  for (const t of inScope) {
    const list = byFile.get(t.filePath) ?? [];
    list.push(t);
    byFile.set(t.filePath, list);
  }
  const out: TokenSourceUsage[] = [];
  for (const [filePath, decls] of byFile) {
    const used = decls.reduce(
      (n, t) => n + (referenced.has(t.name) ? 1 : 0),
      0,
    );
    const ratio = decls.length === 0 ? 1 : used / decls.length;
    out.push({ filePath, declared: decls.length, used, ratio });
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

// ─── Hardcoded scan (clusters + values) ─────────────────────────────────

interface HardcodedScan {
  readonly clusters: HardcodedCluster[];
  readonly values: HardcodedValue[];
}

/**
 * Walks every literal collected during the coverage pass, buckets them
 * by `(literal + category)` (category derived from the surrounding CSS
 * property when known, otherwise from the literal's kind), then asks
 * `findSuggestions` for an exact in-category match per bucket:
 *
 *   • Match found → the literal is **debt** — a token already exists,
 *     the user just needs to apply it. Reported as a `HardcodedValue`.
 *   • No match    → the literal is an **opportunity** — only kept
 *     when it repeats at least MIN_HARDCODED_CLUSTER times in the
 *     workspace (a single occurrence isn't worth a design-system
 *     discussion). Reported as a `HardcodedCluster`.
 *
 * The "strict category" filter on the exact match is intentional:
 * `TokenValueIndex` widens lookups across the length-bearing family,
 * which is great for surfacing closest-fit suggestions but misleading
 * here — we don't want to flag a `width: 20px` literal as debt just
 * because a typography token happens to hold 20px.
 */
function collectHardcodedScan(
  literalsByFile: Map<string, LiteralWithFile[]>,
  valueIndex: TokenValueIndex,
  tokens: readonly DesignToken[],
): HardcodedScan {
  // Bucket key encodes both the literal and the property family — same
  // literal under two different properties produces two buckets.
  const buckets = new Map<string, LiteralWithFile[]>();
  for (const list of literalsByFile.values()) {
    for (const lit of list) {
      const cat = categoryForLiteral(lit);
      const key = `${lit.text.toLowerCase()}|${cat ?? "_"}`;
      const arr = buckets.get(key) ?? [];
      arr.push(lit);
      buckets.set(key, arr);
    }
  }

  const clusters: HardcodedCluster[] = [];
  const values: HardcodedValue[] = [];

  for (const occurrences of buckets.values()) {
    const first = occurrences[0];
    const category = categoryForLiteral(first);

    // Synthetic Hit for findSuggestions — only `text` and `kind` matter
    // for the lookup; offsets / replace range / cssProperty are not read
    // by the suggestion pipeline beyond the (already-resolved) category.
    const syntheticHit = {
      text: first.text,
      startOffset: 0,
      endOffsetExclusive: first.text.length,
      kind: first.kind,
      replaceStart: 0,
      replaceEndExclusive: first.text.length,
      replaceText: first.text,
      cssProperty: first.cssProperty,
    } as const;
    const expectedRole = first.cssProperty
      ? getExpectedRoleForProperty(first.cssProperty)
      : null;
    const suggestions = findSuggestions(syntheticHit, valueIndex, tokens, {
      expectedCategory: category,
      expectedRole,
      excludeExternal: true,
    });

    // Strict category match: see docstring.
    const exact = suggestions.find(
      (s) =>
        s.exact &&
        (category === null || s.token.category === category),
    );

    const occList = occurrences.map<HardcodedOccurrence>((o) => ({
      filePath: o.filePath,
      offset: o.offset,
      line: o.line,
    }));

    if (exact) {
      values.push({
        literal: first.text.toLowerCase(),
        category,
        suggestedToken: exact.token,
        occurrences: occList,
      });
    } else if (occurrences.length >= MIN_HARDCODED_CLUSTER) {
      clusters.push({
        literal: first.text.toLowerCase(),
        category,
        occurrences: occList,
        matchingTokenName: null,
      });
    }
  }

  return {
    clusters: clusters
      .sort((a, b) => b.occurrences.length - a.occurrences.length)
      .slice(0, MAX_HARDCODED_CLUSTERS),
    values: values
      .sort((a, b) => b.occurrences.length - a.occurrences.length)
      .slice(0, MAX_HARDCODED_CLUSTERS),
  };
}

/**
 * Most-specific category for the literal. Uses the surrounding CSS
 * property when known (e.g. `font-size: 12px` → TYPOGRAPHY) and falls
 * back to the literal's kind otherwise (JS object literals, SCSS map
 * values without a top-level property).
 */
function categoryForLiteral(lit: LiteralWithFile): TokenCategory | null {
  if (lit.cssProperty) {
    const fromProp = categoryForCssProperty(lit.cssProperty);
    if (fromProp) return fromProp;
  }
  return categoryForKind(lit.kind);
}

function categoryForKind(kind: LiteralKind): TokenCategory | null {
  switch (kind) {
    case "COLOR":
      return "COLOR";
    case "LENGTH":
      return "SPACING";
    case "DURATION":
      return "DURATION";
    case "NUMBER":
      // A bare number with no property context is genuinely ambiguous
      // (z-index? opacity? RN spacing?). Leave it uncategorised so the
      // bucket key falls back to "_" and the literal is still surfaced
      // as a cluster when it repeats — mirrors IntelliJ's NUMBER kind
      // fallback, which never forces a category from the value alone.
      return null;
  }
}

// Property→category sets, ported verbatim from IntelliJ's
// `PropertyContext.categoryFor`. The `startsWith` / `includes` / `endsWith`
// predicates below are what let the mapping recognise both hyphenated CSS
// (`font-size`, `border-radius`, `padding-top`) AND React-Native / JS
// camelCase props (`fontSize`, `borderRadius`, `paddingTop`) — the latter
// arrive here lowercased (`fontsize`, `borderradius`, `paddingtop`), which
// the prefix/substring checks still match.
const COLOR_PROPS = new Set([
  "background", "fill", "stroke", "caret-color", "accent-color",
  "column-rule-color", "scrollbar-color",
]);
const SPACING_PROPS = new Set([
  "gap", "row-gap", "column-gap", "top", "left", "right", "bottom",
]);
const SIZING_PROPS = new Set([
  "width", "height", "min-width", "min-height", "max-width", "max-height",
]);
const LAYOUT_PROPS = new Set([
  "columns", "break-after", "break-before", "break-inside",
]);
const TYPO_PROPS = new Set([
  "line-height", "letter-spacing", "word-spacing", "text-indent",
]);

/**
 * Maps a CSS / RN property name to the token category that best describes
 * the design-system axis it draws on. Faithful port of IntelliJ's
 * `PropertyContext.categoryFor` (same order, same predicates) so the two
 * plugins bucket identical literals into identical categories. Returns
 * `null` when no clear category can be inferred.
 *
 * Order matters: colour wins over everything (so `shadow-color` is COLOR,
 * not SHADOW), then z-index / radius / shadow / effects / typography /
 * duration / spacing / layout / sizing. The two trailing `BORDER` /
 * `OPACITY` checks are VS Code refinements with no IntelliJ counterpart —
 * pure additions in the otherwise-`null` tail.
 */
function categoryForCssProperty(prop: string): TokenCategory | null {
  const p = prop.toLowerCase().trim();
  if (p === "color" || p.endsWith("-color") || COLOR_PROPS.has(p)) return "COLOR";
  if (p === "z-index" || p === "zindex") return "Z_INDEX";
  if (p.includes("radius")) return "RADIUS";
  if (p.includes("shadow")) return "SHADOW";
  if (p === "outline" || p === "filter" || p === "backdrop-filter") return "EFFECTS";
  if (p.startsWith("font") || TYPO_PROPS.has(p)) return "TYPOGRAPHY";
  if (
    p.includes("transition") || p.includes("animation") ||
    p === "duration" || p.endsWith("-delay") || p.endsWith("delay")
  ) {
    return "DURATION";
  }
  if (
    SPACING_PROPS.has(p) || p.startsWith("padding") ||
    p.startsWith("margin") || p.startsWith("inset")
  ) {
    return "SPACING";
  }
  if (LAYOUT_PROPS.has(p) || p.startsWith("grid") || p.startsWith("flex")) {
    return "LAYOUT";
  }
  if (SIZING_PROPS.has(p) || p === "width" || p === "height") return "SIZING";
  // VS Code refinements (no IntelliJ counterpart):
  if (p === "border-width" || p.endsWith("-border-width") || p === "outline-offset") {
    return "BORDER";
  }
  if (p === "opacity") return "OPACITY";
  return null;
}

// ─── Sub-score aggregation ──────────────────────────────────────────────

interface SubScoreInputs {
  readonly totalTokens: number;
  readonly incoherences: readonly Incoherence[];
  readonly duplicateClusters: readonly DuplicateCluster[];
  readonly coverage: Coverage;
  readonly hardcodedClusters: readonly HardcodedCluster[];
  readonly hardcodedValues: readonly HardcodedValue[];
  readonly brokenCount: number;
}

function computeSubScores(inputs: SubScoreInputs): SubScore[] {
  const total = Math.max(1, inputs.totalTokens);

  const coherenceScore = clamp(100 - (100 * inputs.incoherences.length) / total);
  const coverageScore = clamp(inputs.coverage.ratio * 100);
  const duplicateOffenders = inputs.duplicateClusters.reduce(
    (n, c) => n + (c.tokens.length - 1),
    0,
  );
  const duplicateScore = clamp(100 - (100 * duplicateOffenders) / total);

  const literalsTotal = Math.max(1, inputs.coverage.literalAssignments);

  // Opportunity: literals with NO matching token. Each hit pads the
  // deficit linearly — these are design opportunities, not bugs, so
  // weighting is moderate (w15, x1).
  const opportunityHits = inputs.hardcodedClusters.reduce(
    (n, c) => n + c.occurrences.length,
    0,
  );
  const opportunityScore = clamp(100 - (100 * opportunityHits) / literalsTotal);

  // Debt: literals whose token already exists. Penalty per hit is x2
  // vs. opportunity — the fix is immediate and the user has no excuse
  // not to apply the existing token (w10, x2).
  const debtHits = inputs.hardcodedValues.reduce(
    (n, c) => n + c.occurrences.length,
    0,
  );
  const debtScore = clamp(100 - (100 * debtHits * 2) / literalsTotal);

  const refTotal = Math.max(1, inputs.coverage.tokenisedAssignments);
  const refIntegrityScore = clamp(
    100 - (100 * inputs.brokenCount * 4) / refTotal,
  );

  return [
    {
      axis: "SEMANTIC_COHERENCE",
      score: coherenceScore,
      weight: 20,
      caption:
        inputs.incoherences.length === 0
          ? "All token names align with their values."
          : `${inputs.incoherences.length} token(s) with mismatched name/value semantics.`,
    },
    {
      axis: "USAGE_COVERAGE",
      score: coverageScore,
      weight: 20,
      caption: `${inputs.coverage.tokenisedAssignments} tokenised vs ${inputs.coverage.literalAssignments} literal references.`,
    },
    {
      axis: "DUPLICATION",
      score: duplicateScore,
      weight: 15,
      caption:
        inputs.duplicateClusters.length === 0
          ? "No duplicate values detected."
          : `${inputs.duplicateClusters.length} cluster(s), ${duplicateOffenders} extra token(s).`,
    },
    {
      axis: "HARDCODED_OPPORTUNITY",
      score: opportunityScore,
      weight: 15,
      caption: `${inputs.hardcodedClusters.length} repeated literal(s) without a matching token.`,
    },
    {
      axis: "HARDCODED_DEBT",
      score: debtScore,
      weight: 10,
      caption:
        inputs.hardcodedValues.length === 0
          ? "No literal usages of an already-tokenised value."
          : `${inputs.hardcodedValues.length} value(s) replaceable by an existing token (${debtHits} hits).`,
    },
    {
      axis: "REFERENCE_INTEGRITY",
      score: refIntegrityScore,
      weight: 20,
      caption:
        inputs.brokenCount === 0
          ? "All token references resolve cleanly."
          : `${inputs.brokenCount} broken token reference(s) detected.`,
    },
  ];
}

function weightedAverage(subs: readonly SubScore[]): number {
  const totalWeight = Math.max(1, subs.reduce((n, s) => n + s.weight, 0));
  const weighted = subs.reduce((n, s) => n + s.score * s.weight, 0);
  return clamp(weighted / totalWeight);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ─── Helpers ────────────────────────────────────────────────────────────

function lineFor(text: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
