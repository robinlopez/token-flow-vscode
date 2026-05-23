// Settings webview client. Renders a master-detail editor over the
// `WireScope[]` snapshot it receives from the host:
//
//   • Left column   — scope list (master). Click selects, "+" appends.
//   • Right column  — detail view: name field, root-path picker, and
//                     three path lists (sources / whitelist / excludes)
//                     with per-row remove + per-list "Add…" buttons.
//
// All state lives on the host. The client mirrors the latest snapshot
// in `state` and re-renders on every `config` message. User actions
// flow back through `postMessage`; the host writes to workspace
// settings and re-broadcasts, closing the loop.

import type {
  ScopePathField,
  SettingsClientMessage,
  SettingsHostMessage,
  WirePreferences,
  WireScope,
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(msg: SettingsClientMessage): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
};

const vscode = acquireVsCodeApi();

interface State {
  scopes: readonly WireScope[];
  preferences: WirePreferences | null;
  workspaceName: string | null;
  noWorkspace: boolean;
  /** Index of the currently-selected scope (sticky across re-renders). */
  selected: number;
  /** True between user edits to a text field and the next config message. */
  pendingFieldUpdates: Map<string, string>;
}

const state: State = {
  scopes: [],
  preferences: null,
  workspaceName: null,
  noWorkspace: false,
  selected: 0,
  pendingFieldUpdates: new Map(),
};

window.addEventListener(
  "message",
  (event: MessageEvent<SettingsHostMessage>) => {
    if (event.data.type === "config") {
      state.scopes = event.data.scopes;
      state.preferences = event.data.preferences;
      state.workspaceName = event.data.workspaceName;
      state.noWorkspace = event.data.noWorkspace;
      // Clamp selection — list might have shrunk between snapshots.
      if (state.selected >= state.scopes.length) {
        state.selected = Math.max(0, state.scopes.length - 1);
      }
      state.pendingFieldUpdates.clear();
      render();
    }
  },
);

document.addEventListener("DOMContentLoaded", () => {
  vscode.postMessage({ type: "ready" });
});

// ─── Render ─────────────────────────────────────────────────────────────

function render(): void {
  const root = document.getElementById("settings-root")!;
  root.innerHTML = "";

  if (state.noWorkspace) {
    root.appendChild(
      banner(
        "Open a workspace folder to configure Token Flow scopes — settings are saved per project.",
      ),
    );
    return;
  }

  root.appendChild(buildHeader());

  // Preferences section sits above Scopes — it's a flat, fast-to-scan
  // form (no master-detail), so showing it first matches the user's
  // mental "general first, then per-project lists" flow.
  if (state.preferences) {
    root.appendChild(buildPreferencesSection(state.preferences));
  }

  root.appendChild(buildScopesSectionHeader());
  if (state.scopes.length === 0) {
    root.appendChild(buildEmptyState());
    return;
  }
  root.appendChild(buildMasterDetail());
}

function buildScopesSectionHeader(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "section-header";
  const h2 = document.createElement("h2");
  h2.className = "section-header__title";
  h2.textContent = "Scopes";
  const hint = document.createElement("p");
  hint.className = "section-header__hint";
  hint.textContent =
    "Group source-of-truth files per app/area. The active editor's path selects which scopes apply.";
  wrap.append(h2, hint);
  return wrap;
}

// ─── Preferences section ────────────────────────────────────────────────

function buildPreferencesSection(prefs: WirePreferences): HTMLElement {
  const section = document.createElement("section");
  section.className = "preferences";

  const h2 = document.createElement("h2");
  h2.className = "section-header__title";
  h2.textContent = "Preferences";
  section.appendChild(h2);

  const hint = document.createElement("p");
  hint.className = "section-header__hint";
  hint.textContent =
    "General Token Flow behaviour. Saved per project (workspace settings).";
  section.appendChild(hint);

  // Picker style — segmented radio. We model it as two visually
  // identical option cards so the trade-off (native popup vs. side
  // panel) is readable at a glance, not buried in radio labels.
  section.appendChild(
    buildSegmentedField({
      label: "Alt+T picker style",
      hint: "How the Show Token Alternatives popup is rendered.",
      value: prefs.pickerStyle,
      options: [
        {
          value: "webviewBeside",
          title: "Side panel",
          description:
            "Custom webview opened in a split column next to the editor. Richer visuals (large swatches, real group dividers); auto-closes on blur.",
        },
        {
          value: "completion",
          title: "Native popup",
          description:
            "IntelliSense suggest widget floating under the caret. Closest to the IntelliJ feel; color swatches via the built-in Color kind.",
        },
      ],
      onChange: (v) =>
        vscode.postMessage({
          type: "updatePreference",
          key: "pickerStyle",
          value: v,
        }),
    }),
  );

  // Hover toggle — small inline switch, same store as the picker
  // style so users find both prefs in one place.
  section.appendChild(
    buildToggleField({
      label: "Hover tooltips",
      hint: "Show resolved value and per-mode variants when hovering a token reference.",
      checked: prefs.hoverEnabled,
      onChange: (v) =>
        vscode.postMessage({
          type: "updatePreference",
          key: "hoverEnabled",
          value: v,
        }),
    }),
  );

  // Keybindings — redirect to VS Code's native editor instead of
  // mirroring it. We list the defaults inline so the user knows what
  // to look for, then offer the button. Single source of truth lives
  // in `package.json#contributes.keybindings`; if you change it
  // there, update this list too.
  section.appendChild(buildKeybindingsField());

  return section;
}

function buildKeybindingsField(): HTMLElement {
  const row = document.createElement("div");
  row.className = "pref-row";

  const labelEl = document.createElement("div");
  labelEl.className = "pref-row__label";
  labelEl.textContent = "Keyboard shortcuts";
  row.appendChild(labelEl);

  const hint = document.createElement("p");
  hint.className = "pref-row__hint";
  hint.textContent =
    "Customize Token Flow shortcuts in VS Code's Keyboard Shortcuts editor. Defaults stay intact unless you override them there.";
  row.appendChild(hint);

  const list = document.createElement("ul");
  list.className = "pref-keybindings";
  // Keep this list short and accurate — only commands that actually
  // ship a default binding. Others are accessible via the command
  // palette and the user can bind them from the same UI.
  const bindings: readonly { combo: string; label: string }[] = [
    { combo: "Alt+T", label: "Show Token Alternatives" },
  ];
  for (const b of bindings) {
    const li = document.createElement("li");
    const kbd = document.createElement("kbd");
    kbd.className = "pref-kbd";
    kbd.textContent = b.combo;
    const text = document.createElement("span");
    text.textContent = b.label;
    li.append(kbd, text);
    list.appendChild(li);
  }
  row.appendChild(list);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--secondary";
  btn.textContent = "Manage keyboard shortcuts…";
  btn.addEventListener("click", () =>
    vscode.postMessage({ type: "openKeybindings" }),
  );
  row.appendChild(btn);

  return row;
}

interface SegmentedOption {
  readonly value: string;
  readonly title: string;
  readonly description: string;
}

interface SegmentedFieldOpts {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly options: readonly SegmentedOption[];
  readonly onChange: (value: string) => void;
}

function buildSegmentedField(opts: SegmentedFieldOpts): HTMLElement {
  const row = document.createElement("div");
  row.className = "pref-row";

  const labelEl = document.createElement("div");
  labelEl.className = "pref-row__label";
  labelEl.textContent = opts.label;
  row.appendChild(labelEl);

  const hint = document.createElement("p");
  hint.className = "pref-row__hint";
  hint.textContent = opts.hint;
  row.appendChild(hint);

  const grid = document.createElement("div");
  grid.className = "pref-segmented";
  for (const opt of opts.options) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pref-segmented__card";
    if (opt.value === opts.value) {
      card.classList.add("pref-segmented__card--active");
    }
    card.addEventListener("click", () => {
      if (opt.value === opts.value) return;
      opts.onChange(opt.value);
    });
    const t = document.createElement("span");
    t.className = "pref-segmented__title";
    t.textContent = opt.title;
    const d = document.createElement("span");
    d.className = "pref-segmented__desc";
    d.textContent = opt.description;
    card.append(t, d);
    grid.appendChild(card);
  }
  row.appendChild(grid);
  return row;
}

interface ToggleFieldOpts {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}

function buildToggleField(opts: ToggleFieldOpts): HTMLElement {
  const row = document.createElement("div");
  row.className = "pref-row";

  const top = document.createElement("div");
  top.className = "pref-row__toggle-top";

  const labelEl = document.createElement("div");
  labelEl.className = "pref-row__label";
  labelEl.textContent = opts.label;
  top.appendChild(labelEl);

  // Native checkbox styled as a pill switch — keyboard accessible by
  // default and survives high-contrast theme without per-theme CSS.
  const wrap = document.createElement("label");
  wrap.className = "pref-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = opts.checked;
  input.addEventListener("change", () => opts.onChange(input.checked));
  const thumb = document.createElement("span");
  thumb.className = "pref-toggle__thumb";
  wrap.append(input, thumb);
  top.appendChild(wrap);

  row.appendChild(top);

  const hint = document.createElement("p");
  hint.className = "pref-row__hint";
  hint.textContent = opts.hint;
  row.appendChild(hint);

  return row;
}

function buildHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "settings-header__titleblock";
  const title = document.createElement("h1");
  title.className = "settings-header__title";
  title.textContent = "Token Flow — Settings";
  titleBlock.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "settings-header__subtitle";
  sub.textContent = state.workspaceName
    ? `Saved per project — workspace: ${state.workspaceName}`
    : "Saved per project (workspace settings).";
  titleBlock.appendChild(sub);

  header.appendChild(titleBlock);

  // Import/Export actions — same role as the IntelliJ TokenSelector
  // Configurable's "Import…" / "Export…" hyperlinks. We expose them
  // as buttons here because the settings panel already uses native
  // buttons elsewhere and a button row is more discoverable than
  // hyperlinks on a wide webview.
  const actions = document.createElement("div");
  actions.className = "settings-header__actions";

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "ghost-btn";
  importBtn.textContent = "Import…";
  importBtn.title =
    "Replace or merge the current scopes from a previously-exported JSON file.";
  importBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "importScopes" }),
  );

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "ghost-btn";
  exportBtn.textContent = "Export…";
  exportBtn.title =
    "Save the current scope configuration to a JSON file you can commit or share.";
  exportBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "exportScopes" }),
  );
  // Disable export when nothing's there — same UX as the IntelliJ side.
  if (state.scopes.length === 0) {
    exportBtn.disabled = true;
    exportBtn.title = "Add a scope before exporting.";
  }

  actions.append(importBtn, exportBtn);
  header.appendChild(actions);

  return header;
}

function buildEmptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-empty-card";

  const title = document.createElement("h2");
  title.textContent = "No scopes yet";

  const body = document.createElement("p");
  body.textContent =
    "Scopes group source-of-truth files by app/area. Create one to start indexing tokens.";

  const cta = primaryButton("+  Create your first scope", () =>
    vscode.postMessage({ type: "addScope" }),
  );
  wrap.append(title, body, cta);
  return wrap;
}

function buildMasterDetail(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-master-detail";
  wrap.append(buildMaster(), buildDetail());
  return wrap;
}

// ─── Master (scope list) ────────────────────────────────────────────────

function buildMaster(): HTMLElement {
  const aside = document.createElement("aside");
  aside.className = "scope-list";

  const list = document.createElement("ul");
  for (let i = 0; i < state.scopes.length; i++) {
    list.appendChild(buildMasterRow(state.scopes[i], i));
  }
  aside.appendChild(list);

  const addBtn = secondaryButton("+  Add scope", () =>
    vscode.postMessage({ type: "addScope" }),
  );
  addBtn.classList.add("scope-list__add");
  aside.appendChild(addBtn);
  return aside;
}

function buildMasterRow(scope: WireScope, index: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "scope-list__row";
  if (index === state.selected) li.classList.add("scope-list__row--selected");
  li.tabIndex = 0;
  li.addEventListener("click", () => {
    state.selected = index;
    render();
  });
  li.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      state.selected = index;
      render();
    }
  });

  const name = document.createElement("span");
  name.className = "scope-list__name";
  name.textContent = scope.name || "(unnamed)";

  const meta = document.createElement("span");
  meta.className = "scope-list__meta";
  meta.textContent = scope.rootPath
    ? scope.rootPath
    : "common (always active)";

  const remove = iconButton("✕", "Remove scope", (ev) => {
    ev.stopPropagation();
    vscode.postMessage({ type: "removeScope", index });
  });
  remove.classList.add("scope-list__remove");

  li.append(name, meta, remove);
  return li;
}

// ─── Detail (selected scope editor) ─────────────────────────────────────

function buildDetail(): HTMLElement {
  const section = document.createElement("section");
  section.className = "scope-detail";

  const scope = state.scopes[state.selected];
  if (!scope) {
    section.appendChild(
      banner("Select a scope on the left, or add a new one."),
    );
    return section;
  }

  section.append(
    buildBasicsForm(scope, state.selected),
    buildPathSection(
      scope,
      state.selected,
      "sourcePaths",
      "Sources",
      "Files and folders containing the tokens (Source of Truth).",
    ),
    buildPathSection(
      scope,
      state.selected,
      "whitelistPaths",
      "Whitelist",
      "Files whose variables are external/known — won't be flagged as broken refs.",
    ),
    buildPathSection(
      scope,
      state.selected,
      "excludedPaths",
      "Excludes",
      "Folders/files inside the root to skip during analysis (e.g. unrelated sub-modules).",
    ),
  );
  return section;
}

function buildBasicsForm(scope: WireScope, index: number): HTMLElement {
  const form = document.createElement("div");
  form.className = "scope-form";

  // Name —————————————————————————————————————————————————————————————
  form.appendChild(buildTextField({
    id: `scope-name-${index}`,
    label: "Name",
    value: scope.name,
    placeholder: "e.g. mobile, desktop, common",
    onChange: (v) =>
      vscode.postMessage({
        type: "updateScopeField",
        index,
        field: "name",
        value: v,
      }),
  }));

  // Root path —————————————————————————————————————————————————————————
  const rootRow = document.createElement("div");
  rootRow.className = "scope-form__row";

  const labelEl = document.createElement("label");
  labelEl.className = "scope-form__label";
  labelEl.textContent = "Root path";
  labelEl.htmlFor = `scope-root-${index}`;
  rootRow.appendChild(labelEl);

  const inputWrap = document.createElement("div");
  inputWrap.className = "scope-form__input-wrap";

  const input = document.createElement("input");
  input.id = `scope-root-${index}`;
  input.type = "text";
  input.className = "scope-form__input";
  input.value = scope.rootPath;
  input.placeholder = "Empty = common (always active)";
  input.addEventListener("change", () =>
    vscode.postMessage({
      type: "updateScopeField",
      index,
      field: "rootPath",
      value: input.value,
    }),
  );
  inputWrap.appendChild(input);

  const browseBtn = secondaryButton("Browse…", () =>
    vscode.postMessage({ type: "pickRootPath", index }),
  );
  inputWrap.appendChild(browseBtn);
  rootRow.appendChild(inputWrap);

  const hint = document.createElement("p");
  hint.className = "scope-form__hint";
  hint.textContent =
    "When the active file is inside this folder, the scope's tokens become available. Leave empty for a common scope that's always active.";
  rootRow.appendChild(hint);

  form.appendChild(rootRow);
  return form;
}

// ─── Path lists ─────────────────────────────────────────────────────────

function buildPathSection(
  scope: WireScope,
  index: number,
  field: ScopePathField,
  title: string,
  hint: string,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "path-section";

  const header = document.createElement("header");
  header.className = "path-section__header";

  const titleEl = document.createElement("h3");
  titleEl.className = "path-section__title";
  titleEl.textContent = title;
  const count = document.createElement("span");
  count.className = "path-section__count";
  count.textContent = String(scope[field].length);
  header.append(titleEl, count);

  const hintEl = document.createElement("p");
  hintEl.className = "path-section__hint";
  hintEl.textContent = hint;

  section.append(header, hintEl);

  const list = document.createElement("ul");
  list.className = "path-list";
  const paths = scope[field];
  if (paths.length === 0) {
    const empty = document.createElement("li");
    empty.className = "path-list__empty";
    empty.textContent = "(none)";
    list.appendChild(empty);
  } else {
    for (let i = 0; i < paths.length; i++) {
      list.appendChild(buildPathRow(paths[i], index, field, i));
    }
  }
  section.appendChild(list);

  const add = secondaryButton("+  Add files / folders…", () =>
    vscode.postMessage({ type: "addPath", index, field }),
  );
  add.classList.add("path-section__add");
  section.appendChild(add);

  return section;
}

function buildPathRow(
  path: string,
  scopeIndex: number,
  field: ScopePathField,
  pathIndex: number,
): HTMLElement {
  const li = document.createElement("li");
  li.className = "path-row";

  const pathText = document.createElement("span");
  pathText.className = "path-row__text";
  pathText.textContent = path;
  pathText.title = path; //                                       tooltip for truncated rows
  li.appendChild(pathText);

  const remove = iconButton("✕", "Remove this path", () =>
    vscode.postMessage({
      type: "removePath",
      index: scopeIndex,
      field,
      pathIndex,
    }),
  );
  li.appendChild(remove);
  return li;
}

// ─── Small element builders ─────────────────────────────────────────────

interface TextFieldOpts {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function buildTextField(opts: TextFieldOpts): HTMLElement {
  const row = document.createElement("div");
  row.className = "scope-form__row";

  const labelEl = document.createElement("label");
  labelEl.className = "scope-form__label";
  labelEl.textContent = opts.label;
  labelEl.htmlFor = opts.id;
  row.appendChild(labelEl);

  const input = document.createElement("input");
  input.id = opts.id;
  input.type = "text";
  input.className = "scope-form__input";
  input.value = opts.value;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  // Use `change` (commit on blur / Enter) instead of `input` so we
  // don't issue a settings.update on every keystroke — settings writes
  // are async and would race a fast typist.
  input.addEventListener("change", () => opts.onChange(input.value));
  row.appendChild(input);

  return row;
}

function primaryButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--primary";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function secondaryButton(
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--secondary";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function iconButton(
  glyph: string,
  title: string,
  onClick: (ev: MouseEvent) => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--icon";
  btn.title = title;
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

function banner(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "settings-empty";
  p.textContent = text;
  return p;
}
