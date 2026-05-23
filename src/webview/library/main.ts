// Library webview client.
//
// User-facing improvements vs. v1:
//
//   • **Multi-term search** — `"informative content"` matches
//     `--token-informative-highlight-content-hover` because every
//     term must appear in the haystack (name + value), order- and
//     case-insensitive. Tokens split on `[\s\-_]+`.
//   • **Kind chips** — a second filter row slices the Library by
//     `SCSS` / `CSS` / `JS-JSON`, mirroring the IntelliJ funnel popup.
//   • **No more whole-row click navigation**. Rows surface explicit
//     action buttons on the right side: copy, jump-to-declaration,
//     and (for tokens with variants) a `+N` badge that opens a
//     popover with the per-condition variant table.
//   • **Drag-and-drop** — rows are draggable; the dataTransfer
//     payload is the source-code form (`var(--x)`, `$x`, `'{path}'`)
//     so dropping into the editor inserts the right reference.
//
// State machine stays tiny: keep the latest `tokens` + `filterState`
// snapshots, re-render on change. A few thousand DOM nodes is well
// within budget; virtual scrolling would be premature.

import type {
  LibraryClientMessage,
  LibraryHostMessage,
  WireToken,
  WireVariantColumn,
} from "../shared/protocol";
import type { TokenCategory, TokenKind } from "../../model/designToken";

declare function acquireVsCodeApi(): {
  postMessage(msg: LibraryClientMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const vscode = acquireVsCodeApi();

/**
 * Persisted UI state (survives webview reloads via the VS Code state
 * API). We deliberately keep this small and self-healing — unknown
 * categories are dropped on read so a config refactor can't break the
 * panel.
 */
interface PersistedState {
  readonly collapsedCategories: readonly string[];
  readonly subfamilyGrouping: boolean;
}

function readPersisted(): PersistedState {
  const raw = vscode.getState<PersistedState>();
  return {
    collapsedCategories: Array.isArray(raw?.collapsedCategories)
      ? raw!.collapsedCategories.filter((s): s is string => typeof s === "string")
      : [],
    subfamilyGrouping: !!raw?.subfamilyGrouping,
  };
}

function persist(): void {
  vscode.setState<PersistedState>({
    collapsedCategories: [...state.collapsedCategories],
    subfamilyGrouping: state.subfamilyGrouping,
  });
}

// ─── Local state ────────────────────────────────────────────────────────

interface State {
  tokens: readonly WireToken[];
  query: string | null;
  categories: ReadonlySet<TokenCategory>;
  kinds: ReadonlySet<TokenKind>;
  scope: ScopeSnapshot | null;
  /** Category keys (the string form of TokenCategory) the user has collapsed. */
  collapsedCategories: Set<string>;
  /** Toggle from the filter dropdown — when on, list rows are nested
   *  under family + sub-family headers (algorithm port of the
   *  IntelliJ `detectSubfamilies`). */
  subfamilyGrouping: boolean;
}

interface ScopeSnapshot {
  readonly specificName: string | null;
  readonly activeNames: readonly string[];
  readonly idle: boolean;
}

const initialPersisted = readPersisted();
const state: State = {
  tokens: [],
  query: null,
  categories: new Set(),
  kinds: new Set(),
  scope: null,
  collapsedCategories: new Set(initialPersisted.collapsedCategories),
  subfamilyGrouping: initialPersisted.subfamilyGrouping,
};

// Display ordering — most-used categories first. New IntelliJ-parity
// categories slot in after their most semantically-adjacent existing
// bucket (BORDER near RADIUS, SIZING near SPACING, etc.). OTHER stays
// last as a catch-all.
const CATEGORY_ORDER: readonly TokenCategory[] = [
  "COLOR",
  "SPACING",
  "SIZING",
  "TYPOGRAPHY",
  "RADIUS",
  "BORDER",
  "SHADOW",
  "EFFECTS",
  "DURATION",
  "OPACITY",
  "LAYOUT",
  "Z_INDEX",
  "ICON",
  "OTHER",
];

/**
 * Display groups for kinds. CSS / SCSS / JS-JSON match the IntelliJ
 * funnel popup; the JS preset and runtime kinds (not indexed in the
 * VSCode MVP yet) all roll up under "JS-JSON" so when they arrive
 * the chip stays valid without UI churn.
 */
interface KindGroup {
  readonly label: string;
  readonly kinds: readonly TokenKind[];
}
const KIND_GROUPS: readonly KindGroup[] = [
  { label: "CSS", kinds: ["CSS_CUSTOM_PROPERTY"] },
  { label: "SCSS", kinds: ["SCSS_VARIABLE"] },
  {
    label: "JS-JSON",
    kinds: ["JS_OBJECT_PATH", "JS_RUNTIME_PROPERTY", "JS_RUNTIME_FUNCTION"],
  },
];

// ─── Bootstrap ──────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<LibraryHostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "tokens":
      state.tokens = msg.tokens;
      render();
      return;
    case "filterState":
      state.query = msg.query;
      state.categories = new Set(msg.categories);
      state.kinds = new Set(msg.kinds);
      syncSearchInput();
      render();
      return;
    case "scope":
      state.scope = {
        specificName: msg.specificName,
        activeNames: msg.activeNames,
        idle: msg.idle,
      };
      renderScopeStrip();
      return;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  wireSearchInput();
  wireScopeStrip();
  wireFilterDropdown();
  wireSubfamilyToggle();
  vscode.postMessage({ type: "ready" });
});

function wireSubfamilyToggle(): void {
  const cb = document.getElementById(
    "library-subfamily-toggle",
  ) as HTMLInputElement;
  cb.checked = state.subfamilyGrouping;
  cb.addEventListener("change", () => {
    state.subfamilyGrouping = cb.checked;
    persist();
    renderBody();
  });
}

function wireScopeStrip(): void {
  const btn = document.getElementById("library-scope") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });
}

function renderScopeStrip(): void {
  const valueEl = document.getElementById("library-scope-value")!;
  const btn = document.getElementById("library-scope") as HTMLButtonElement;
  if (!state.scope) {
    valueEl.textContent = "…";
    return;
  }
  if (state.scope.idle) {
    valueEl.textContent = "no stylesheet focused";
    btn.classList.add("scope-strip--idle");
    return;
  }
  btn.classList.remove("scope-strip--idle");
  // Show the deepest specific scope; tooltip carries the full chain so
  // power users can see "mobile + common" without polluting the UI.
  const specific = state.scope.specificName ?? "common";
  valueEl.textContent = specific;
  btn.title =
    state.scope.activeNames.length > 1
      ? `Active scopes: ${state.scope.activeNames.join(" + ")} (click to configure)`
      : `Active scope: ${specific} (click to configure)`;
}

// ─── Filter dropdown ────────────────────────────────────────────────────

function wireFilterDropdown(): void {
  const btn = document.getElementById("library-filter-btn") as HTMLButtonElement;
  const panel = document.getElementById("library-filter-panel")!;
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    panel.hidden ? open() : close();
  });
  // Click-outside dismissal — keep the panel close to a real dropdown.
  // Selection inside the panel re-renders chips but doesn't auto-close,
  // which matches IntelliJ's multi-select filter popup.
  document.addEventListener("click", (ev) => {
    if (panel.hidden) return;
    const target = ev.target as Node;
    if (panel.contains(target) || btn.contains(target)) return;
    close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !panel.hidden) {
      close();
      btn.focus();
    }
  });
}

function renderFilterCount(): void {
  const el = document.getElementById("library-filter-count") as HTMLElement;
  const n = state.categories.size + state.kinds.size;
  if (n === 0) {
    el.hidden = true;
    el.textContent = "0";
    return;
  }
  el.hidden = false;
  el.textContent = String(n);
}

// ─── Search input ───────────────────────────────────────────────────────

function wireSearchInput(): void {
  const input = document.getElementById("library-search") as HTMLInputElement;
  // Debounced so we don't flood the host on rapid typing. The host
  // echoes the value back via `filterState`; `syncSearchInput` guards
  // against overriding the input while the user is editing.
  let timer: number | undefined;
  input.addEventListener("input", () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      vscode.postMessage({ type: "setQuery", query: input.value });
    }, 150);
  });
}

/**
 * Mirrors the host's filter state into the input — but only when the
 * input doesn't have focus. The host may strip the value to null when
 * it's pure whitespace; reflecting that into a focused input would
 * eat characters the user just typed. When the input has focus we
 * trust the local value and skip the sync.
 */
function syncSearchInput(): void {
  const input = document.getElementById("library-search") as HTMLInputElement;
  if (document.activeElement === input) return;
  const target = state.query ?? "";
  if (input.value !== target) input.value = target;
}

// ─── Multi-term matching ────────────────────────────────────────────────

/**
 * Tokenises the query on whitespace + `-` + `_`, lowercases, drops
 * empty terms. Matches when EVERY term is a substring of the haystack
 * (name + " " + resolvedValue, lowercased). Order-insensitive — the
 * same UX the IntelliJ Library has shipped recently.
 */
function matchesQuery(token: WireToken): boolean {
  if (!state.query) return true;
  const terms = state.query
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = (token.name + " " + token.resolvedValue).toLowerCase();
  for (const t of terms) if (!hay.includes(t)) return false;
  return true;
}

// ─── Render ─────────────────────────────────────────────────────────────

function render(): void {
  renderCategoryChips();
  renderKindChips();
  renderFilterCount();
  renderBody();
}

function renderCategoryChips(): void {
  const host = document.getElementById("library-chips")!;
  const present = new Set<TokenCategory>();
  for (const t of state.tokens) present.add(t.category);
  const items = CATEGORY_ORDER.filter((c) => present.has(c));

  host.innerHTML = "";
  for (const cat of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.category = cat;
    if (state.categories.has(cat)) chip.classList.add("chip--active");
    chip.textContent = prettyCategory(cat);
    chip.addEventListener("click", () => {
      vscode.postMessage({ type: "toggleCategory", category: cat });
    });
    host.appendChild(chip);
  }
}

function renderKindChips(): void {
  const host = document.getElementById("library-kind-chips")!;
  // Build the present-kinds set so we don't show chips for kinds that
  // never appear in the index (CSS-only project would otherwise see
  // a useless "JS-JSON" chip).
  const present = new Set<TokenKind>();
  for (const t of state.tokens) present.add(t.kind);

  host.innerHTML = "";
  for (const group of KIND_GROUPS) {
    const groupKinds = group.kinds.filter((k) => present.has(k));
    if (groupKinds.length === 0) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    // A group is "active" when ALL its constituent kinds are active.
    const isActive = groupKinds.every((k) => state.kinds.has(k));
    if (isActive) chip.classList.add("chip--active");
    chip.textContent = group.label;
    chip.addEventListener("click", () => {
      // Toggle every kind in the group together — clicking "JS-JSON"
      // shouldn't leave one of the three sub-kinds out of sync.
      for (const k of groupKinds) {
        vscode.postMessage({ type: "toggleKind", kind: k });
      }
    });
    host.appendChild(chip);
  }
}

function renderBody(): void {
  const body = document.getElementById("library-body")!;
  body.innerHTML = "";

  const filtered = applyFilter(state.tokens);
  if (filtered.length === 0) {
    body.innerHTML = `<p class="library-empty">${
      state.tokens.length === 0
        ? "No tokens indexed yet. Try `Token Flow: Refresh Token Index`."
        : "No tokens match the current filters."
    }</p>`;
    return;
  }

  // Group by category for stable visual chunks. Alphabetical within.
  const byCategory = new Map<TokenCategory, WireToken[]>();
  for (const t of filtered) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  for (const cat of CATEGORY_ORDER) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));

    const section = document.createElement("section");
    section.className = "category";
    section.dataset.category = cat;
    const collapsed = state.collapsedCategories.has(cat);
    section.dataset.collapsed = collapsed ? "true" : "false";
    section.appendChild(buildCategoryHeader(cat, list.length, section));

    // When grouping is on, try to split the category into hierarchical
    // buckets. `detectSubfamilies` returns null when grouping wouldn't
    // add information (≤3 tokens, single family + single sub-bucket,
    // etc.), in which case we fall back to the flat list.
    const buckets = state.subfamilyGrouping ? detectSubfamilies(list) : null;
    if (!buckets) {
      const ul = document.createElement("ul");
      ul.className = "tokens";
      for (const tok of list) ul.appendChild(buildTokenRow(tok));
      section.appendChild(ul);
    } else {
      renderSubfamilyBuckets(section, buckets);
    }
    body.appendChild(section);
  }
}

function buildCategoryHeader(
  cat: TokenCategory,
  count: number,
  section: HTMLElement,
): HTMLElement {
  const h = document.createElement("h3");
  h.className = "category__header";
  h.setAttribute("role", "button");
  h.tabIndex = 0;
  h.setAttribute(
    "aria-expanded",
    state.collapsedCategories.has(cat) ? "false" : "true",
  );

  const chevron = document.createElement("span");
  chevron.className = "category__chevron";
  chevron.textContent = "▾";
  chevron.setAttribute("aria-hidden", "true");

  const title = document.createElement("span");
  title.className = "category__title";
  title.textContent = prettyCategory(cat);

  const counter = document.createElement("span");
  counter.className = "category__count";
  counter.textContent = `· ${count}`;

  h.append(chevron, title, counter);

  const toggle = () => {
    const now = !state.collapsedCategories.has(cat);
    if (now) state.collapsedCategories.add(cat);
    else state.collapsedCategories.delete(cat);
    section.dataset.collapsed = now ? "true" : "false";
    h.setAttribute("aria-expanded", now ? "false" : "true");
    persist();
  };
  h.addEventListener("click", toggle);
  h.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });
  return h;
}

// ─── Sub-family grouping ────────────────────────────────────────────────

interface SubfamilyBucket {
  readonly familyKey: string | null;
  readonly familyLabel: string | null;
  readonly subfamilyLabel: string | null;
  readonly indentLevel: 0 | 1 | 2;
  readonly tokens: readonly WireToken[];
}

/**
 * Port of `PopupRow.detectSubfamilies` from the IntelliJ side. Splits a
 * single category's worth of tokens into a hierarchical family /
 * sub-family layout. The algorithm is entirely name-structural — no
 * hard-coded vocabulary — so it adapts to any naming convention.
 *
 * Pipeline:
 *   1. Parse every name into segments (split on `.` / `-`) and strip
 *      the longest segment-aligned prefix shared by all tokens.
 *   2. Trim the trailing state (e.g. `default` / `hover`) so structural
 *      differences drive the grouping, not variant suffixes.
 *   3. The remaining segments form a hierarchy path:
 *        segs[0]    → family    (e.g. `high`, `low`, `primary`)
 *        segs[1..n] → sub-family path (e.g. `surface`, `content`)
 *   4. Single-token buckets fold back into a tail "Other" pile so we
 *      don't render rows of one.
 *
 * Returns null when grouping wouldn't add information (too few tokens,
 * single family with single sub-bucket, all noise).
 */
function detectSubfamilies(
  sorted: readonly WireToken[],
): SubfamilyBucket[] | null {
  if (sorted.length < 4) return null;
  const parsed = sorted.map((t) => ({
    token: t,
    segs: segmentsOf(t.name),
  }));
  if (parsed.some((p) => p.segs.length === 0)) return null;

  // Longest common prefix segments across every token in this category.
  const minLen = parsed.reduce((n, p) => Math.min(n, p.segs.length), Infinity);
  let commonLen = 0;
  while (commonLen < minLen) {
    const pivot = parsed[0].segs[commonLen];
    if (
      parsed.every(
        (p) => p.segs[commonLen].toLowerCase() === pivot.toLowerCase(),
      )
    )
      commonLen++;
    else break;
  }

  // (family, sub[]) → tokens
  const grouping = new Map<string, WireToken[]>();
  const groupMeta = new Map<string, { family: string | null; sub: string[] }>();
  const others: WireToken[] = [];
  for (const { token, segs } of parsed) {
    const remainder = segs.slice(commonLen);
    // Drop the trailing state segment so `surface.default` and
    // `surface.hover` land in the same bucket.
    const structural = remainder.length >= 2 ? remainder.slice(0, -1) : remainder;
    if (structural.length === 0) {
      others.push(token);
      continue;
    }
    const family = structural[0].toLowerCase();
    const sub = structural.slice(1).map((s) => s.toLowerCase());
    const key = `${family}|${sub.join("/")}`;
    if (!grouping.has(key)) {
      grouping.set(key, []);
      groupMeta.set(key, { family, sub });
    }
    grouping.get(key)!.push(token);
  }

  // Demote single-token buckets into the "Other" pile.
  for (const [key, list] of [...grouping]) {
    if (list.length < 2) {
      others.push(...list);
      grouping.delete(key);
      groupMeta.delete(key);
    }
  }
  if (grouping.size === 0) return null;

  // Single family + single sub-bucket = just a flat list, not worth it.
  const families = new Set<string | null>();
  for (const m of groupMeta.values()) families.add(m.family);
  if (families.size <= 1 && grouping.size === 1 && others.length === 0) {
    return null;
  }

  // Order: family-by-first-appearance, sub-alphabetical inside.
  const byFamily = new Map<string | null, { key: string; sub: string[]; tokens: WireToken[] }[]>();
  for (const [key, tokens] of grouping) {
    const meta = groupMeta.get(key)!;
    const entry = { key, sub: meta.sub, tokens };
    if (!byFamily.has(meta.family)) byFamily.set(meta.family, []);
    byFamily.get(meta.family)!.push(entry);
  }
  const buckets: SubfamilyBucket[] = [];
  for (const [family, entries] of byFamily) {
    entries.sort((a, b) => a.sub.join("/").localeCompare(b.sub.join("/")));
    const familyLabel = family ? capitalize(family) : null;
    const familyHasMultipleSubs = entries.length > 1;
    for (const e of entries) {
      const subLabel =
        e.sub.length === 0
          ? null
          : e.sub.map(capitalize).join(" › ");
      const keepSubHeader = subLabel !== null && (familyHasMultipleSubs || e.sub.length > 0);
      const indentLevel: 0 | 1 | 2 = keepSubHeader ? 2 : family !== null ? 1 : 0;
      buckets.push({
        familyKey: family,
        familyLabel,
        subfamilyLabel: keepSubHeader ? subLabel : null,
        indentLevel,
        tokens: [...e.tokens].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
  if (others.length > 0) {
    buckets.push({
      familyKey: null,
      familyLabel: null,
      subfamilyLabel: null,
      indentLevel: 0,
      tokens: [...others].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return buckets;
}

function segmentsOf(name: string): string[] {
  const stripped = name.replace(/^--/, "").replace(/^\$/, "");
  if (!stripped) return [];
  return stripped.split(/[.-]/).filter((s) => s.length > 0);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.substring(1);
}

function renderSubfamilyBuckets(
  section: HTMLElement,
  buckets: readonly SubfamilyBucket[],
): void {
  let lastFamily: string | null | undefined = undefined;
  for (const bucket of buckets) {
    if (bucket.familyKey !== lastFamily) {
      if (bucket.familyLabel !== null) {
        const fh = document.createElement("h4");
        fh.className = "family-header";
        fh.textContent = bucket.familyLabel;
        section.appendChild(fh);
      }
      lastFamily = bucket.familyKey;
    }
    if (bucket.subfamilyLabel !== null) {
      const sh = document.createElement("h5");
      sh.className = "subfamily-header";
      sh.textContent = bucket.subfamilyLabel;
      section.appendChild(sh);
    }
    const ul = document.createElement("ul");
    ul.className =
      bucket.indentLevel === 2
        ? "tokens tokens--indent-2"
        : bucket.indentLevel === 1
          ? "tokens tokens--indent-1"
          : "tokens";
    for (const tok of bucket.tokens) ul.appendChild(buildTokenRow(tok));
    section.appendChild(ul);
  }
}

// ─── Token row ──────────────────────────────────────────────────────────

function buildTokenRow(token: WireToken): HTMLElement {
  const li = document.createElement("li");
  li.className = "token";
  li.dataset.name = token.name;
  // Draggable into the editor — VSCode accepts `text/plain` drops
  // and inserts the payload at the drop position. `effectAllowed` =
  // "copy" makes the cursor read as such; we never move data.
  li.draggable = true;
  li.addEventListener("dragstart", (ev) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData("text/plain", token.insertText);
  });

  // Swatch — colored disk if we have a hex, category glyph otherwise.
  const swatch = document.createElement("span");
  swatch.className = "token__swatch";
  if (token.hex) {
    swatch.classList.add("token__swatch--color");
    swatch.style.backgroundColor = token.hex;
  } else {
    swatch.classList.add("token__swatch--glyph");
    swatch.textContent = CATEGORY_GLYPHS[token.category] ?? "·";
  }

  // Body: name on top, resolved value beneath.
  const body = document.createElement("div");
  body.className = "token__body";
  const name = document.createElement("span");
  name.className = "token__name";
  name.textContent = token.name;
  const value = document.createElement("span");
  value.className = "token__value";
  value.textContent = token.resolvedValue;
  body.append(name, value);

  // Trailing actions: variant badge → popover, copy, goto.
  const actions = document.createElement("span");
  actions.className = "token__actions";

  if (token.variantCount > 0) {
    actions.appendChild(buildVariantBadge(token));
  }
  actions.appendChild(
    iconButton("⎘", "Copy insertion form to clipboard", () => {
      vscode.postMessage({ type: "copyToken", name: token.name });
    }),
  );
  actions.appendChild(
    iconButton("↗", "Go to declaration", () => {
      vscode.postMessage({ type: "revealToken", name: token.name });
    }),
  );

  li.append(swatch, body, actions);
  return li;
}

// ─── Variant popover ────────────────────────────────────────────────────

/**
 * Builds the `+N` badge. Hover (or focus) opens a popover positioned
 * absolutely below the badge with the full variant table. A small
 * dismissal timer lets the user move the cursor from badge → popover
 * without losing it; entering the popover cancels the timer.
 */
function buildVariantBadge(token: WireToken): HTMLElement {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "token__badge";
  badge.textContent = `+${token.variantCount}`;
  badge.title = `${token.variantCount} variant(s) — hover to see them`;

  let popover: HTMLElement | null = null;
  let dismissTimer: number | undefined;

  const show = () => {
    if (dismissTimer) window.clearTimeout(dismissTimer);
    if (popover) return;
    popover = buildVariantPopover(token);
    document.body.appendChild(popover);
    positionPopover(popover, badge);
    popover.addEventListener("mouseenter", show);
    popover.addEventListener("mouseleave", scheduleDismiss);
  };
  const scheduleDismiss = () => {
    if (dismissTimer) window.clearTimeout(dismissTimer);
    dismissTimer = window.setTimeout(() => {
      popover?.remove();
      popover = null;
    }, 200);
  };

  badge.addEventListener("mouseenter", show);
  badge.addEventListener("focus", show);
  badge.addEventListener("mouseleave", scheduleDismiss);
  badge.addEventListener("blur", scheduleDismiss);
  badge.addEventListener("click", show); //                      tap-friendly

  return badge;
}

function buildVariantPopover(token: WireToken): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "variant-popover";

  const title = document.createElement("div");
  title.className = "variant-popover__title";
  title.textContent = token.name;
  pop.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "variant-popover__sub";
  sub.textContent = `${token.category.toLowerCase()} · ${
    token.variantColumns.length
  } column(s)`;
  pop.appendChild(sub);

  pop.appendChild(buildVariantTable(token.variantColumns));
  return pop;
}

function buildVariantTable(
  cols: readonly WireVariantColumn[],
): HTMLElement {
  const themes = [...new Set(cols.map((c) => c.theme).filter((t) => t))];
  const grouped = themes.length >= 2;

  const table = document.createElement("table");
  table.className = "variant-table";

  // Group consecutive columns by theme so themes span their members
  // (mirrors the IntelliJ multi-row header).
  const headerThemes = document.createElement("tr");
  if (grouped) {
    interface Group {
      theme: string | null;
      span: number;
    }
    const groups: Group[] = [];
    for (const c of cols) {
      const last = groups[groups.length - 1];
      if (last && last.theme === c.theme) last.span++;
      else groups.push({ theme: c.theme, span: 1 });
    }
    for (const g of groups) {
      const th = document.createElement("th");
      th.colSpan = g.span;
      th.className = "variant-table__theme";
      th.textContent = g.theme ?? "—";
      headerThemes.appendChild(th);
    }
    table.appendChild(headerThemes);
  }

  const subRow = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.className = "variant-table__sub";
    th.textContent = c.sub;
    subRow.appendChild(th);
  }
  table.appendChild(subRow);

  const valueRow = document.createElement("tr");
  for (const c of cols) {
    const td = document.createElement("td");
    td.className = "variant-table__value";
    if (c.hex) {
      const sw = document.createElement("span");
      sw.className = "variant-table__swatch";
      sw.style.backgroundColor = c.hex;
      td.appendChild(sw);
    }
    const text = document.createElement("code");
    text.textContent = c.value;
    td.appendChild(text);
    valueRow.appendChild(td);
  }
  table.appendChild(valueRow);
  return table;
}

/**
 * Positions [popover] right below [anchor], horizontally aligned to
 * its right edge. Clamps to the viewport so the popover doesn't get
 * clipped near the panel's bottom or left edge.
 */
function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // Render once invisibly to measure.
  popover.style.position = "fixed";
  popover.style.visibility = "hidden";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popRect = popover.getBoundingClientRect();

  let left = rect.right - popRect.width;
  if (left < 8) left = 8;
  let top = rect.bottom + 4;
  if (top + popRect.height > window.innerHeight - 8) {
    // Flip above the anchor if there isn't enough room below.
    top = rect.top - popRect.height - 4;
    if (top < 8) top = 8;
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = "visible";
}

// ─── Filtering ──────────────────────────────────────────────────────────

function applyFilter(tokens: readonly WireToken[]): WireToken[] {
  return tokens.filter((t) => {
    if (state.categories.size > 0 && !state.categories.has(t.category)) {
      return false;
    }
    if (state.kinds.size > 0 && !state.kinds.has(t.kind)) {
      return false;
    }
    if (!matchesQuery(t)) return false;
    return true;
  });
}

// ─── Small builders ─────────────────────────────────────────────────────

function iconButton(
  glyph: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "token__btn";
  btn.title = title;
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

const CATEGORY_GLYPHS: Record<TokenCategory, string> = {
  COLOR: "●",
  SPACING: "↔",
  TYPOGRAPHY: "T",
  SHADOW: "▣",
  RADIUS: "◖",
  DURATION: "⏱",
  Z_INDEX: "≡",
  // IntelliJ-parity additions (Phase 6).
  EFFECTS: "✦",
  LAYOUT: "▦",
  SIZING: "⤢",
  BORDER: "▭",
  OPACITY: "◐",
  ICON: "★",
  OTHER: "·",
};

function prettyCategory(c: TokenCategory): string {
  if (c === "Z_INDEX") return "Z-index";
  return c[0] + c.substring(1).toLowerCase();
}
