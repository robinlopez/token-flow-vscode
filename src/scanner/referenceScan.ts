// Reference collection for one file — the single normative
// implementation of the "is this reference tokenised / external /
// broken?" decision, extracted from `designSystemAnalyzer.ts` so it can
// be unit-tested without a `vscode` host.
//
// Four reference syntaxes are recognised:
//
//   var(--name[, fallback])   CSS custom property   — broken-eligible
//   $name                     SCSS variable         — never broken
//   '{a.b}'                   Style-Dictionary alias— broken-eligible
//   dt('a.b')                 PrimeVue design token — broken-eligible
//
// Decision order (mirrors `DesignSystemAnalyzer.computeCoverage` on the
// IntelliJ side — keep the two in lockstep, see SHARED_LOGIC.md):
//
//   1. `'{…}'` inside a string-helper / i18n call  → dropped entirely
//      (`placeholderGuard`), not even counted.
//   2. `'{…}'` whose name is outside the project's token vocabulary
//      → dropped entirely (`TokenPathShape`).
//   3. count toward `tokenised`.
//   4. name matches an `externalPrefixes` entry → neutral: counted as
//      tokenised, never broken, never added to `referenced` (there is no
//      canonical token to point at, so it must not mark one as used).
//   5. runtime-declared CSS var (`DynamicCssVarIndex`) → not broken.
//   6. resolve through the shared alias chain; unresolved → broken.
//
// SCSS variables are counted and resolved but NEVER reported broken:
// they come from function args, mixin locals, `@import`-ed partials and
// runtime contexts the analyser can't see (IntelliJ parity).

import { resolveReference } from "./tokenNameParser";
import { isPlaceholderCallArgument } from "./placeholderGuard";
import { TokenPathShape } from "./tokenPathShape";

export const CSS_REF_RE =
  /var\(\s*--([A-Za-z_][A-Za-z0-9_-]*)(?:\s*,[^)]*)?\)/g;
export const SCSS_REF_RE = /(?<![A-Za-z0-9_-])\$([A-Za-z_][A-Za-z0-9_-]*)/g;
export const JS_PATH_REF_RE = /(['"`])\{([A-Za-z_][A-Za-z0-9_.-]*)\}\1/g;
export const DT_REF_RE = /dt\(\s*(['"`])([A-Za-z_][A-Za-z0-9_.-]*)\1\s*\)/g;

// Strip `/* … */`, `// …` and SCSS interpolations `#{…}` before scanning
// references so we don't pick up:
//   • commented-out code (real refs inside a deleted block),
//   • `$type` inside `#{$type}-#{$size}` (function-arg interpolation —
//     never a top-level project token).
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const SCSS_INTERPOLATION_RE = /#\{[^}]*\}/g;

export interface BrokenReferenceHit {
  /** Raw reference text as written in the file (`var(--x)`, `'{a.b}'`). */
  readonly name: string;
  readonly filePath: string;
  readonly offset: number;
  readonly line: number;
}

/** Minimal surface of `DynamicCssVarIndex` this module needs. */
export interface DynamicCssVarLookup {
  has(name: string): boolean;
}

export interface ReferenceScanOptions {
  readonly filePath: string;
  /** Every indexed token name, external/whitelisted ones included. */
  readonly tokenNames: ReadonlySet<string>;
  /** Effective prefix union — global setting ∪ active scopes (§3). */
  readonly externalPrefixes: readonly string[];
  /** Built once per scan from the same `tokenNames` set. */
  readonly pathShape: TokenPathShape;
  readonly dynamicCssVars: DynamicCssVarLookup;
}

/** Mutable accumulators shared across the files of one scan. */
export interface ReferenceSink {
  /** Canonical token names proven to be used somewhere. */
  readonly referenced: Set<string>;
  readonly broken: BrokenReferenceHit[];
}

export interface ReferenceScanResult {
  readonly tokenised: number;
  readonly referenced: Set<string>;
  readonly broken: BrokenReferenceHit[];
}

/**
 * Scans [rawText] and folds its references into [sink].
 *
 * @returns the number of tokenised references found in this file.
 */
export function collectReferences(
  rawText: string,
  opts: ReferenceScanOptions,
  sink: ReferenceSink,
): number {
  const text = maskNonCodeRanges(rawText);
  let tokenised = 0;

  // ─── CSS custom properties ────────────────────────────────────────
  for (const m of text.matchAll(CSS_REF_RE)) {
    const captured = m[1];
    if (!captured) continue;
    tokenised++;
    const name = "--" + captured;
    const offset = m.index ?? 0;
    if (tokenNameResolves(name, opts, sink)) continue;
    if (isExternal(name, opts.externalPrefixes)) continue;
    if (opts.dynamicCssVars.has(name)) {
      // Declared at runtime by component code (Angular host binding,
      // inline React/Vue style, `setProperty`) — real, just invisible
      // to a static walk.
      sink.referenced.add(name);
      continue;
    }
    sink.broken.push({
      name: m[0],
      filePath: opts.filePath,
      offset,
      line: lineFor(text, offset),
    });
  }

  // ─── SCSS variables — counted + resolved, never broken ────────────
  for (const m of text.matchAll(SCSS_REF_RE)) {
    const captured = m[1];
    if (!captured) continue;
    tokenised++;
    if (isDeclarationAt(text, m.index ?? 0)) continue;
    const name = "$" + captured;
    if (opts.tokenNames.has(name)) sink.referenced.add(name);
  }

  // ─── JS object paths + dt() ───────────────────────────────────────
  tokenised += collectPathRefs(text, JS_PATH_REF_RE, opts, sink, true);
  tokenised += collectPathRefs(text, DT_REF_RE, opts, sink, false);

  return tokenised;
}

/** Convenience wrapper for one-shot scans (tests, single-file callers). */
export function scanReferences(
  rawText: string,
  opts: ReferenceScanOptions,
): ReferenceScanResult {
  const sink: ReferenceSink = { referenced: new Set<string>(), broken: [] };
  const tokenised = collectReferences(rawText, opts, sink);
  return { tokenised, referenced: sink.referenced, broken: sink.broken };
}

/**
 * @param guardPlaceholders apply the string-helper guard (§2.A). Only
 *        `'{…}'` needs it — `dt('a.b')` names the syntax explicitly and
 *        can never be a message template.
 * @returns the number of tokenised references found.
 */
function collectPathRefs(
  text: string,
  regex: RegExp,
  opts: ReferenceScanOptions,
  sink: ReferenceSink,
  guardPlaceholders: boolean,
): number {
  let tokenised = 0;
  for (const m of text.matchAll(regex)) {
    const captured = m[2];
    if (!captured) continue;
    const offset = m.index ?? 0;
    // §2.A — a placeholder handed to `replace` / `instant` / `split`…
    // isn't a reference at all. Dropped before any bookkeeping so the
    // coverage ratio stays honest.
    if (guardPlaceholders && isPlaceholderCallArgument(text, offset)) continue;
    // §2.B — the name is outside the project's token vocabulary.
    if (!opts.pathShape.isPlausibleReference(m[0], captured)) continue;

    tokenised++;
    if (isExternal(captured, opts.externalPrefixes)) continue;

    // Full `resolveReference` chain — handles binding-prefix strip
    // (`token.global.x` vs indexed `global.x`), mode-segment strip
    // (`global.modeLight.x` vs indexed `global.x`), and camelCase /
    // dot drift between source and tree
    // (`…defaultHigh.surface` vs `…default.high.surface`).
    const resolved = resolveReference(captured, opts.tokenNames, opts.externalPrefixes);
    if (resolved) {
      if (!resolved.external) sink.referenced.add(resolved.tokenName);
      continue;
    }
    // Last-resort lead-segment strip — handles aliases like
    // `{primitive.neutral.700}` whose target index entry is
    // `neutral.700` (no shared prefix). Mirrors the alias resolver
    // in TokenScanner.resolveValue, step (c).
    const suffix = findSuffixToken(captured, opts.tokenNames);
    if (suffix) {
      sink.referenced.add(suffix);
      continue;
    }
    sink.broken.push({
      name: m[0],
      filePath: opts.filePath,
      offset,
      line: lineFor(text, offset),
    });
  }
  return tokenised;
}

/** Exact-name hit — marks the token used and short-circuits the rest. */
function tokenNameResolves(
  name: string,
  opts: ReferenceScanOptions,
  sink: ReferenceSink,
): boolean {
  if (!opts.tokenNames.has(name)) return false;
  sink.referenced.add(name);
  return true;
}

/**
 * §3 — the reference points at a variable that is valid but declared
 * outside the design system (framework-injected `--p-` / `--ion-` /
 * `--mat-`, or a component's own customisation API `--ui-slider-`).
 * Compared with `startsWith` on the **extracted** name, so a CSS prefix
 * must be written with its leading dashes.
 */
export function isExternal(
  name: string,
  externalPrefixes: readonly string[],
): boolean {
  for (const p of externalPrefixes) {
    if (p && name.startsWith(p)) return true;
  }
  return false;
}

/**
 * Returns true when the captured CSS/SCSS variable at [offset] sits on
 * the **left** side of a `:` (i.e. it's being declared, not referenced).
 * Mirrors `LiteralFinder.variableDeclarationName` from the IntelliJ
 * side — we don't need the name itself, only the boolean.
 */
export function isDeclarationAt(text: string, offset: number): boolean {
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

export function findSuffixToken(
  name: string,
  tokenNames: ReadonlySet<string>,
): string | null {
  if (!name.includes(".")) return null;
  const segs = name.split(".");
  for (let skip = 1; skip < segs.length; skip++) {
    const sub = segs.slice(skip).join(".");
    if (tokenNames.has(sub)) return sub;
  }
  return null;
}

export function maskNonCodeRanges(text: string): string {
  // Replace each match with same-length whitespace so offsets stay
  // aligned for downstream line/col calculations and the masked output
  // still matches the original positions character-for-character.
  let out = text.replace(BLOCK_COMMENT_RE, (m) => " ".repeat(m.length));
  out = out.replace(LINE_COMMENT_RE, (m) => " ".repeat(m.length));
  out = out.replace(SCSS_INTERPOLATION_RE, (m) => " ".repeat(m.length));
  return out;
}

export function lineFor(text: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
