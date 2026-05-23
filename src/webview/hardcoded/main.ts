// Hardcoded panel client. Renders the active editor's matches as
// IntelliJ-style rows:
//
//   [✓] [swatch] literal  →  [swatch] candidate-name  :line  [▾] [⌖] [⇄]
//
//   ✓  per-row checkbox for bulk apply
//   ▾  cycle through alternative candidates (when N > 1)
//   ⌖  jump to the source line
//   ⇄  apply the replacement (single-row; the footer applies the batch)
//
// State per row: `currentCandidateIndex` + `selected` flag, both kept
// module-local in maps keyed by a stable row id (relPath +
// replaceStart). Reset whenever a fresh `matches` message lands — by
// then the row's identity may have shifted (lines renumbered after an
// edit, etc.).
//
// Header carries a multi-term search field and a filter-dropdown
// (Kinds: COLOR / LENGTH / DURATION) — same pattern as the Library so
// the user has a single mental model across both panels.
//
// Bulk apply: the footer materialises into view when at least one row
// is checked; clicking "Apply selected" sends an `applyBatch` message
// the host resolves into a single `WorkspaceEdit`.

import type {
  HardcodedClientMessage,
  HardcodedHostMessage,
  WireHardcodedMatch,
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(msg: HardcodedClientMessage): void;
};

const vscode = acquireVsCodeApi();

type Kind = WireHardcodedMatch["kind"];

interface State {
  /** null while we haven't received any snapshot yet (initial paint). */
  matches: readonly WireHardcodedMatch[] | null;
  relPath: string | null;
  scanning: boolean;
  /** "no stylesheet currently focused" — empty panel state. */
  inactive: boolean;
  query: string;
  kinds: Set<Kind>;
}

const state: State = {
  matches: null,
  relPath: null,
  scanning: true,
  inactive: false,
  query: "",
  kinds: new Set(),
};

const candidateCursors = new Map<string, number>();
const selected = new Set<string>();

window.addEventListener(
  "message",
  (event: MessageEvent<HardcodedHostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "matches":
        state.matches = msg.matches;
        state.relPath = msg.relPath;
        state.scanning = msg.scanning;
        state.inactive = false;
        closeOpenDropdown(); //                                     no dangling popover anchored to a gone row
        candidateCursors.clear(); //                                fresh dataset → reset cursors
        // Drop selections whose rows are no longer present so the
        // bulk footer count stays honest after a re-scan.
        const validKeys = new Set(msg.matches.map(rowKey));
        for (const k of [...selected]) if (!validKeys.has(k)) selected.delete(k);
        render();
        return;
      case "scanning":
        state.scanning = msg.scanning;
        renderHeader();
        return;
      case "noActiveStylesheet":
        state.matches = null;
        state.relPath = null;
        state.scanning = false;
        state.inactive = true;
        selected.clear();
        render();
        return;
    }
  },
);

document.addEventListener("DOMContentLoaded", () => {
  wireRefresh();
  wireSearch();
  wireFilterDropdown();
  wireBulkBar();
  wireSelectAll();
  vscode.postMessage({ type: "ready" });
});

// ─── Wiring ─────────────────────────────────────────────────────────────

function wireRefresh(): void {
  const btn = document.getElementById("hardcoded-refresh") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
}

function wireSearch(): void {
  const input = document.getElementById("hardcoded-search") as HTMLInputElement;
  let timer: number | undefined;
  input.addEventListener("input", () => {
    if (timer) window.clearTimeout(timer);
    // Debounce identical to the Library — keeps the re-render budget
    // under control on fast typing.
    timer = window.setTimeout(() => {
      state.query = input.value;
      renderBody();
      renderBulkBar();
    }, 100);
  });
}

function wireFilterDropdown(): void {
  const btn = document.getElementById("hardcoded-filter-btn") as HTMLButtonElement;
  const panel = document.getElementById("hardcoded-filter-panel")!;
  const open = () => {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    panel.hidden ? open() : close();
  });
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

function wireBulkBar(): void {
  const clear = document.getElementById("hardcoded-bulk-clear") as HTMLButtonElement;
  const apply = document.getElementById("hardcoded-bulk-apply") as HTMLButtonElement;
  clear.addEventListener("click", () => {
    selected.clear();
    render();
  });
  apply.addEventListener("click", () => {
    const matches = state.matches ?? [];
    const edits: HardcodedClientMessage = {
      type: "applyBatch",
      edits: matches
        .filter((m) => selected.has(rowKey(m)))
        .map((m) => {
          const cursor = candidateCursors.get(rowKey(m)) ?? 0;
          const cand = m.candidates[cursor] ?? m.candidates[0];
          return {
            relPath: m.relPath,
            replaceStart: m.replaceStart,
            replaceEndExclusive: m.replaceEndExclusive,
            replacement: cand.replacement,
          };
        }),
    };
    if (edits.type === "applyBatch" && edits.edits.length === 0) return;
    vscode.postMessage(edits);
    selected.clear();
    // The host will trigger a rescan; we render now so the UI feels
    // instant (rows fade as the bar collapses).
    render();
  });
}

function wireSelectAll(): void {
  const checkbox = document.getElementById("hardcoded-select-all") as HTMLInputElement;
  checkbox.addEventListener("change", () => {
    const visible = currentlyVisible();
    if (checkbox.checked) {
      for (const m of visible) selected.add(rowKey(m));
    } else {
      for (const m of visible) selected.delete(rowKey(m));
    }
    renderBody();
    renderBulkBar();
  });
}

// ─── Rendering ──────────────────────────────────────────────────────────

function render(): void {
  renderHeader();
  renderKindChips();
  renderFilterCount();
  renderBody();
  renderBulkBar();
  renderSelectAllVisibility();
}

function renderHeader(): void {
  const title = document.getElementById("hardcoded-title")!;
  if (state.inactive) {
    title.textContent = "Hardcoded values";
    return;
  }
  if (state.scanning) {
    title.textContent = "Hardcoded values · scanning…";
    return;
  }
  if (state.relPath) {
    const filename = state.relPath.includes("/")
      ? state.relPath.substring(state.relPath.lastIndexOf("/") + 1)
      : state.relPath;
    const n = state.matches?.length ?? 0;
    title.textContent = `${filename} · ${n} hit${n === 1 ? "" : "s"}`;
    title.title = state.relPath; //                                tooltip = full path
    return;
  }
  title.textContent = "Hardcoded values";
}

function renderKindChips(): void {
  const host = document.getElementById("hardcoded-kind-chips")!;
  host.innerHTML = "";
  // Only show chips for kinds actually present in the current matches —
  // a CSS-only file shouldn't see a useless DURATION chip.
  const present = new Set<Kind>();
  for (const m of state.matches ?? []) present.add(m.kind);
  const ordered: Kind[] = ["COLOR", "LENGTH", "DURATION"];
  for (const k of ordered) {
    if (!present.has(k)) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (state.kinds.has(k)) chip.classList.add("chip--active");
    chip.textContent = prettyKind(k);
    chip.addEventListener("click", () => {
      if (state.kinds.has(k)) state.kinds.delete(k);
      else state.kinds.add(k);
      renderKindChips();
      renderFilterCount();
      renderBody();
      renderBulkBar();
      renderSelectAllVisibility();
    });
    host.appendChild(chip);
  }
}

function renderFilterCount(): void {
  const el = document.getElementById("hardcoded-filter-count") as HTMLElement;
  if (state.kinds.size === 0) {
    el.hidden = true;
    el.textContent = "0";
    return;
  }
  el.hidden = false;
  el.textContent = String(state.kinds.size);
}

function renderBody(): void {
  const body = document.getElementById("hardcoded-body")!;
  body.innerHTML = "";

  if (state.inactive) {
    body.appendChild(emptyState("Open a stylesheet file to see its hardcoded values."));
    return;
  }
  if (state.matches === null) {
    body.appendChild(emptyState("Scanning…"));
    return;
  }

  const filtered = currentlyVisible();
  if (filtered.length === 0) {
    body.appendChild(
      emptyState(
        state.matches.length === 0
          ? "No hardcoded values that match an indexed token in this file."
          : "No matches for the current search and filters.",
      ),
    );
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "hits";
  for (const m of filtered) ul.appendChild(buildRow(m));
  body.appendChild(ul);

  syncSelectAllCheckbox();
}

function currentlyVisible(): readonly WireHardcodedMatch[] {
  const all = state.matches ?? [];
  const terms = state.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return all.filter((m) => {
    if (state.kinds.size > 0 && !state.kinds.has(m.kind)) return false;
    if (terms.length === 0) return true;
    // Search across literal AND every candidate name — users want
    // "border" to find a hit whose suggested replacement contains
    // "border" just as much as one whose literal contains it.
    const hay = (
      m.literal +
      " " +
      m.candidates.map((c) => c.name).join(" ")
    ).toLowerCase();
    for (const t of terms) if (!hay.includes(t)) return false;
    return true;
  });
}

// ─── Row ────────────────────────────────────────────────────────────────

function rowKey(m: WireHardcodedMatch): string {
  return `${m.relPath}@${m.replaceStart}`;
}

function buildRow(m: WireHardcodedMatch): HTMLElement {
  const li = document.createElement("li");
  li.className = "hit";
  const key = rowKey(m);
  if (selected.has(key)) li.classList.add("hit--selected");

  const cursor = candidateCursors.get(key) ?? 0;
  const candidate = m.candidates[cursor] ?? m.candidates[0];

  // ─── Select checkbox ────────────────────────────────────────────
  const selectWrap = document.createElement("label");
  selectWrap.className = "hit__select";
  selectWrap.title = "Include in bulk apply";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selected.has(key);
  checkbox.addEventListener("click", (ev) => ev.stopPropagation());
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(key);
    else selected.delete(key);
    li.classList.toggle("hit--selected", checkbox.checked);
    renderBulkBar();
    syncSelectAllCheckbox();
  });
  selectWrap.appendChild(checkbox);

  // ─── Left: literal + swatch ─────────────────────────────────────
  const literalCell = document.createElement("span");
  literalCell.className = "hit__literal-cell";
  literalCell.appendChild(swatch(m.hex, m.kind));
  const literalText = document.createElement("span");
  literalText.className = "hit__literal";
  literalText.textContent = m.literal;
  literalCell.appendChild(literalText);

  // ─── Arrow ──────────────────────────────────────────────────────
  const arrow = document.createElement("span");
  arrow.className = "hit__arrow";
  arrow.textContent = "→";

  // ─── Right: candidate name + swatch ─────────────────────────────
  const targetCell = document.createElement("span");
  targetCell.className = "hit__target-cell";
  targetCell.appendChild(swatch(candidate.hex, m.kind));
  const targetName = document.createElement("span");
  targetName.className = "hit__target";
  targetName.textContent = candidate.name;
  targetCell.appendChild(targetName);
  if (m.candidates.length > 1) {
    const counter = document.createElement("span");
    counter.className = "hit__counter";
    counter.textContent = `${cursor + 1}/${m.candidates.length}`;
    targetCell.appendChild(counter);
  }

  // ─── Line number ────────────────────────────────────────────────
  const lineNo = document.createElement("span");
  lineNo.className = "hit__line";
  lineNo.textContent = `:${m.line + 1}`;

  // ─── Action buttons ─────────────────────────────────────────────
  const actions = document.createElement("span");
  actions.className = "hit__actions";

  if (m.candidates.length > 1) {
    // Wrap the chevron in a positioning context so the dropdown can
    // anchor to it. The dropdown shows every candidate; picking one
    // sets it as the active cursor for this row (the apply button on
    // the right then commits it). Mirrors the IntelliJ "pick from
    // suggestions" UX — much easier than tab-cycling when there are
    // 4+ candidates.
    const wrap = document.createElement("span");
    wrap.className = "hit__cycle-wrap";
    const dropdownBtn = textIconButton("▾", "Show all candidates", () => {
      toggleCandidateDropdown(wrap, m, key, () => {
        // Re-render after a candidate is picked so the target column,
        // counter and apply-button tooltip reflect the new cursor.
        li.replaceWith(buildRow(m));
      });
    });
    dropdownBtn.classList.add("hit__btn--cycle");
    wrap.appendChild(dropdownBtn);
    actions.appendChild(wrap);
  }

  actions.appendChild(
    textIconButton("⌖", "Jump to source line", () =>
      vscode.postMessage({
        type: "reveal",
        relPath: m.relPath,
        line: m.line,
      }),
    ),
  );

  const applyBtn = svgIconButton(
    SWAP_ICON,
    `Replace with ${candidate.replacement}`,
    () =>
      vscode.postMessage({
        type: "apply",
        relPath: m.relPath,
        replaceStart: m.replaceStart,
        replaceEndExclusive: m.replaceEndExclusive,
        replacement: candidate.replacement,
      }),
  );
  applyBtn.classList.add("hit__btn--primary");
  actions.appendChild(applyBtn);

  li.append(selectWrap, literalCell, arrow, targetCell, lineNo, actions);
  return li;
}

// ─── Candidate dropdown ─────────────────────────────────────────────────

/**
 * Closes whatever candidate dropdown is currently open. Tracked at
 * module scope so opening a new one (or any outside click) collapses
 * the previous one without leaking floating menus.
 */
let openDropdownCleanup: (() => void) | null = null;

function closeOpenDropdown(): void {
  if (openDropdownCleanup) {
    openDropdownCleanup();
    openDropdownCleanup = null;
  }
}

function toggleCandidateDropdown(
  anchor: HTMLElement,
  m: WireHardcodedMatch,
  key: string,
  onPick: () => void,
): void {
  // Re-clicking the same anchor with the dropdown already open is a
  // close intent — toggle behaviour mirrors VS Code's own dropdowns.
  const existing = anchor.querySelector(".candidate-dropdown");
  if (existing) {
    closeOpenDropdown();
    return;
  }
  closeOpenDropdown(); //                                close any other one open elsewhere

  const dropdown = document.createElement("div");
  dropdown.className = "candidate-dropdown";
  dropdown.setAttribute("role", "listbox");

  const activeCursor = candidateCursors.get(key) ?? 0;
  for (let i = 0; i < m.candidates.length; i++) {
    const c = m.candidates[i];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "candidate-dropdown__item";
    item.setAttribute("role", "option");
    if (i === activeCursor) item.classList.add("candidate-dropdown__item--active");

    const check = document.createElement("span");
    check.className = "candidate-dropdown__check";
    check.textContent = i === activeCursor ? "✓" : "";
    item.appendChild(check);

    item.appendChild(swatch(c.hex, m.kind));

    const name = document.createElement("span");
    name.className = "candidate-dropdown__name";
    name.textContent = c.name;
    item.appendChild(name);

    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      candidateCursors.set(key, i);
      closeOpenDropdown();
      onPick();
    });
    dropdown.appendChild(item);
  }

  anchor.appendChild(dropdown);

  // Outside-click + Escape closers. Captured at the document level so a
  // click on any other row collapses this dropdown — same UX as the
  // filter panel above.
  const outside = (ev: MouseEvent) => {
    if (anchor.contains(ev.target as Node)) return;
    closeOpenDropdown();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closeOpenDropdown();
  };
  // Defer registration so the click that opened the dropdown doesn't
  // immediately get caught by the outside-click handler.
  setTimeout(() => document.addEventListener("click", outside), 0);
  document.addEventListener("keydown", onKey);

  openDropdownCleanup = () => {
    dropdown.remove();
    document.removeEventListener("click", outside);
    document.removeEventListener("keydown", onKey);
  };
}

// ─── Bulk bar ────────────────────────────────────────────────────────────

function renderBulkBar(): void {
  const bar = document.getElementById("hardcoded-bulk-bar") as HTMLElement;
  const count = document.getElementById("hardcoded-bulk-count")!;
  // The bar only counts CURRENTLY VISIBLE selections — a row that's
  // checked but filtered out can't be applied because the user can't
  // see what they're confirming. Hiding it from the count avoids the
  // "Apply 12 selected" → applies 2 surprise.
  const visibleKeys = new Set(currentlyVisible().map(rowKey));
  let n = 0;
  for (const k of selected) if (visibleKeys.has(k)) n++;
  if (n === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  count.textContent = `${n} selected`;
}

function renderSelectAllVisibility(): void {
  const wrap = document.getElementById("hardcoded-select-all-wrap") as HTMLElement;
  // Hide the select-all checkbox when there's nothing to select — it
  // would be a dead control on the inactive / empty states.
  const hasAnyVisible = currentlyVisible().length > 0;
  wrap.hidden = !hasAnyVisible;
  if (hasAnyVisible) syncSelectAllCheckbox();
}

function syncSelectAllCheckbox(): void {
  const checkbox = document.getElementById("hardcoded-select-all") as HTMLInputElement;
  const visible = currentlyVisible();
  if (visible.length === 0) {
    checkbox.checked = false;
    checkbox.indeterminate = false;
    return;
  }
  let n = 0;
  for (const m of visible) if (selected.has(rowKey(m))) n++;
  checkbox.checked = n === visible.length;
  checkbox.indeterminate = n > 0 && n < visible.length;
}

// ─── Small element builders ─────────────────────────────────────────────

function swatch(hex: string | null, kind: Kind): HTMLElement {
  const el = document.createElement("span");
  el.className = "swatch";
  if (hex) {
    el.classList.add("swatch--color");
    el.style.backgroundColor = hex;
  } else {
    el.classList.add("swatch--glyph");
    el.textContent = KIND_GLYPH[kind];
  }
  return el;
}

const KIND_GLYPH: Record<Kind, string> = {
  COLOR: "●",
  LENGTH: "↔",
  DURATION: "⏱",
};

// Swap glyph drawn as inline SVG so it scales with the button and
// stays crisp on retina — Unicode ⇄ rendered with ~50% glyph weight
// on most fonts, which made the apply button feel anaemic.
const SWAP_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M2 5h9.5L9 2.5l.7-.7L13.4 5.5 9.7 9.2 9 8.5 11.5 6H2V5zm12 6H4.5L7 13.5l-.7.7L2.6 10.5 6.3 6.8 7 7.5 4.5 10H14v1z"/>' +
  "</svg>";

function textIconButton(
  glyph: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hit__btn";
  btn.title = title;
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

function svgIconButton(
  svg: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hit__btn";
  btn.title = title;
  btn.innerHTML = svg;
  btn.addEventListener("click", onClick);
  return btn;
}

function emptyState(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hardcoded-empty";
  p.textContent = text;
  return p;
}

function prettyKind(k: Kind): string {
  return k[0] + k.substring(1).toLowerCase();
}
