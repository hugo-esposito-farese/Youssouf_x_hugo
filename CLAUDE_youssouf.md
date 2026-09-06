# CLAUDE.md — Contexte projet pour Claude Code

## Le produit, en une phrase

**Je prends mes photos → l'IA complète → génère le PDF (quand le document est complet) → je répète.**

C'est ça, et uniquement ça. Toute fonctionnalité qui ne sert pas directement cette boucle est une distraction et ne doit pas être construite sans qu'on le demande explicitement.

## La boucle exacte

1. **Le chauffeur prend une photo** de l'écran du compteur du camion, en indiquant s'il s'agit d'un **début** ou d'une **fin** d'activité (un tap avant la photo — le plus simple et le plus fiable à coder, ne pas essayer de déduire ça automatiquement).
2. **L'IA (Claude, vision) complète les données** à partir de la photo : kilométrage, heure affichée à l'écran, niveau de carburant (barre à côté de l'icône de GAUCHE uniquement — celle de droite est la batterie, à ignorer).
3. **Dès qu'un document est complet, le PDF est généré automatiquement.** "Complet" = dès qu'un jour a à la fois un événement "début" et un événement "fin", ce jour est clos : régénérer/mettre à jour le PDF du mois en cours avec la ligne de ce jour remplie (km départ, km arrivée, jauge départ, jauge arrivée). Pas besoin d'attendre la fin du mois pour voir un résultat — chaque jour clos met à jour le document.
4. **Le PDF est stocké côté serveur et accessible via un lien direct** (téléchargement/consultation). **Pas d'intégration Google Drive pour ce MVP** — voir remarque ci-dessous, c'est un choix volontaire, pas un oubli.
5. **On répète** : le chauffeur reprend une photo au prochain début/fin d'activité, et la boucle recommence — le PDF existant est mis à jour (même fichier), pas régénéré comme un nouveau fichier séparé à chaque fois.

## Pourquoi pas de Drive dans ce MVP

Écrire directement sur le Drive personnel d'un utilisateur nécessite toujours une autorisation de sa part (OAuth "Se connecter avec Google" + scope Drive) — un compte de service seul ne suffit pas pour un Drive perso, il faudrait un partage manuel de dossier en amont. Ce n'est pas compliqué en soi, mais ça ajoute un flux d'authentification supplémentaire qui n'apporte rien pour valider la seule chose qui compte ce week-end : est-ce que la boucle photo → IA → PDF fonctionne. Le PDF stocké côté serveur avec un lien direct permet exactement la même validation, sans cette étape. Le chauffeur/vous pouvez sauvegarder le PDF dans votre Drive personnel manuellement en un clic depuis ce lien si besoin.

**V2** : ajouter "Se connecter avec Google" (OAuth utilisateur, pas de compte de service) pour uploader automatiquement vers le Drive du chauffeur — uniquement une fois la boucle de base validée sur le terrain.

## Portée du document PDF généré

- Reproduit le modèle "feuille véhicule" fourni : date, km départ, km arrivée, jauge départ, jauge arrivée, conducteur.
- Les horaires Début/Fin (feuille "activité") peuvent être inclus s'ils sont simples à dériver des mêmes événements, mais ce n'est pas la priorité — la feuille véhicule (km + carburant) est le cœur du produit.
- **Destination, petit-déjeuner, repas midi/soir, découché national/international : hors périmètre, ne jamais essayer de les remplir.**

## Ce qui NE fait PAS partie du MVP (ne pas construire sans qu'on le demande)

- Pas de tableau de bord web avec liste d'événements à parcourir.
- Pas d'écran de correction/édition manuelle des valeurs lues par l'IA.
- Pas d'historique consultable, pas de recherche, pas de multi-chauffeurs/multi-véhicules avec sélection.
- Pas d'authentification complexe.
- Pas de résumé/statistiques.
- Si l'IA n'arrive pas à lire une valeur avec certitude, gérer ça de la façon la plus simple possible (ex. marquer la case comme vide/à vérifier dans le PDF plutôt que d'inventer une valeur) — mais ne pas construire toute une UI de validation autour de ça pour ce MVP.

Toutes ces choses sont potentiellement utiles plus tard, mais elles retardent le test réel et distraient du seul objectif : **valider que la boucle photo → PDF → Drive fonctionne concrètement avec un vrai chauffeur.**

## Décisions de conception déjà tranchées (ne pas revenir dessus sans raison)

- **Type d'événement (début/fin) choisi explicitement par le chauffeur avant la photo**, pas déduit par une logique d'alternance automatique.
- **L'heure** est lue directement dans l'image (affichée à l'écran du camion), pas depuis l'horloge du téléphone/serveur.
- **La date du jour** : à définir simplement (ex. horloge serveur au moment de l'upload) sans sur-ingénierie.
- **Le niveau de carburant est structurellement approximatif** (lecture d'une barre graphique). Ne pas chercher à le rendre précis pour ce MVP — l'important est qu'il apparaisse dans le PDF, pas qu'il soit parfait.
- **Pas d'ORM, pas de framework backend lourd.** Le strict nécessaire pour stocker les événements et regénérer le PDF suffit.

## Architecture attendue

- **Backend (Railway)** : reçoit la photo + le type (début/fin), appelle l'API Claude en vision pour extraire les données, stocke l'événement, régénère le PDF du jour/mois quand un jour est clos, sert ce PDF via une URL directe (fichier stocké sur disque/volume Railway, ou en base).
- **Frontend (Vercel)** : uniquement l'écran de capture — deux boutons ("Je commence" / "Je termine"), plus un lien vers le PDF généré une fois disponible. Rien d'autre. Pas de tableau, pas de deuxième page complexe.
- **Pas de Google Drive dans ce MVP** (voir section ci-dessus).

## Variables d'environnement à prévoir

- `ANTHROPIC_API_KEY` — clé API Claude (déjà disponible)
- Base de données (Postgres Railway ou équivalent) pour stocker les événements en attendant la clôture d'un jour

## Priorité absolue pendant le dev

Le produit se résume à la boucle décrite en haut de ce fichier. À chaque décision technique, se demander : "est-ce que ça sert directement à faire fonctionner photo → PDF → Drive → répéter ?" Si non, ne pas le construire maintenant.
