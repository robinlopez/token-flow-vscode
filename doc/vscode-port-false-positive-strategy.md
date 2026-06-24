# Stratégie de portage VS Code — Réduction des faux positifs (indexer TS/JS & SCSS/CSS)

> Couvre les issues **#24** (objets d'application indexés comme tokens) et **#25**
> (modifiers BEM `--` détectés comme variables CSS), **y compris les affinements
> de la v0.2.2** : lookbehind sur `&`, garde sur `{`, et filtrage **niveau-feuille**.

---

## 0. Résumé des cas à corriger

| # | Entrée | Comportement fautif | Cause |
|---|--------|---------------------|-------|
| 24a | `export const ENTITY_EVENTS = { CREATED: 'ENTITY_CREATED' }` | `CREATED` indexé | Tout objet exporté est indexé |
| 24b | `WIDGET_LAYOUT_SCHEMA = { $schema, $defs, … }` | `$defs.X.properties…` indexé | JSON Schema parsé |
| 24c | `*.stories.ts`, `*.spec.ts` | props/args indexés | Aucun filtre par nom |
| **24d** | `HANDLING_UNIT_STATUS_CONFIG = { PICKING: { label:'…', bg:'#…' } }` | `PICKING.label` indexé | Objet gardé (a des couleurs) → **toutes** les feuilles émises |
| 25a | `.card__slot--closeable:hover` | `--closeable` indexé | `--` capté dans un sélecteur |
| **25b** | `&--selected:not(.x)` | `--selected` indexé | Lookbehind ne couvrait pas `&` |

Les lignes **en gras** sont les affinements v0.2.2.

---

## 1. Architecture : correspondance IntelliJ → VS Code

| Côté IntelliJ (Kotlin)            | Côté VS Code (TypeScript)                |
|-----------------------------------|------------------------------------------|
| `StyleValueHeuristics`            | `scanner/styleValueHeuristics.ts` (nouveau) |
| `JsTokenFileParserRegistry`       | `scanner/jsParserRegistry.ts`            |
| `JsObjectTokenParser`             | `scanner/jsObjectParser.ts`              |
| `StyleDictionaryParser`           | `scanner/styleDictionaryParser.ts`       |
| `RuntimeObjectParser`             | `scanner/runtimeObjectParser.ts`         |
| `TokenScanner.extractCssLike()`   | `scanner/scssScanner.ts`                 |
| `DynamicCssVarIndex.CSS_DECL`     | `scanner/dynamicCssVarIndex.ts`          |

---

## 2. Filtrage par valeur (#24a, #24b, **#24d**)

### 2.1 `src/scanner/styleValueHeuristics.ts` (nouveau)

```typescript
const ALIAS_STYLE_DICT = /^\{[A-Za-z_][\w.\-]*\}$/;
const RUNTIME_REF       = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$0-9][\w$]*)+$/;
const PURE_NUMBER       = /^-?\d*\.?\d+$/;
const HEX_COLOR         = /(?<![0-9a-fA-F#])#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
const COLOR_FN          = /\b(?:rgba?|hsla?)\s*\(/i;
const DIMENSION         = /(?<![.\w])\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|pt|cm|mm|fr|deg|rad|ms|s|%)(?![\w])/i;
const STYLE_FN          = /\b(?:var|calc|min|max|clamp|env|url|linear-gradient|radial-gradient|conic-gradient|translate[xyz3d]*|rotate[xyz]?|scale[xyz]?|cubic-bezier)\s*\(/i;

const STYLE_KEYWORDS = new Set([
  'bold','bolder','lighter','normal','italic','oblique',
  'thin','light','regular','medium','semibold','semi-bold','heavy','black',
  'solid','dashed','dotted','double','groove','ridge','inset','outset',
  'none','auto','transparent','currentcolor','inherit','initial','unset',
  'uppercase','lowercase','capitalize',
  'ease','ease-in','ease-out','ease-in-out','linear',
]);

export type ValueClass = 'style' | 'numeric' | 'non-style' | 'empty';

export function classifyValue(raw: string): ValueClass {
  const v = raw.trim();
  if (!v) return 'empty';
  if (ALIAS_STYLE_DICT.test(v) || RUNTIME_REF.test(v)) return 'style';
  if (PURE_NUMBER.test(v)) return 'numeric';
  if (HEX_COLOR.test(v) || COLOR_FN.test(v) || DIMENSION.test(v) || STYLE_FN.test(v)) return 'style';
  if (STYLE_KEYWORDS.has(v.toLowerCase())) return 'style';
  return 'non-style';
}

/** Niveau-OBJET : cet objet exporté est-il plausiblement un dictionnaire de tokens ? */
export function looksLikeTokenObject(values: string[]): boolean {
  let style = 0, numeric = 0, nonStyle = 0;
  for (const v of values) {
    switch (classifyValue(v)) {
      case 'style':     style++;    break;
      case 'numeric':   numeric++;  break;
      case 'non-style': nonStyle++; break;
    }
  }
  if (style + numeric + nonStyle === 0) return false;
  return style > 0 ? style >= nonStyle : (nonStyle === 0 && numeric > 0);
}

/**
 * Niveau-FEUILLE (#24d) : appliqué APRÈS que l'objet ait passé looksLikeTokenObject().
 * Un objet token peut porter des métadonnées non-style à côté de ses vraies valeurs —
 * ex. une config de statut { PICKING: { label:'…', color:'#4563a0' } } : on garde la
 * couleur (token), on jette le label (pas un token).
 */
export function isIndexableLeafValue(raw: string): boolean {
  const c = classifyValue(raw);
  return c === 'style' || c === 'numeric';
}
```

### 2.2 Branchement dans les parsers — **les deux niveaux**

```typescript
// styleDictionaryParser.ts
import { looksLikeTokenObject, isIndexableLeafValue } from './styleValueHeuristics';

export function parse(text: string): ParsedLeaf[] {
  return parseGroups(text)                                         // 1 groupe = 1 objet exporté
    .filter(group => looksLikeTokenObject(group.map(l => l.value))) // niveau-OBJET
    .flat()
    .filter(leaf => isIndexableLeafValue(leaf.value));             // niveau-FEUILLE (#24d)
}
```

```typescript
// runtimeObjectParser.ts — même logique par déclaration
for (const decl of declarations) {
  const leaves = parseObjectAt(text, decl.braceIndex, decl.initialPath);
  if (!looksLikeTokenObject(leaves.map(l => l.value))) continue;   // niveau-OBJET
  for (const leaf of leaves) {
    if (!isIndexableLeafValue(leaf.value)) continue;               // niveau-FEUILLE (#24d)
    out.push(leaf);
  }
}
```

> ⚠️ **Ne pas oublier le niveau-feuille.** Sans lui, `HANDLING_UNIT_STATUS_CONFIG`
> (moitié couleurs, moitié labels) passe le filtre objet puis ré-émet `PICKING.label`.

---

## 3. Skip JSON Schema / Storybook (#24b, #24c)

```typescript
// jsParserRegistry.ts
export type Mode = 'style-dictionary' | 'runtime' | 'none';

// $schema / $defs / $ref — quotés OU non, précédés d'une frontière (évite obj.$ref)
const SKIP_HINTS    = /from\s+['"`]@storybook\/|[\s{,([]['"`]?\$(?:schema|defs|ref)['"`]?\s*:/;
const STYLE_DICT_ALIAS = /['"`]\{[A-Za-z][\w.\-]*\}['"`]/;
const RUNTIME_HINTS = /from\s+['"`]react-native['"`\/]|StyleSheet\.create\s*\(|^\s*export\s+const\s+\w+\s*:\s*\w+(?:<[^>]*>)?\s*=/m;

export function detectMode(text: string): Mode {
  if (SKIP_HINTS.test(text))    return 'none';     // #24b + storybook
  if (STYLE_DICT_ALIAS.test(text)) return 'style-dictionary';
  if (RUNTIME_HINTS.test(text)) return 'runtime';
  return 'style-dictionary';
}
```

```typescript
// jsScanner.ts
async function extractJsLike(uri: vscode.Uri, sink: RawToken[]) {
  const fileName = path.basename(uri.fsPath);
  if (/\.stories\.|\.spec\.|\.test\./.test(fileName)) return;       // #24c
  const text = await readFile(uri);
  const mode = detectMode(text);
  if (mode === 'none') return;                                      // #24b
  // … parse selon le mode
}
```

---

## 4. BEM `--modifier` dans les sélecteurs (#25a + **#25b** + garde `{`)

### 4.1 Regex de déclaration de variable — `scssScanner.ts`

```typescript
//                  ┌─ #25a (préfixe alphanumérique : .block__el--mod)
//                  │        ┌─ #25b (préfixe & : parent-ref SCSS &--selected)
const CSS_VAR_RE = /(?<![A-Za-z0-9_&-])--([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;}\n]+)\s*;?/g;

export function extractCssVars(text: string): CssVar[] {
  const out: CssVar[] = [];
  let m: RegExpExecArray | null;
  CSS_VAR_RE.lastIndex = 0;
  while ((m = CSS_VAR_RE.exec(text)) !== null) {
    // Garde : une vraie valeur ne contient jamais `{`. S'il y en a un, on a capté
    // un sélecteur qui a franchi le lookbehind (modifier collé à l'accolade ouvrante).
    if (m[2].includes('{')) continue;
    out.push({ name: '--' + m[1], value: m[2].trim().replace(/;$/, '').trim(), offset: m.index });
  }
  return out;
}
```

### 4.2 Même correctif pour l'index dynamique — `dynamicCssVarIndex.ts`

Le `CSS_DECL` (détection des déclarations hors-sources, pour les broken-refs) doit
porter **le même** lookbehind `[A-Za-z0-9_&-]`, sinon `&--selected` réapparaît côté
analyse.

```typescript
const CSS_DECL = /(?<![A-Za-z0-9_&-])--([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;\n}]*)/g;
```

### 4.3 Ce qui doit RESTER détecté

```scss
:root { --brand: #FE5716; }              // ✓ var racine
.button { --button-bg: var(--brand); }   // ✓ var dans une règle
--foo: red;                              // ✓ début de fichier (lookbehind sur ∅)
```

Et `var(--x)` en **valeur** (`box-shadow: 0 0 6px var(--wi-fill-color, var(--color-primary))`)
n'est jamais une *déclaration* : les `--x` y sont suivis de `,` / `)`, pas de `:`.

> ⚠️ **Lookbehind en JS** : Node ≥ 10 / tous les moteurs VS Code modernes
> supportent `(?<!…)`. Si une cible exotique ne le supporte pas, remplacer par une
> capture du caractère précédent + test : `/(^|[^A-Za-z0-9_&-])--(…)/` puis ignorer
> le groupe 1.

---

## 5. Variable SCSS locale (depth > 0) — rappel #24

`$var:` n'est un token que **hors de tout bloc** (`{ }`). Compteur de profondeur
incrémental entre les matches :

```typescript
const SCSS_VAR_RE = /^\s*\$([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([^;\n]+)\s*;?/gm;

export function extractScssVars(text: string): ScssVar[] {
  const out: ScssVar[] = [];
  let depth = 0, pos = 0, m: RegExpExecArray | null;
  SCSS_VAR_RE.lastIndex = 0;
  while ((m = SCSS_VAR_RE.exec(text)) !== null) {
    while (pos < m.index) {
      if (text[pos] === '{') depth++;
      else if (text[pos] === '}' && depth > 0) depth--;
      pos++;
    }
    if (depth > 0) continue;   // variable locale (@function / @mixin / sélecteur)
    out.push({ name: '$' + m[1], value: m[2].trim().replace(/\s*!(default|global|important)\s*$/,'').trim(), offset: m.index });
  }
  return out;
}
```

---

## 6. Ordre de mise en œuvre

1. `styleValueHeuristics.ts` — logique pure (objet **et** feuille)
2. `jsParserRegistry.ts` — `Mode.none` + `SKIP_HINTS`
3. `jsObjectParser.ts` — `parseGroups()` (un tableau de feuilles par objet exporté)
4. `styleDictionaryParser.ts` + `runtimeObjectParser.ts` — brancher **les deux** filtres
5. `jsScanner.ts` — guards nom de fichier + `mode === 'none'`
6. `scssScanner.ts` — lookbehind `&`, garde `{`, depth-tracking SCSS
7. `dynamicCssVarIndex.ts` — aligner le lookbehind `&` sur `CSS_DECL`

---

## 7. Tests à porter

| Kotlin (source)                | TypeScript (cible)                  |
|--------------------------------|-------------------------------------|
| `StyleValueHeuristicsTest.kt`  | `styleValueHeuristics.test.ts`      |
| `JsParserFalsePositiveTest.kt` | `jsParserFalsePositive.test.ts`     |
| `CssVarRegexTest.kt`           | `cssVarRegex.test.ts`               |

### Cas minimaux

```
# #24
✓ Palette couleurs → conservée
✓ Échelle numérique (espacement/poids) → conservée
✓ Preset Style-Dictionary + alias {a.b.c} → conservé
✓ Enum d'événements (ENTITY_CREATED…) → rejeté (objet)
✓ Corps JSON Schema → rejeté + Mode.none sur $schema/$ref
✓ Fichier *.stories.ts → ignoré
✓ Config de statut { label, variant, bg, color } → SEULES bg/color conservées   ← #24d
✓ Fichier mixte (colors + STATUS enum) → seul colors conservé

# #25
✓ .card__slot--closeable:hover → aucune var                                       ← #25a
✓ &--selected:not(.is-zone-highlighted) → aucune var                              ← #25b
✓ box-shadow: var(--x, var(--y)) → aucune *déclaration*
✓ &--active:hover { … } → garde `{` rejette
✓ :root { --brand: #fff } + &--selected → seul --brand capturé
✓ Variable SCSS dans @function → ignorée ; top-level → conservée
```

---

## 8. Limites connues (identiques au plugin IntelliJ)

| Cas | Comportement | Acceptable ? |
|-----|--------------|--------------|
| Objet monofonte `{ ff: 'Inter, sans-serif' }` | rejeté (aucune valeur style) | ✓ rare |
| Objet config-composant avec vraies couleurs (`bg`/`color`) | couleurs conservées, métadonnées (`label`) jetées | ✓ — n'indexe que des couleurs réelles. Si non désiré : filtrer `*.config.ts`/`*.model.ts` ou durcir le seuil objet |
| Objet purement numérique de config (`{ timeout: 5000 }`) | conservé (indiscernable d'une échelle d'espacement par la valeur) | ⚠ limite connue, peu nuisible |
| `$var` SCSS avec `!global` dans un bloc | ignorée (depth > 0) | ⚠ si le projet en dépend, traitement spécifique requis |
| Moteur regex sans lookbehind | voir §4.3 (fallback groupe capturant) | — |
