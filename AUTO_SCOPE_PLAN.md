# Plan d'implémentation — Auto-Scope Detect

> Cible : **Gemini Pro**. Plan exhaustif et auto-suffisant. Le lecteur ne connaît pas la
> conversation préalable — chaque section indique le **quoi**, le **où** (fichier:ligne)
> et le **comment**.

---

## 1. Décision produit : stratégie de détection (à arbitrer avant codage)

L'utilisateur propose de se baser sur `package.json` pour identifier les "dossiers root"
(racines applicatives = futurs `rootPath` des scopes). **Analyse de pertinence :**

| Approche | Pertinence | Risques |
|---|---|---|
| **A. `package.json` (proposition initiale)** | ✅ Très fiable en monorepo (Nx, Turborepo, Lerna, pnpm workspaces) — un `package.json` ≠ root = une appli/lib. | ❌ Faux positifs sur les `package.json` outils (`tools/`, `scripts/`). ❌ Inutile en projet mono-package (un seul `package.json` racine → un seul scope, peu intéressant). |
| **B. Heuristique combinée (recommandée)** | ✅ Robuste sur tous types de projets. | Plus de code, mais détection bien meilleure. |

### Recommandation : approche **B = heuristique combinée**

1. **Lecture du `package.json` racine** : si présence de `workspaces` (npm/yarn/pnpm) ou
   `nx.json` / `pnpm-workspace.yaml` / `lerna.json` → résoudre les globs et chaque dossier
   contenant un `package.json` devient un candidat **scope spécifique**.
2. **Sinon** : un projet mono-package → un seul scope `common` (rootPath vide).
3. **Toujours** : ajouter un scope `common` pour les tokens partagés (ex. `packages/design-tokens`,
   `libs/styles`, `src/styles`) si détecté heuristiquement (cf. §3).

### Implémentation (côté host)

Créer **`src/settings/autoScopeDetector.ts`** :

```ts
import * as vscode from "vscode";

export interface DetectedScope {
  readonly name: string;        // déduit du dossier ou du package.json#name (sans @scope/)
  readonly rootPath: string;    // workspace-relative, "" pour common
  readonly sourcePaths: string[];
  readonly whitelistPaths: string[];
  readonly excludedPaths: string[];
}

export async function detectScopes(
  workspaceRoot: vscode.Uri,
): Promise<DetectedScope[]> {
  const roots = await detectMonorepoRoots(workspaceRoot); // [] si mono-package
  const excluded = DEFAULT_EXCLUDES;                       // §4
  if (roots.length === 0) {
    const sources = await detectSourceFiles(workspaceRoot, workspaceRoot, excluded);
    return [{
      name: "common",
      rootPath: "",
      sourcePaths: sources,
      whitelistPaths: [],
      excludedPaths: excluded,
    }];
  }
  const out: DetectedScope[] = [];
  for (const root of roots) {
    const sources = await detectSourceFiles(workspaceRoot, root.uri, excluded);
    if (sources.length === 0) continue;  // pas de tokens → on n'invente pas un scope
    out.push({
      name: root.name,
      rootPath: vscode.workspace.asRelativePath(root.uri, false),
      sourcePaths: sources,
      whitelistPaths: [],
      excludedPaths: excluded,
    });
  }
  return out;
}
```

---

## 2. Détection des racines (monorepo) — `detectMonorepoRoots`

**Algorithme :**

1. Lire `<workspaceRoot>/package.json`.
2. Si `workspaces` (tableau ou `{ packages: [...] }`) → résoudre chaque glob via
   `vscode.workspace.findFiles("<glob>/package.json", "**/node_modules/**")`.
3. Sinon, vérifier `pnpm-workspace.yaml` (parser le YAML — ou regex `packages:\s*\n((?:\s*-.*\n?)+)`),
   `nx.json` (toujours présent → lire `apps/` + `libs/` du workspace), `lerna.json#packages`.
4. Fallback : si aucun de ces fichiers, scan `**/package.json` avec exclusion node_modules/dist
   → **dédupliquer** : ne garder un dossier que s'il contient des fichiers `.ts/.tsx/.scss/.css`.
5. **Nommage** : `package.json#name` privé du `@scope/` (ex. `@acme/mobile` → `mobile`),
   sinon basename du dossier.

> Garde-fou : limiter à 50 racines maximum. Au-delà, log + abandon (`workspace trop grand,
> configurez les scopes manuellement`).

---

## 3. Détection des sources tokens — `detectSourceFiles`

**Critère** : un fichier est considéré "source de tokens" s'il contient **exclusivement**
(ou très majoritairement) des déclarations de tokens.

### Pour `.css` / `.scss` / `.sass` / `.less`

Un fichier qualifie si :
- ≥ 80 % des lignes non-vides / non-commentées sont des déclarations matchées par
  `CSS_VAR_REGEX` ou `SCSS_VAR_REGEX` (cf. `src/scanner/regexes.ts:7-12`),
- **ET** il ne contient **aucun** sélecteur CSS classique (`.foo {`, `#bar {`, `&:hover`, `@media`),
- **ET** taille raisonnable (≥ 5 déclarations — évite les fichiers d'1 variable parasites).

Implémentation : réutiliser les regex existantes pour la cohérence.

```ts
function isStyleTokenFile(text: string, ext: string): boolean {
  const codeLines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim())
    .filter(l => l.length > 0 && !l.startsWith("/*") && !l.startsWith("*"));
  if (codeLines.length < 5) return false;
  if (/^[.#&@:\[].*\{/m.test(codeLines.join("\n"))) return false;  // sélecteurs interdits
  const declCount = (text.match(/(^|\s)(--[\w-]+|\$[\w-]+)\s*:/g) ?? []).length;
  return declCount / codeLines.length >= 0.8;
}
```

### Pour `.ts` / `.js` / `.tsx` / `.jsx`

Un fichier qualifie si :
- Il **exporte uniquement** des objets/constantes de valeurs primitives (strings, numbers),
  pas de fonctions / JSX / hooks / imports React,
- Les noms d'exports matchent un vocabulaire token (regex sur les clés du contenu : on cherche
  ≥ 60 % de clés appartenant à `{color, primary, secondary, surface, bg, fg, text, border,
  spacing, space, size, radius, font, weight, line, shadow, opacity, duration, ease, breakpoint, z}`),
- Pas d'import React, pas de `from "react"`, pas de balises JSX (`/<[A-Z][A-Za-z0-9]*/`).

```ts
function isJsTokenFile(text: string): boolean {
  if (/from\s+["']react/.test(text)) return false;
  if (/<[A-Z][A-Za-z]*[\s/>]/.test(text)) return false;       // JSX
  if (/\bfunction\b|=>\s*\{|\bclass\s+\w/.test(text)) return false; // fonctions
  const keys = [...text.matchAll(/^\s*["']?([a-zA-Z][\w-]*)["']?\s*:/gm)].map(m => m[1]);
  if (keys.length < 5) return false;
  const tokenVocab = /^(color|colors|primary|secondary|surface|bg|background|fg|foreground|text|border|spacing|space|size|sizes|radius|radii|font|fonts|weight|line|lineHeight|shadow|shadows|opacity|duration|durations|ease|easing|breakpoint|breakpoints|z|zIndex|gap|inset|gray|grey|red|blue|green|yellow|orange|purple|pink|black|white|neutral|brand|accent|info|success|warning|danger|error)/i;
  const hits = keys.filter(k => tokenVocab.test(k)).length;
  return hits / keys.length >= 0.6;
}
```

### Stratégie de scan

`vscode.workspace.findFiles` avec :
- Includes : `{**/*.css,**/*.scss,**/*.sass,**/*.less,**/*tokens*.{ts,js},**/*theme*.{ts,js},**/*palette*.{ts,js},**/*variables*.{ts,js},**/*design-tokens*/**/*.{ts,js}}`
- Excludes : `{**/node_modules/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**}`
- Plafond : 500 fichiers analysés max (log warning au-delà).

Pour chaque fichier matchant : `await vscode.workspace.fs.readFile`, appliquer la fonction `isStyleTokenFile` ou `isJsTokenFile`, retourner les chemins **workspace-relatifs** ; si plusieurs fichiers du même dossier qualifient, **collapser au dossier parent** (ex. `src/styles/tokens/colors.scss` + `src/styles/tokens/spacing.scss` → `src/styles/tokens`).

---

## 4. Excludes par défaut — `DEFAULT_EXCLUDES`

```ts
export const DEFAULT_EXCLUDES: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".storybook-static",
  "storybook-static",
  ".vscode",
  ".idea",
  ".git",
  "tmp",
  "temp",
];
```

Filtrer ceux qui **existent réellement** dans le workspace via `vscode.workspace.fs.stat` —
ne pas polluer la config avec des dossiers absents.

---

## 5. Protocole de message (webview ↔ host)

### Modifier `src/webview/shared/protocol.ts`

Ajouter à `SettingsClientMessage` :

```ts
| { type: "autoDetectScopes" }
```

Ajouter à `SettingsHostMessage` (union, plus juste un type literal — refacto nécessaire si encore literal) :

```ts
| { type: "autoDetectResult"; detected: number; merged: number; skipped: number }
| { type: "autoDetectFailed"; reason: string }
```

> ⚠️ Actuellement `SettingsHostMessage` est un **type unique** (`{ type: "config"; … }`).
> Le transformer en union discriminée. Ajuster `settingsWebviewPanel.ts:476` (méthode `send`)
> et l'handler `window.addEventListener` dans `src/webview/settings/main.ts:50-66` (gérer
> les nouveaux types via `switch (event.data.type)`).

---

## 6. Host : intégration dans `settingsWebviewPanel.ts`

### 6.1 Nouveau handler

Dans `handleClientMessage` (`src/views/settingsWebviewPanel.ts:120`) ajouter le case :

```ts
case "autoDetectScopes":
  await this.runAutoDetect();
  return;
```

### 6.2 Méthode `runAutoDetect`

```ts
private async runAutoDetect(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) {
    this.send({ type: "autoDetectFailed", reason: "no-workspace" });
    return;
  }
  // Confirmation modale OBLIGATOIRE avant de muter — l'utilisateur doit
  // savoir que la config sera modifiée et qu'une revue manuelle est requise.
  const confirm = await vscode.window.showWarningMessage(
    "Auto-detect will scan your workspace for design-token files and " +
    "create/merge scopes accordingly. Review and adjust the result — " +
    "auto-detection is heuristic and may miss edge cases or include noise.",
    { modal: true },
    "Run detection",
  );
  if (confirm !== "Run detection") return;

  const detected = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Token Flow: detecting scopes…" },
    () => detectScopes(ws),
  );

  // Fusion non-destructive : on AJOUTE / MET À JOUR par nom de scope.
  let merged = 0;
  let added = 0;
  await this.mutate((scopes) => {
    for (const d of detected) {
      const existing = scopes.find(s => s.name.toLowerCase() === d.name.toLowerCase());
      if (existing) {
        for (const p of d.sourcePaths)   if (!existing.sourcePaths.includes(p))   existing.sourcePaths.push(p);
        for (const p of d.excludedPaths) if (!existing.excludedPaths.includes(p)) existing.excludedPaths.push(p);
        if (!existing.rootPath && d.rootPath) existing.rootPath = d.rootPath;
        merged++;
      } else {
        scopes.push({
          name: d.name,
          rootPath: d.rootPath,
          sourcePaths: [...d.sourcePaths],
          whitelistPaths: [],
          excludedPaths: [...d.excludedPaths],
          externalPrefixes: [],
        });
        added++;
      }
    }
  });

  this.send({ type: "autoDetectResult", detected: detected.length, merged, skipped: 0 });
  vscode.window.showInformationMessage(
    `Token Flow: detected ${detected.length} scope(s) — ${added} added, ${merged} merged. ` +
    `Please review the result.`,
  );
}
```

---

## 7. UI webview — `src/webview/settings/main.ts`

### 7.1 État vide (`buildEmptyState`, ligne 394)

Remplacer le bloc "+ Create your first scope" par un bloc plus riche :

```ts
function buildEmptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-empty-card";

  const title = document.createElement("h2");
  title.textContent = "No scopes yet";

  const body = document.createElement("p");
  body.textContent =
    "Scopes group source-of-truth files by app/area. Let Token Flow scan your " +
    "workspace automatically, or add a scope manually.";

  const alert = document.createElement("div");
  alert.className = "settings-alert settings-alert--info";
  alert.textContent =
    "⚠ Auto-detection is heuristic: it identifies token files via package.json " +
    "structure and content heuristics. Always review the result — verifying the " +
    "scope definitions yields much better scan quality.";

  const actions = document.createElement("div");
  actions.className = "settings-empty-card__actions";

  const auto = primaryButton("🔍 Auto-scope detect", () =>
    vscode.postMessage({ type: "autoDetectScopes" }),
  );
  const manual = secondaryButton("+ Add scope manually", () =>
    vscode.postMessage({ type: "addScope" }),
  );
  actions.append(auto, manual);

  wrap.append(title, body, alert, actions);
  return wrap;
}
```

### 7.2 État rempli (`buildScopesSectionHeader`, ligne 104)

Ajouter le bouton à droite du titre + sous-titre :

```ts
function buildScopesSectionHeader(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "section-header section-header--with-action";

  const text = document.createElement("div");
  text.className = "section-header__text";
  const h2 = document.createElement("h2");
  h2.className = "section-header__title";
  h2.textContent = "Scopes";
  const hint = document.createElement("p");
  hint.className = "section-header__hint";
  hint.textContent =
    "Group source-of-truth files per app/area. The active editor's path selects which scopes apply.";
  text.append(h2, hint);

  const auto = secondaryButton("🔍 Auto-scope detect", () =>
    vscode.postMessage({ type: "autoDetectScopes" }),
  );
  auto.title =
    "Scan the workspace for token files and merge them into existing scopes. " +
    "Review the result afterwards.";
  auto.classList.add("section-header__action");

  wrap.append(text, auto);
  return wrap;
}
```

### 7.3 Handler retour host

Dans `window.addEventListener` (ligne 50) :

```ts
window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "config": /* existant */ break;
    case "autoDetectResult":
      showToast(`Detected ${msg.detected} scope(s). Please review.`);
      break;
    case "autoDetectFailed":
      showToast(`Auto-detect failed: ${msg.reason}`, "error");
      break;
  }
});
```

(Implémenter un mini `showToast` ou réutiliser un mécanisme existant — un simple
div fixed top-right qui s'auto-efface à 4 s suffit.)

---

## 8. CSS — `src/webview/settings/style.css`

Ajouter :

```css
.settings-alert {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 4px;
  border-left: 3px solid var(--vscode-inputValidation-warningBorder);
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-foreground);
  font-size: 0.9em;
  line-height: 1.4;
}
.settings-alert--info {
  border-left-color: var(--vscode-inputValidation-infoBorder);
  background: var(--vscode-inputValidation-infoBackground);
}
.settings-empty-card__actions {
  display: flex; gap: 8px; margin-top: 12px;
}
.section-header--with-action {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
}
.section-header__action { flex-shrink: 0; align-self: center; }
```

---

## 9. Tests / Vérifications manuelles

1. **Monorepo Nx** : ouvrir un workspace avec `apps/mobile`, `apps/desktop`, `libs/design-tokens`
   → 3 scopes détectés, `design-tokens` reconnu comme commun.
2. **Mono-package** : ouvrir un projet React simple → 1 scope `common` avec
   `src/styles/tokens.scss` détecté.
3. **Fichier non-token** : un `_buttons.scss` (avec sélecteurs) doit être **ignoré**.
4. **Idempotence** : relancer la détection sur une config déjà peuplée → 0 ajouts, N merges.
5. **Workspace sans fichier de tokens** : alerte "no tokens found, add a scope manually".
6. **Confirmation modale** : refuser la modale ne doit muter aucune setting.
7. **Excludes** : vérifier que `node_modules`, `dist` apparaissent dans le panneau Excludes
   après détection — mais uniquement s'ils existent réellement.

---

## 10. Ordre d'implémentation conseillé

1. `src/settings/autoScopeDetector.ts` (logique pure, testable isolément).
2. `src/webview/shared/protocol.ts` (typage du nouveau message + transformation en union).
3. `src/views/settingsWebviewPanel.ts` (handler + `runAutoDetect`).
4. `src/webview/settings/main.ts` (UI empty state + header).
5. `src/webview/settings/style.css` (alerte + layout du header).
6. Tests manuels selon §9.

---

## 11. Points d'attention pour Gemini

- **Ne pas** régresser le comportement actuel : si l'utilisateur a déjà des scopes,
  la détection **AJOUTE/MERGE** mais ne supprime ni ne remplace jamais.
- Le **rootPath** d'un scope déjà nommé n'est mis à jour **que** s'il était vide.
- Toutes les écritures passent par `this.mutate(...)` pour rester sérialisées
  (cf. `settingsWebviewPanel.ts:326`).
- Les chemins stockés sont **workspace-relatifs** (`workspaceRelative()` ligne 467).
- La modale de confirmation est **non négociable** — l'utilisateur l'a explicitement demandée.
- Respecter la convention de commentaires du repo : commentaires brefs, focus sur le **pourquoi**,
  pas de docstrings multi-paragraphes (cf. `CLAUDE.md` / style observable dans
  `settingsWebviewPanel.ts`).
