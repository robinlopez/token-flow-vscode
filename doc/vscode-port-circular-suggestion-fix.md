# Stratégie de portage VS Code — Fix : suggestion circulaire (auto-référence)

> Issue **#23** — le moteur de suggestion propose, pour la valeur hardcodée d'une
> **définition** de token, ce token **lui-même** en remplacement, créant une
> référence circulaire.

Ce document est **autonome** : il ne couvre que ce correctif (pas les évolutions
#24 / #25 traitées ailleurs).

---

## 1. Le bug

Définition :

```css
--color-bg-page: #e5e9eb;
```

Le plugin signale `#e5e9eb` comme hardcodé et propose `var(--color-bg-page)`.
Appliqué, cela donne une boucle invalide :

```css
--color-bg-page: var(--color-bg-page);   /* ❌ */
```

**Cause racine** : le détecteur de littéraux connaît le *nom de la variable en
cours de déclaration* (`declarationName` sur le « Hit »), mais cette information
n'était jamais transmise au moteur de suggestion. Celui-ci cherchait la valeur
`#e5e9eb` dans l'index, retrouvait `--color-bg-page` (qui a justement cette
valeur) et la proposait — sans savoir que c'est la variable qu'on est en train
de définir.

---

## 2. Le correctif (côté IntelliJ, pour référence)

Un seul point d'entrée filtre désormais l'auto-référence, donc **tous** les
appelants (inspection in-editor, scan du dashboard) en bénéficient :

```kotlin
fun findSuggestions(hit, valueIndex, allTokens, expectedCategory, expectedRole): List<TokenSuggestion> {
    val ranked = rankSuggestions(hit, valueIndex, allTokens, expectedCategory, expectedRole)
    val declaring = hit.declarationName ?: return ranked      // pas une déclaration → rien à exclure
    return ranked.filter { !isSelfReference(it.token.name, declaring) }
}

private fun isSelfReference(tokenName: String, declarationName: String): Boolean {
    val t = tokenName.trim(); val d = declarationName.trim()
    if (t.equals(d, ignoreCase = true)) return true
    fun strip(s: String) = s.removePrefix("--").removePrefix("$")
    val ts = strip(t); val ds = strip(d)
    if (ts.equals(ds, ignoreCase = true)) return true
    return ds.isNotEmpty() && ts.endsWith(".$ds", ignoreCase = true)  // chemin JS : clé feuille
}
```

Idée clé : le **filtre est centralisé** dans la fonction publique, et le corps de
calcul existant est isolé dans une fonction privée (`rankSuggestions`). On n'a pas
à toucher chaque `return` du moteur.

---

## 3. Portage VS Code (TypeScript)

### 3.1 Pré-requis — propager le nom de déclaration

Le détecteur de littéraux doit exposer le nom de la variable déclarée au point du
littéral. Si ce n'est pas déjà le cas, l'ajouter au type « Hit » :

```typescript
// literalFinder.ts
export interface Hit {
  text: string;
  startOffset: number;
  kind: 'color' | 'length' | 'number' | 'duration' | 'reference';
  isDeclaration: boolean;
  declarationName?: string;   // '--color-bg-page' | '$color-bg-page' | 'bg' (clé JS)
  // …
}
```

Le calcul de `declarationName` : remonter depuis l'offset du littéral, sauter
guillemets / espaces / `:`, lire l'identifiant, puis :

```typescript
// Pseudo : à la position de l'identifiant remonté
if (prevChar === '$')                    return '$' + name;     // SCSS
if (prevTwoChars === '--')               return '--' + name;    // CSS custom property
/* sinon (objet JS/JSON) */              return name;           // clé feuille seule
```

### 3.2 Le filtre dans le moteur de suggestion

```typescript
// suggestionEngine.ts
export function findSuggestions(
  hit: Hit,
  valueIndex: TokenValueIndex,
  allTokens: DesignToken[],
  expectedCategory: TokenCategory | null,
  expectedRole?: TokenRole,
): TokenSuggestion[] {
  const ranked = rankSuggestions(hit, valueIndex, allTokens, expectedCategory, expectedRole);
  const declaring = hit.declarationName;
  if (!declaring) return ranked;                       // pas une déclaration
  return ranked.filter(s => !isSelfReference(s.token.name, declaring));
}

function isSelfReference(tokenName: string, declarationName: string): boolean {
  const t = tokenName.trim();
  const d = declarationName.trim();
  if (t.toLowerCase() === d.toLowerCase()) return true;
  const strip = (s: string) => s.replace(/^--/, '').replace(/^\$/, '');
  const ts = strip(t).toLowerCase();
  const ds = strip(d).toLowerCase();
  if (ts === ds) return true;
  // Chemin objet JS : declarationName = clé feuille (`bg`), token name = `colors.bg`.
  return ds.length > 0 && ts.endsWith('.' + ds);
}

// `rankSuggestions` = la logique de scoring/lookup existante, inchangée.
function rankSuggestions(/* … */): TokenSuggestion[] { /* … */ }
```

> **Important** : renommer l'implémentation actuelle en `rankSuggestions` et faire
> du `findSuggestions` public un simple wrapper. Si la logique de scoring fait des
> appels récursifs (cas des références cassées avec valeur de repli), ils passeront
> par le wrapper avec un hit synthétique **sans** `declarationName` → filtre neutre,
> aucun risque.

### 3.3 Vérifier les appelants

- **Inspection / diagnostic in-editor** : doit passer le vrai `hit` (avec
  `declarationName`). C'est ce chemin qui déclenche le bug → corrigé d'office.
- **Scan global (dashboard)** : s'il construit un « hit synthétique » sans
  `declarationName`, le filtre est neutre — c'est acceptable **à condition** que le
  scan exclue déjà les hits de définition dont le nom ∈ noms-de-tokens connus
  (sinon, ajouter ce pré-filtre, ou propager `declarationName` dans le hit
  synthétique).

---

## 4. Tests à porter

| IntelliJ                              | VS Code                                  |
|---------------------------------------|------------------------------------------|
| `SuggestionEngineSelfReferenceTest.kt`| `suggestionEngineSelfReference.test.ts`  |

### Cas minimaux

```
✓ --color-bg-page: #e5e9eb (déclaration CSS)  → NE propose PAS var(--color-bg-page)
✓ Idem mais un AUTRE token (--surface-muted) a la même valeur → le propose, lui
✓ background: #e5e9eb (usage, pas de declarationName)         → propose --color-bg-page (OK)
✓ $color-bg-page: #e5e9eb (déclaration SCSS)                  → exclut $color-bg-page
✓ colors.bg: '#e5e9eb' (déclaration JS, clé feuille 'bg')     → exclut colors.bg (suffixe)
```

---

## 5. Limites / vigilance

| Cas | Comportement | Note |
|-----|--------------|------|
| Deux tokens distincts partageant la même clé feuille JS (`a.bg`, `b.bg`) et on définit `bg` | les deux exclus par le match de suffixe | acceptable : dans un contexte d'auto-définition, le littéral *est* celui de cet objet |
| Hit synthétique sans `declarationName` (scan global) | filtre neutre | s'appuyer sur le pré-filtre « nom ∈ tokens connus » côté scan |
| Casse / préfixes (`--`, `$`) | normalisés avant comparaison | — |
