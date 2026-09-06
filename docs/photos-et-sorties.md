# Photos reçues et sorties attendues — référence terrain

Ce fichier documente, à partir d'exemples réels envoyés par l'utilisateur (photos du camion + templates papier actuellement utilisés), ce que l'IA va concrètement recevoir en entrée et ce qu'elle doit produire en sortie. Il complète `CLAUDE_youssouf.md` (qui reste la source de vérité sur le périmètre et les décisions produit) sans le contredire : ici on précise le **format exact**, pas le périmètre.

## 1. Photos d'entrée (écran du compteur)

Deux écrans différents peuvent être photographiés par le chauffeur pour la même action (début/fin) — l'IA doit reconnaître les deux.

### Type A — Tableau de bord principal (écran couleur central)

Exemple : photo de nuit, écran central du combiné d'instruments.

- **Kilométrage** : affiché en gros avec **une décimale** (ex. `502225.6 km`). Ne pas arrondir à l'entier — stocker la décimale.
- **Heure** : affichée en bas de l'écran (ex. `21:26`), format 24h.
- **Deux barres de jauge côte à côte**, chacune avec une petite icône et une échelle segmentée (une dizaine de segments) :
  - **Icône de GAUCHE = carburant** → c'est celle à lire. Sur l'exemple, la barre est presque pleine (~9 segments sur ~10 allumés en blanc) → estimer un pourcentage 0-100.
  - **Icône de DROITE = batterie** → à ignorer totalement, même si elle est allumée en rouge (batterie faible ≠ carburant faible). Ne jamais lire cette barre pour la jauge.
- Autres éléments visibles à l'écran (température, compteur de repos "00h20", vitesse) : hors périmètre, ne jamais les extraire.

### Type B — Boîtier secondaire "Renault Trucks" (petit écran monochrome, boutons OK/haut/bas)

Exemple : même camion, même instant que Type A (`21:26`, `502225.6km`), mais afficheur différent.

- Affiche **heure** et **kilométrage** (même précision décimale), mais **aucune jauge carburant visible**.
- Conséquence directe : si le chauffeur photographie ce boîtier plutôt que le combiné principal, `jauge = null` est **attendu et normal**, pas une erreur d'extraction. Ne pas essayer de deviner une jauge absente de la photo.

### Règle d'extraction (déjà en place, confirmée par ces exemples)

Si une valeur n'est pas visible ou pas lisible avec certitude sur la photo (quel que soit le type d'écran), renvoyer `null` plutôt que d'inventer — cf. `CLAUDE_youssouf.md`.

## 2. Sorties attendues : 2 feuilles, dans le même PDF mensuel

Le PDF mensuel contient **deux pages** (deux feuilles), reproduisant les deux documents papier actuellement utilisés par l'utilisateur. Les deux pages listent **tous les jours du mois en cours**, pas seulement les jours "clos" — un jour sans données a simplement des cases vides (comme le template papier vierge).

### Page 1 — Feuille véhicule (référence : photo du classeur avec le tableau `GC-506-VT`)

En-tête : immatriculation du véhicule (une seule valeur fixe pour ce MVP, un seul camion — pas de sélection multi-véhicule).

Colonnes, une ligne par jour du mois :

| Date | km départ | km arrivée | jauge départ | jauge arrivée | litrage pris | conducteur |
|---|---|---|---|---|---|---|

- **km départ / km arrivée** : lus sur les events `debut`/`fin` du jour (avec décimale).
- **jauge départ / jauge arrivée** : sur le papier, ce n'est **pas du texte** mais une **échelle graphique 0→100 avec un repère** (comme une mini jauge à aiguille). Le PDF généré doit reproduire ça visuellement (barre + graduations + marqueur à la position lue), pas juste écrire "3/4" ou "70%" en texte.
- **litrage pris** : donnée de plein d'essence, **jamais disponible depuis la photo du compteur** (il faudrait un ticket de caisse). Colonne laissée vide dans ce MVP — hors périmètre, ne pas essayer de la remplir.
- **conducteur** : valeur fixe (`DRIVER_NAME`), MVP = un seul chauffeur.

Un jour n'affiche km/jauge que s'il est "clos" au sens déjà défini dans `CLAUDE_youssouf.md` (un event `debut` ET un event `fin` ce jour-là) ; sinon les cases restent vides mais la ligne du jour existe quand même (comme le template vierge).

### Page 2 — Feuille activité (référence : photo du classeur "août-26")

Colonnes, une ligne par jour du mois :

| Date | de 0h à 8h00 | de 8h à 16h | de 16h à 24h | destination | petit déjeuner | repas midi | repas soir | découché inter | découché natio |
|---|---|---|---|---|---|---|---|---|---|

- Les 3 colonnes horaires reçoivent le texte `Début HH:MM` / `Fin HH:MM` de **chaque** event de la journée, placé dans la tranche horaire correspondant à l'heure lue sur la photo (0h-7h59 / 8h-15h59 / 16h-23h59) — **pas** forcément une seule paire début/fin par jour : une journée peut avoir plusieurs shifts, et un shift peut commencer la veille et se terminer le lendemain (le "Fin" apparaît alors dans la case du jour où il a réellement eu lieu, pas dans celle du "Début" correspondant). Si plusieurs events tombent dans la même tranche le même jour, ils s'empilent dans la même case (plusieurs lignes de texte).
- **destination / petit déjeuner / repas midi / repas soir / découché (inter/natio)** : colonnes du template papier, **hors périmètre** pour ce MVP (cf. `CLAUDE_youssouf.md`) — laissées vides, jamais remplies automatiquement.

## 3. Conséquences concrètes sur l'implémentation

Par rapport à la première version du code, ces exemples réels imposent :

1. **`km` en décimal** (pas un entier) — schéma DB et extraction Claude à ajuster.
2. **`jauge` en pourcentage entier 0-100 (ou `null`)**, estimé en comptant les segments allumés de la barre de GAUCHE uniquement — plus fidèle que l'ancien enum `vide/1/4/1/2/3/4/plein`, et permet de dessiner un vrai graphique dans le PDF.
3. **Le PDF a 2 pages** (feuille véhicule + feuille activité), régénérées ensemble à chaque event reçu.
4. **Le PDF liste tous les jours du mois**, pas uniquement les jours clos — jours vides = cases vides, comme le template papier.
5. **La jauge est dessinée comme une mini-échelle graphique** dans le PDF, pas comme du texte.
6. **`litrage pris` reste une colonne vide** dans le PDF (non demandée, non disponible depuis la photo).
7. **Immatriculation du véhicule** : nouvelle valeur fixe à configurer (env var), affichée en en-tête de la feuille véhicule.
