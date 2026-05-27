// Analyse dashboard client. Renders an [WireAnalysisReport] as:
//   1. A circular SVG gauge with the global A→F grade and 0..100 score.
//   2. A grid of sub-score bars (one per axis).
//   3. Accordion sections — Hardcoded clusters, Broken references,
//      Unused tokens, Duplicates, Semantic incoherences, Token-source
//      usage. Each section has a help tooltip and a target button per
//      row to navigate to the source location.
//
// Order chosen for actionability: noisy/dirty stuff (hardcoded, broken,
// unused, duplicates) bubbles up first so the user sees what to clean
// up; structural/curiosity sections (semantic mismatches, source usage)
// sit at the bottom. Mirrors the IntelliJ AnalyzePanel.

import type {
  AnalyseClientMessage,
  AnalyseHostMessage,
  WireAnalysisReport,
  WireBrokenReference,
  WireDuplicateCluster,
  WireHardcodedCluster,
  WireHardcodedOccurrence,
  WireHardcodedValue,
  WireIncoherence,
  WireScopeState,
  WireSubScore,
  WireTokenLocation,
  WireTokenSourceUsage,
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(msg: AnalyseClientMessage): void;
};

const vscode = acquireVsCodeApi();

const SECTION_HELP = {
  HARDCODED:
    "Literal values repeated across the codebase with NO matching token in the active scope — design opportunities. Click a row to expand the per-occurrence table and jump to any hit.",
  HARDCODED_VALUES:
    "Literal values whose token already exists in the active scope — actionable technical debt. Each row carries the most relevant token to apply.",
  BROKEN_REF:
    "References to tokens that do not exist in your design system. Usually a typo or a deleted token still in use.",
  UNUSED:
    "Tokens declared but never referenced anywhere in the project (no `var(--…)`, `$…` or `'{path}'` match found).",
  DUPLICATE:
    "Tokens declared separately but resolving to the same value. Suggestion: keep the shortest/most semantic name.",
  INCOHERENCE:
    "Tokens whose name suggests one category but whose value implies another.",
  COVERAGE:
    "How much of each token-source file is actually referenced. Low ratios = catalog bloat or dead tokens.",
} as const;

const ROW_LIMIT = 50;
const CLUSTER_LIMIT = 30;

/** Sticky scope state — re-rendered into the header on every message so
 *  the combo stays alive across loading transitions. */
let lastScope: WireScopeState | null = null;
let lastReport: WireAnalysisReport | null = null;
let stale = false;

window.addEventListener("message", (event: MessageEvent<AnalyseHostMessage>) => {
  const msg = event.data;
  if (msg.type === "report") {
    lastScope = msg.scope;
    lastReport = msg.report;
    stale = false; //                                   fresh data — clear banner
    render(msg.report);
  } else if (msg.type === "analysing") {
    lastScope = msg.scope;
    renderLoading();
  } else if (msg.type === "idle") {
    lastScope = msg.scope;
    renderIdle(msg.message);
  } else if (msg.type === "scopeUpdate") {
    // Silent in-place update — refresh ONLY the scope combo (the first
    // child of the root). The report and stale state are untouched, so
    // changing the active editor in another window can't redraw the
    // panel and look like a re-analysis.
    lastScope = msg.scope;
    refreshToolbarInPlace();
  } else if (msg.type === "stale") {
    stale = msg.stale;
    // Re-render in place if we already have a report; otherwise the
    // banner will be picked up on the next report render.
    if (lastReport) render(lastReport);
  }
});

function refreshToolbarInPlace(): void {
  if (!lastScope) return;
  const root = document.getElementById("analyse-root")!;
  const existing = root.querySelector(".toolbar");
  const fresh = buildToolbar(lastScope);
  if (existing) existing.replaceWith(fresh);
  else root.prepend(fresh);
}

document.addEventListener("DOMContentLoaded", () => {
  vscode.postMessage({ type: "ready" });
});

function render(report: WireAnalysisReport): void {
  const root = document.getElementById("analyse-root")!;
  root.innerHTML = "";
  if (lastScope) root.appendChild(buildToolbar(lastScope));
  if (stale) root.appendChild(buildStaleBanner());
  root.append(
    buildHeader(report),
    buildSubScoreGrid(report.subScores),
    accordionSection({
      title: "Hardcoded clusters",
      count: report.hardcodedClusters.length,
      help: SECTION_HELP.HARDCODED,
      body: () => hardcodedBody(report.hardcodedClusters),
    }),
    accordionSection({
      title: "Hardcoded values",
      count: report.hardcodedValues.length,
      help: SECTION_HELP.HARDCODED_VALUES,
      body: () => hardcodedValuesBody(report.hardcodedValues),
    }),
    accordionSection({
      title: "Broken references",
      count: report.brokenReferences.length,
      help: SECTION_HELP.BROKEN_REF,
      body: () => brokenBody(report.brokenReferences),
    }),
    accordionSection({
      title: "Unused tokens",
      count: report.unusedTokens.length,
      help: SECTION_HELP.UNUSED,
      body: () => unusedBody(report.unusedTokens),
      initiallyCollapsed: true,
    }),
    accordionSection({
      title: "Duplicates",
      count: report.duplicateClusters.length,
      help: SECTION_HELP.DUPLICATE,
      body: () => duplicateBody(report.duplicateClusters),
      initiallyCollapsed: true,
    }),
    accordionSection({
      title: "Semantic incoherences",
      count: report.incoherences.length,
      help: SECTION_HELP.INCOHERENCE,
      body: () => incoherenceBody(report.incoherences),
      initiallyCollapsed: true,
    }),
    accordionSection({
      title: "Token-source usage",
      count: report.coverage.sources.length,
      help: SECTION_HELP.COVERAGE,
      body: () => coverageBody(report),
      initiallyCollapsed: true,
    }),
  );
}

function renderLoading(): void {
  const root = document.getElementById("analyse-root")!;
  root.innerHTML = "";
  if (lastScope) root.appendChild(buildToolbar(lastScope));
  const msg = document.createElement("p");
  msg.className = "analyse-empty";
  msg.textContent = "Analysing — scanning project files…";
  root.appendChild(msg);
}

function renderIdle(message: string): void {
  const root = document.getElementById("analyse-root")!;
  root.innerHTML = "";
  if (lastScope) root.appendChild(buildToolbar(lastScope));
  const msg = document.createElement("p");
  msg.className = "analyse-empty";
  msg.innerHTML = message;
  root.appendChild(msg);
}

function buildStaleBanner(): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "stale-banner";
  banner.innerHTML = `
    <span class="stale-banner__icon" aria-hidden="true">⚠</span>
    <span class="stale-banner__text">
      <b>Analysis is out of date.</b>
      Files referenced in the report changed since the last run.
    </span>`;
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "stale-banner__rerun";
  rerun.textContent = "Re-run analysis";
  rerun.addEventListener("click", () =>
    vscode.postMessage({ type: "refresh" }),
  );
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "stale-banner__dismiss";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", () => {
    stale = false;
    if (lastReport) render(lastReport);
    vscode.postMessage({ type: "dismissStale" });
  });
  banner.append(rerun, dismiss);
  return banner;
}

// ─── Toolbar (scope combo) ──────────────────────────────────────────────

function buildToolbar(scope: WireScopeState): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "toolbar";

  const label = document.createElement("span");
  label.className = "toolbar__label";
  label.textContent = "Scope:";

  const select = document.createElement("select");
  select.className = "toolbar__select";
  for (const opt of scope.options) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    if (opt.id === scope.selectedId) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    vscode.postMessage({ type: "selectScope", id: select.value });
  });

  bar.append(label, select);
  return bar;
}

// ─── Header (gauge + summary) ───────────────────────────────────────────

function buildHeader(report: WireAnalysisReport): HTMLElement {
  const header = document.createElement("header");
  header.className = "analyse-header";

  header.append(buildGauge(report.score, report.grade), buildSummary(report));

  const refresh = document.createElement("button");
  refresh.className = "ghost-btn";
  refresh.type = "button";
  refresh.textContent = "Re-run analysis";
  refresh.addEventListener("click", () =>
    vscode.postMessage({ type: "refresh" }),
  );
  header.appendChild(refresh);

  return header;
}

function buildSummary(report: WireAnalysisReport): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "analyse-summary";
  const title = document.createElement("div");
  title.className = "analyse-summary__title";
  title.textContent = "Design System health";
  const scope = document.createElement("div");
  scope.className = "analyse-summary__scope";
  scope.innerHTML = `Analysing scope: <b>${escape(report.scopeLabel)}</b>`;
  const meta = document.createElement("div");
  meta.className = "analyse-summary__meta";
  meta.textContent = `${report.totalTokens} tokens · ${report.scannedFiles} files scanned · ${report.tookMs} ms`;
  wrap.append(title, scope, meta);
  return wrap;
}

function buildGauge(score: number, grade: string): HTMLElement {
  // CSS-only circular gauge built on top of an SVG so the arc colour
  // follows the score band. Width matches the IntelliJ rendering.
  const size = 120;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - score / 100);
  const wrap = document.createElement("div");
  wrap.className = "gauge";
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.dataset.band = scoreBand(score);
  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}">
      <circle class="gauge__track" cx="${size / 2}" cy="${size / 2}" r="${r}"
              stroke-width="${stroke}" fill="none" stroke-linecap="round" />
      <circle class="gauge__arc" cx="${size / 2}" cy="${size / 2}" r="${r}"
              stroke-width="${stroke}" fill="none" stroke-linecap="round"
              stroke-dasharray="${c}" stroke-dashoffset="${dashOffset}"
              transform="rotate(-90 ${size / 2} ${size / 2})" />
    </svg>
    <div class="gauge__inner">
      <div class="gauge__grade">${escape(grade)}</div>
      <div class="gauge__score">${score} / 100</div>
    </div>`;
  return wrap;
}

function scoreBand(score: number): "good" | "medium" | "bad" {
  if (score >= 75) return "good";
  if (score >= 50) return "medium";
  return "bad";
}

// ─── Sub-score grid ─────────────────────────────────────────────────────

function buildSubScoreGrid(subs: readonly WireSubScore[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "subscore-grid";
  for (const s of subs) grid.appendChild(subScoreCard(s));
  return grid;
}

function subScoreCard(sub: WireSubScore): HTMLElement {
  const card = document.createElement("div");
  card.className = "subscore-card";
  card.dataset.band = scoreBand(sub.score);
  const header = document.createElement("div");
  header.className = "subscore-card__header";
  const name = document.createElement("span");
  name.className = "subscore-card__axis";
  name.textContent = axisLabel(sub.axis);
  const value = document.createElement("span");
  value.className = "subscore-card__value";
  value.textContent = `${sub.score}/100`;
  header.append(name, value);
  const bar = document.createElement("div");
  bar.className = "subscore-card__track";
  const fill = document.createElement("div");
  fill.className = "subscore-card__fill";
  fill.style.width = `${sub.score}%`;
  bar.appendChild(fill);
  const caption = document.createElement("div");
  caption.className = "subscore-card__caption";
  caption.textContent = sub.caption;
  card.append(header, bar, caption);
  return card;
}

function axisLabel(axis: WireSubScore["axis"]): string {
  switch (axis) {
    case "SEMANTIC_COHERENCE":
      return "Semantic coherence";
    case "USAGE_COVERAGE":
      return "Usage coverage";
    case "DUPLICATION":
      return "Duplication";
    case "HARDCODED_OPPORTUNITY":
      return "Hardcoded opportunity";
    case "HARDCODED_DEBT":
      return "Hardcoded debt";
    case "REFERENCE_INTEGRITY":
      return "Reference integrity";
  }
}

// ─── Accordion section primitive ────────────────────────────────────────

interface SectionConfig {
  readonly title: string;
  readonly count: number;
  readonly help: string;
  /** Lazy body factory — only invoked when the section first expands. */
  readonly body: () => HTMLElement;
  readonly initiallyCollapsed?: boolean;
}

function accordionSection(cfg: SectionConfig): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "section";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "section__header";
  header.innerHTML = `
    <span class="section__chevron">▸</span>
    <span class="section__title">${escape(cfg.title)}</span>
    <span class="section__count">${cfg.count}</span>
    <span class="section__help" title="${escape(cfg.help)}" aria-label="${escape(cfg.help)}">?</span>`;

  const body = document.createElement("div");
  body.className = "section__body";

  let materialised = false;
  let expanded = !(cfg.initiallyCollapsed ?? false);
  const apply = () => {
    wrap.dataset.expanded = expanded ? "true" : "false";
    if (expanded && !materialised) {
      body.appendChild(cfg.body());
      materialised = true;
    }
  };
  apply();
  header.addEventListener("click", () => {
    expanded = !expanded;
    apply();
  });

  wrap.append(header, body);
  return wrap;
}

// ─── Bodies ─────────────────────────────────────────────────────────────

function hardcodedBody(clusters: readonly WireHardcodedCluster[]): HTMLElement {
  if (clusters.length === 0) return emptyState("No notable hardcoded value found.");
  return truncatedList(clusters, CLUSTER_LIMIT, (c) => hardcodedClusterRow(c));
}

function hardcodedClusterRow(cluster: WireHardcodedCluster): HTMLElement {
  // Each cluster is itself collapsible — header shows literal + count,
  // body lists per-occurrence rows with a target button each.
  const row = document.createElement("div");
  row.className = "cluster";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "cluster__header";
  const match = cluster.matchingTokenName
    ? ` · <span class="cluster__match">matches token <code>${escape(cluster.matchingTokenName)}</code></span>`
    : "";
  header.innerHTML = `
    <span class="cluster__chevron">▸</span>
    <code class="cluster__literal">${escape(cluster.literal)}</code>
    <span class="cluster__sep">—</span>
    <span class="cluster__count"><b>${cluster.occurrences.length}</b> occurrence(s)</span>
    ${match}`;

  const body = document.createElement("div");
  body.className = "cluster__body";
  for (const occ of cluster.occurrences) body.appendChild(occurrenceRow(occ));

  let expanded = false;
  const apply = () => {
    row.dataset.expanded = expanded ? "true" : "false";
  };
  apply();
  header.addEventListener("click", () => {
    expanded = !expanded;
    apply();
  });

  row.append(header, body);
  return row;
}

function hardcodedValuesBody(
  values: readonly WireHardcodedValue[],
): HTMLElement {
  if (values.length === 0) {
    return emptyState("No literal usages of an already-tokenised value.");
  }
  return truncatedList(values, CLUSTER_LIMIT, (v) => hardcodedValueRow(v));
}

function hardcodedValueRow(value: WireHardcodedValue): HTMLElement {
  // Same shape as hardcodedClusterRow but the header carries the
  // suggested token instead of an "no match" note. The body lists
  // the per-occurrence rows so the user can jump-and-fix.
  const row = document.createElement("div");
  row.className = "cluster cluster--value";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "cluster__header";
  const suggested = value.suggestedTokenName
    ? ` · <span class="cluster__match">apply token <code>${escape(value.suggestedTokenName)}</code>${
        value.suggestedTokenValue
          ? ` <span class="cluster__match-value">(${escape(value.suggestedTokenValue)})</span>`
          : ""
      }</span>`
    : "";
  header.innerHTML = `
    <span class="cluster__chevron">▸</span>
    <code class="cluster__literal">${escape(value.literal)}</code>
    <span class="cluster__sep">—</span>
    <span class="cluster__count"><b>${value.occurrences.length}</b> occurrence(s)</span>
    ${suggested}`;

  const body = document.createElement("div");
  body.className = "cluster__body";
  for (const occ of value.occurrences) body.appendChild(occurrenceRow(occ));

  let expanded = false;
  const apply = () => {
    row.dataset.expanded = expanded ? "true" : "false";
  };
  apply();
  header.addEventListener("click", () => {
    expanded = !expanded;
    apply();
  });

  row.append(header, body);
  return row;
}

function occurrenceRow(occ: WireHardcodedOccurrence): HTMLElement {
  const row = document.createElement("div");
  row.className = "occurrence";
  row.innerHTML = `
    <span class="occurrence__path">
      <code>${escape(occ.basename)}</code>:${occ.line + 1}
      <span class="occurrence__parent">· ${escape(occ.parent)}</span>
    </span>`;
  row.title = occ.relPath;
  row.appendChild(
    targetButton(`Open ${occ.basename}:${occ.line + 1}`, () =>
      vscode.postMessage({
        type: "reveal",
        relPath: occ.relPath,
        line: occ.line,
        offset: occ.offset,
      }),
    ),
  );
  return row;
}

function brokenBody(rows: readonly WireBrokenReference[]): HTMLElement {
  if (rows.length === 0) return emptyState("No broken token references detected.");
  return truncatedList(rows, ROW_LIMIT, (r) => {
    const el = document.createElement("div");
    el.className = "row row--broken";
    el.innerHTML = `
      <div class="row__main">
        <b><code class="row__broken-name">${escape(r.name)}</code></b>
        <div class="row__sub">${escape(r.basename)}:${r.line + 1}</div>
      </div>`;
    el.appendChild(
      targetButton("Open declaration", () =>
        vscode.postMessage({
          type: "reveal",
          relPath: r.relPath,
          line: r.line,
          offset: r.offset,
        }),
      ),
    );
    return el;
  });
}

function unusedBody(tokens: readonly WireTokenLocation[]): HTMLElement {
  if (tokens.length === 0) return emptyState("No unused tokens found.");
  return truncatedList(tokens, ROW_LIMIT, (t) => {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row__main">
        <b>${escape(t.name)}</b>
        <span class="row__value">= ${escape(t.resolvedValue)}</span>
      </div>`;
    el.appendChild(locateButton(t));
    return el;
  });
}

function duplicateBody(
  clusters: readonly WireDuplicateCluster[],
): HTMLElement {
  if (clusters.length === 0) return emptyState("No duplicate tokens detected.");
  return truncatedList(clusters, CLUSTER_LIMIT, (c) => {
    const el = document.createElement("div");
    el.className = "row";
    const tokenLinks = c.tokens.map((t) => escape(t.name)).join(", ");
    el.innerHTML = `
      <div class="row__main">
        <div>
          <code>${escape(c.resolvedValue)}</code> —
          <b>${c.tokens.length}</b> tokens
          (canonical: <code>${escape(c.canonical.name)}</code>)
        </div>
        <div class="row__sub">${tokenLinks}</div>
      </div>`;
    el.appendChild(locateButton(c.canonical));
    return el;
  });
}

function incoherenceBody(rows: readonly WireIncoherence[]): HTMLElement {
  if (rows.length === 0) return emptyState("No semantic incoherence detected.");
  return truncatedList(rows, ROW_LIMIT, (r) => {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row__main">
        <b>${escape(r.token.name)}</b>
        <div class="row__sub">${escape(r.rationale)}</div>
      </div>`;
    el.appendChild(locateButton(r.token));
    return el;
  });
}

function coverageBody(report: WireAnalysisReport): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "coverage";
  const cov = report.coverage;
  const total = cov.tokenisedAssignments + cov.literalAssignments;
  const ratioPct = Math.round(cov.ratio * 100);
  const summary = document.createElement("div");
  summary.className = "coverage__summary";
  summary.innerHTML = `
    <b>${ratioPct}%</b> global coverage
    <span class="coverage__meta">(${cov.tokenisedAssignments} token refs · ${cov.literalAssignments} literals · ${total} total)</span>`;
  wrap.appendChild(summary);
  if (cov.sources.length === 0) {
    wrap.appendChild(emptyState("No token-source file in the selected scope."));
    return wrap;
  }
  const sub = document.createElement("div");
  sub.className = "coverage__sub";
  sub.innerHTML = `<i>Usage rate per <b>token-source file</b> (catalog → consumers):</i>`;
  wrap.appendChild(sub);
  for (const src of cov.sources) wrap.appendChild(sourceUsageRow(src));
  return wrap;
}

function sourceUsageRow(src: WireTokenSourceUsage): HTMLElement {
  const el = document.createElement("div");
  el.className = "source";
  const pct = Math.round(src.ratio * 100);
  el.innerHTML = `
    <div class="source__top">
      <span class="source__name" title="${escape(src.relPath)}">${escape(src.basename)}</span>
      <span class="source__caption">${pct}% (${src.used}/${src.declared} tokens used)</span>
    </div>
    <div class="source__bar">
      <div class="source__fill" style="width:${pct}%"></div>
    </div>`;
  el.appendChild(
    targetButton(`Open ${src.relPath}`, () =>
      vscode.postMessage({ type: "reveal", relPath: src.relPath }),
    ),
  );
  return el;
}

// ─── Row helpers ────────────────────────────────────────────────────────

function locateButton(loc: WireTokenLocation): HTMLElement {
  return targetButton("Open declaration", () =>
    vscode.postMessage({
      type: "reveal",
      relPath: loc.relPath,
      line: loc.line,
      offset: loc.offset,
    }),
  );
}

function targetButton(tooltip: string, onClick: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "target-btn";
  btn.title = tooltip;
  btn.setAttribute("aria-label", tooltip);
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
    <line x1="8" y1="0.5" x2="8" y2="3" stroke="currentColor" stroke-width="1.5"/>
    <line x1="8" y1="13" x2="8" y2="15.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="0.5" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.5"/>
    <line x1="13" y1="8" x2="15.5" y2="8" stroke="currentColor" stroke-width="1.5"/>
  </svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function emptyState(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "analyse-empty";
  p.textContent = text;
  return p;
}

function truncatedList<T>(
  items: readonly T[],
  limit: number,
  renderer: (item: T) => HTMLElement,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "list";
  const shown = items.slice(0, limit);
  for (const item of shown) wrap.appendChild(renderer(item));
  if (items.length > limit) {
    const remaining = items.slice(limit);
    const more = document.createElement("a");
    more.className = "more";
    more.href = "#";
    more.textContent = `+ ${remaining.length} more…`;
    more.addEventListener("click", (e) => {
      e.preventDefault();
      for (const item of remaining) wrap.insertBefore(renderer(item), more);
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
