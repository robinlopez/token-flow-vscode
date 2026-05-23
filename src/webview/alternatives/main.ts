// Alternatives picker client. Renders the candidate list as a
// centered modal-style card with group headers, inline color
// swatches, a search field and full keyboard navigation.
//
// Selection model: a single `selectedIndex` into the **visible** flat
// list (filter-aware). Up/Down moves it, Enter submits, Esc cancels.
// Mouse hover preview-selects so click feels predictable. Group
// headers are non-selectable rows interleaved with token rows.

import type {
  AltClientMessage,
  AltHostMessage,
  WireAltCandidate,
  WireAltGroup,
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(msg: AltClientMessage): void;
};

const vscode = acquireVsCodeApi();

// ─── State ──────────────────────────────────────────────────────────────

interface InitData {
  title: string;
  subtitle: string;
  tokens: readonly WireAltCandidate[];
  groups: readonly WireAltGroup[];
}

interface State {
  init: InitData | null;
  query: string;
  /** Flat index into the original `tokens` array. */
  selectedTokenIndex: number;
}

const state: State = { init: null, query: "", selectedTokenIndex: 0 };

// Mirror of the rendered list — populated on every render so keyboard
// navigation knows the order of visible token indices (post-filter).
let visibleTokenIndices: number[] = [];

// ─── Bootstrap ──────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<AltHostMessage>) => {
  if (event.data.type !== "init") return;
  state.init = {
    title: event.data.title,
    subtitle: event.data.subtitle,
    tokens: event.data.tokens,
    groups: event.data.groups,
  };
  state.selectedTokenIndex = event.data.preselectIndex;
  state.query = "";
  render();
  focusInput();
  // The preselected row may be far down the list (long sibling sets
  // are common for color tokens). Without scrolling, the highlighted
  // row sits below the viewport on first paint and the user sees
  // index 0 instead. `block: "center"` keeps the row roughly mid-
  // viewport so the surrounding siblings are also visible — handy
  // because Alt+T is usually followed by ↑/↓ to compare.
  scrollSelectedIntoView("center");
});

document.addEventListener("DOMContentLoaded", () => {
  wireGlobalKeyboard();
  vscode.postMessage({ type: "ready" });
});

// ─── Keyboard ───────────────────────────────────────────────────────────

function wireGlobalKeyboard(): void {
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      vscode.postMessage({ type: "cancel" });
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      moveSelection(1);
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      moveSelection(-1);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
      return;
    }
  });
}

function moveSelection(delta: number): void {
  if (visibleTokenIndices.length === 0) return;
  const currentPos = visibleTokenIndices.indexOf(state.selectedTokenIndex);
  const startPos = currentPos < 0 ? 0 : currentPos;
  const nextPos =
    (startPos + delta + visibleTokenIndices.length) %
    visibleTokenIndices.length;
  state.selectedTokenIndex = visibleTokenIndices[nextPos];
  updateSelectionDom();
  scrollSelectedIntoView();
}

function submit(): void {
  if (visibleTokenIndices.includes(state.selectedTokenIndex)) {
    vscode.postMessage({
      type: "select",
      index: state.selectedTokenIndex,
    });
  }
}

// ─── Filtering ──────────────────────────────────────────────────────────

function matchesQuery(token: WireAltCandidate, query: string): boolean {
  if (!query) return true;
  const terms = query
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = (token.name + " " + token.value).toLowerCase();
  for (const t of terms) if (!hay.includes(t)) return false;
  return true;
}

// ─── Render ─────────────────────────────────────────────────────────────

function render(): void {
  if (!state.init) return;
  const root = document.getElementById("picker-root")!;
  root.innerHTML = "";
  root.appendChild(buildCard());
}

function buildCard(): HTMLElement {
  const card = document.createElement("div");
  card.className = "picker";
  card.appendChild(buildHeader());
  card.appendChild(buildList());
  card.appendChild(buildFooter());
  return card;
}

function buildHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "picker__header";

  const title = document.createElement("h1");
  title.className = "picker__title";
  title.textContent = state.init!.title;

  const sub = document.createElement("p");
  sub.className = "picker__subtitle";
  sub.textContent = state.init!.subtitle;

  const search = document.createElement("input");
  search.id = "picker-search";
  search.type = "search";
  search.className = "picker__search";
  search.placeholder = "Type to filter (multi-term: name · value)";
  search.autocomplete = "off";
  search.value = state.query;
  search.addEventListener("input", () => {
    state.query = search.value;
    rerenderList();
  });

  header.append(title, sub, search);
  return header;
}

function buildList(): HTMLElement {
  const list = document.createElement("div");
  list.id = "picker-list";
  list.className = "picker__list";
  list.append(...buildListContents());
  return list;
}

function buildListContents(): HTMLElement[] {
  if (!state.init) return [];
  const visibleByGroup: { group: WireAltGroup; tokens: number[] }[] = [];
  let visibleFlat: number[] = [];

  for (const group of state.init.groups) {
    const indices = group.tokenIndices.filter((i) =>
      matchesQuery(state.init!.tokens[i], state.query),
    );
    if (indices.length === 0) continue;
    visibleByGroup.push({ group, tokens: indices });
    visibleFlat = visibleFlat.concat(indices);
  }
  visibleTokenIndices = visibleFlat;

  // Clamp selection — the user may have just filtered the current
  // selection out of view. Fall back to the first visible token.
  if (
    visibleFlat.length > 0 &&
    !visibleFlat.includes(state.selectedTokenIndex)
  ) {
    state.selectedTokenIndex = visibleFlat[0];
  }

  if (visibleFlat.length === 0) {
    const empty = document.createElement("p");
    empty.className = "picker__empty";
    empty.textContent = "No matches.";
    return [empty];
  }

  const showHeaders = visibleByGroup.length > 1;
  const out: HTMLElement[] = [];
  for (const { group, tokens } of visibleByGroup) {
    if (showHeaders) out.push(buildGroupHeader(group));
    for (const idx of tokens) {
      out.push(buildRow(idx, state.init!.tokens[idx]));
    }
  }
  return out;
}

function buildGroupHeader(group: WireAltGroup): HTMLElement {
  const h = document.createElement("div");
  h.className = "picker__group";
  // Empty-path group (the catch-all bucket) gets a generic "OTHER"
  // label so users see SOMETHING above the rows — matches the
  // IntelliJ funnel popup convention.
  h.textContent =
    group.pathSegments.length === 0
      ? "OTHER"
      : group.pathSegments.map((s) => s.toUpperCase()).join(" › ");
  return h;
}

function buildRow(index: number, token: WireAltCandidate): HTMLElement {
  const row = document.createElement("div");
  row.className = "picker__row";
  row.dataset.tokenIndex = String(index);
  if (index === state.selectedTokenIndex) {
    row.classList.add("picker__row--selected");
  }
  row.addEventListener("click", () => {
    state.selectedTokenIndex = index;
    submit();
  });
  row.addEventListener("mouseenter", () => {
    if (state.selectedTokenIndex === index) return;
    state.selectedTokenIndex = index;
    updateSelectionDom();
  });

  row.appendChild(buildIcon(token));

  const name = document.createElement("span");
  name.className = "picker__name";
  name.textContent = token.name;
  row.appendChild(name);

  // Right-aligned cluster: +N then the value, mirrors the IntelliJ
  // `+1 #aeaeae` layout the user showed in their screenshots.
  const meta = document.createElement("span");
  meta.className = "picker__meta";
  if (token.variantCount > 0) {
    const variants = document.createElement("span");
    variants.className = "picker__variants";
    variants.textContent = `+${token.variantCount}`;
    meta.appendChild(variants);
  }
  const value = document.createElement("span");
  value.className = "picker__value";
  value.textContent = token.value;
  meta.appendChild(value);
  row.appendChild(meta);

  return row;
}

function buildIcon(token: WireAltCandidate): HTMLElement {
  const icon = document.createElement("span");
  if (token.hex) {
    icon.className = "picker__swatch";
    icon.style.backgroundColor = token.hex;
  } else {
    icon.className = "picker__glyph";
    icon.textContent = ICON_GLYPHS[token.categoryIcon] ?? "·";
  }
  return icon;
}

function buildFooter(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "picker__footer";
  footer.innerHTML = `
    <span class="picker__hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
    <span class="picker__hint"><kbd>↵</kbd> select</span>
    <span class="picker__hint"><kbd>Esc</kbd> cancel</span>
  `;
  return footer;
}

// ─── Incremental updates ────────────────────────────────────────────────

/**
 * Re-renders only the list section (not the header) so the search
 * input keeps focus and caret position when filtering live. Cheaper
 * than `render()` and avoids the "field loses focus on every
 * keystroke" UX trap.
 */
function rerenderList(): void {
  const list = document.getElementById("picker-list");
  if (!list) return;
  list.innerHTML = "";
  list.append(...buildListContents());
}

/**
 * Patches the selection class on rows without rebuilding the DOM —
 * keyboard navigation needs to feel instant and the rows are
 * otherwise unchanged between selection moves.
 */
function updateSelectionDom(): void {
  const rows = document.querySelectorAll<HTMLDivElement>(".picker__row");
  rows.forEach((row) => {
    const idx = Number(row.dataset.tokenIndex);
    if (idx === state.selectedTokenIndex) {
      row.classList.add("picker__row--selected");
    } else {
      row.classList.remove("picker__row--selected");
    }
  });
}

function scrollSelectedIntoView(
  block: ScrollLogicalPosition = "nearest",
): void {
  const row = document.querySelector<HTMLDivElement>(
    `.picker__row[data-token-index="${state.selectedTokenIndex}"]`,
  );
  if (!row) return;
  row.scrollIntoView({ block, inline: "nearest" });
}

function focusInput(): void {
  const input = document.getElementById(
    "picker-search",
  ) as HTMLInputElement | null;
  input?.focus();
}

// ─── Codicon glyph table ────────────────────────────────────────────────
//
// We can't actually render VSCode codicons inside a webview without
// loading the codicon font, which is a non-trivial CSP + bundling
// task. As a lightweight substitute, map each category icon name to
// a single Unicode glyph that reads at-a-glance for what the row
// represents. The glyph is tiny — primarily there so the icon column
// width is consistent across COLOR rows (swatches) and non-color
// rows.

const ICON_GLYPHS: Record<string, string> = {
  "symbol-color": "●",
  "symbol-ruler": "↔",
  "symbol-text": "T",
  "symbol-misc": "▣",
  "symbol-namespace": "◖",
  watch: "⏱",
  layers: "≡",
};
