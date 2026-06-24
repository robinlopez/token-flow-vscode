# Portage VS Code — Retirer l'option « Active editor » du panneau Analyse

> Issue **#21** — l'option *Active editor* du sélecteur de scope du panneau
> « Analyse » est inutile et source de confusion. La retirer.

Document **autonome** : ne couvre que cette modification.

---

## 1. Le problème

Le sélecteur de scope du panneau Analyse proposait une entrée dynamique
*« Active editor (nom-du-fichier) »* et **suivait l'éditeur actif** : à chaque
changement de fichier, l'entrée changeait de libellé et le scope analysé pouvait
dériver tout seul. C'est déroutant pour un rapport d'analyse, qui doit rester
stable tant que l'utilisateur ne change pas explicitement de scope.

**Objectif** : le scope du panneau Analyse devient un **choix explicite**
(*All project* par défaut + scopes configurés), qui ne suit plus l'éditeur.

> ⚠️ Ne PAS toucher aux autres vues : **Library** et **Hardcoded Values**
> continuent de suivre l'éditeur actif. Elles n'utilisent pas ce sélecteur.

---

## 2. Ce qu'il faut retirer / garder (panneau Analyse uniquement)

| Élément | Action |
|--------|--------|
| Entrée *« Active editor (…) »* ajoutée à la liste du sélecteur | **Retirer** |
| Listener de changement d'éditeur qui reconstruit le sélecteur (`onDidChangeActiveTextEditor` / équivalent) | **Retirer** (côté panneau Analyse) |
| Heuristique « pré-sélectionner le scope le plus profond du fichier actif » au premier affichage | **Retirer** → défaut = *All project* |
| Liste *All project* + scopes configurés | **Garder** |
| Mémorisation du choix explicite de l'utilisateur (sticky) | **Garder** |
| Reconstruction du sélecteur quand les scopes changent dans les settings | **Garder** |

---

## 3. Référence — équivalent du correctif (IntelliJ → VS Code)

### Avant (pseudo-TS, ce qu'il faut supprimer)

```typescript
// Construction des options du sélecteur
const items: ScopeChoice[] = [{ label: 'All project', representative: null }];

// ❌ À SUPPRIMER : entrée dynamique "Active editor"
const activeFile = vscode.window.activeTextEditor?.document.uri;
if (activeFile) {
  items.push({ label: `Active editor (${basename(activeFile)})`, representative: activeFile });
}

for (const scope of settings.scopes) {
  items.push({ label: `Scope: ${scope.name}`, representative: representativeFileFor(scope) });
}

// ❌ À SUPPRIMER : suivi de l'éditeur actif pour ce panneau
vscode.window.onDidChangeActiveTextEditor(() => rebuildScopePicker());

// ❌ À SUPPRIMER : heuristique "scope le plus profond du fichier actif"
if (!sticky && activeFile) {
  const deepest = activeScopesFor(activeFile).filter(s => !s.isCommon).at(-1);
  picker.selectedIndex = deepest ? indexOfScope(deepest) : 0;
}
```

### Après (ce qu'il reste)

```typescript
function rebuildScopePicker(): void {
  // Le scope Analyse est un choix explicite — il NE suit PAS l'éditeur (issue #21).
  const items: ScopeChoice[] = [{ label: 'All project', representative: null }];
  for (const scope of settings.scopes) {
    const rep = representativeFileFor(scope);
    if (rep) items.push({ label: `Scope: ${scope.name || '(unnamed)'}`, representative: rep });
  }
  setPickerItems(items);

  // Restaure le dernier choix explicite ; sinon défaut = "All project".
  const idx = stickyScopeKey ? items.findIndex(i => scopeChoiceKey(i) === stickyScopeKey) : -1;
  setSelectedIndex(idx >= 0 ? idx : 0);
}

function scopeChoiceKey(c: ScopeChoice): string {
  return c.label === 'All project' ? 'ALL' : c.label;   // (plus de branche "ACTIVE")
}

// Au montage du panneau : rebuildScopePicker() une fois.
// Sur changement des scopes (settings) : rebuildScopePicker().
// PAS d'abonnement à onDidChangeActiveTextEditor pour ce panneau.
```

---

## 4. Points de vigilance lors du portage

- **Découplage** : vérifier que le listener d'éditeur retiré n'est PAS partagé
  avec les vues Library / Hardcoded. Si l'abonnement est mutualisé, ne retirer
  que l'effet côté panneau Analyse, pas l'abonnement global.
- **Initialisation** : s'assurer que le sélecteur est bien peuplé au montage du
  panneau (un seul appel à `rebuildScopePicker()` à l'init), puisqu'on ne compte
  plus sur le listener d'éditeur pour le premier remplissage.
- **Sticky** : la clé sticky ne contient plus de sentinelle `ACTIVE`. Si elle est
  persistée (workspaceState), une ancienne valeur `ACTIVE` doit retomber
  proprement sur *All project* (le `findIndex` renvoie -1 → index 0).
- **Imports / API** : retirer l'import de l'API d'éditeur actif devenu inutile
  dans ce fichier (équivalent de `FileEditorManager`).

---

## 5. Test manuel (pas de test auto pour l'UI)

1. Ouvrir le panneau Analyse → le sélecteur montre *All project* + scopes, **pas**
   d'entrée *Active editor*.
2. Changer de fichier dans l'éditeur → la sélection du panneau Analyse **ne bouge
   pas**.
3. Choisir un scope, changer de fichier → le choix est conservé (sticky).
4. Modifier les scopes dans les settings → le sélecteur se reconstruit, *All
   project* + nouveaux scopes.
5. Library / Hardcoded Values → suivent toujours l'éditeur actif (inchangé).
