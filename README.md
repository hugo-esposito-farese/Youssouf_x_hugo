# Feuille véhicule — MVP

Boucle : **photo du compteur → IA (Claude, vision) → événement stocké → PDF du mois (2 feuilles) régénéré à chaque photo.**

- Voir `CLAUDE_youssouf.md` pour le contexte produit complet et les décisions déjà tranchées.
- Voir `docs/photos-et-sorties.md` pour le détail exact des photos reçues (2 types d'écran) et des 2 feuilles produites (véhicule + activité), établi à partir d'exemples réels.

## Structure

- `backend/` — API Express (Node.js), Postgres brut (pas d'ORM), extraction vision via l'API Claude, génération PDF (pdfkit). À déployer sur **Railway**.
- `frontend/` — écran de capture statique (HTML/CSS/JS, aucun framework) : deux boutons, lien vers le PDF. À déployer sur **Vercel**.

## Backend (Railway)

1. Créer un nouveau projet Railway, ajouter un service Postgres (fournit `DATABASE_URL` automatiquement).
2. Ajouter un service pour ce repo avec **Root Directory = `backend`**.
3. Monter un **volume Railway** sur le chemin défini par `PDF_STORAGE_DIR` (ex: `/data/pdfs`) pour que les PDF survivent aux redéploiements.
4. Renseigner les variables d'environnement (voir `backend/.env.example`) :
   - `ANTHROPIC_API_KEY`
   - `CLAUDE_MODEL` (optionnel, défaut `claude-sonnet-5`)
   - `DATABASE_URL` (auto si Postgres Railway lié)
   - `DRIVER_NAME`
   - `TRUCK_PLATE` (immatriculation affichée en en-tête de la feuille véhicule)
   - `PDF_STORAGE_DIR` (doit pointer vers le volume monté, ex: `/data/pdfs`)
   - `CORS_ORIGIN` (URL du frontend Vercel une fois déployé)
5. Railway build/run automatiquement via `backend/railway.json` (`npm install` puis `node src/server.js`).

En local :

```bash
cd backend
cp .env.example .env   # puis remplir ANTHROPIC_API_KEY et DATABASE_URL
npm install
npm run dev
```

## Frontend (Vercel)

1. Nouveau projet Vercel, **Root Directory = `frontend`**, pas de framework (site statique).
2. Une fois le backend déployé sur Railway, éditer `frontend/config.js` :
   ```js
   window.API_BASE_URL = 'https://<ton-service>.up.railway.app';
   ```
3. Déployer. Le frontend appelle directement l'API Railway (CORS géré côté backend via `CORS_ORIGIN`).

## Test rapide de la boucle

1. Ouvrir le frontend sur mobile (nécessaire pour la capture caméra via `capture="environment"`).
2. Taper "Je commence", prendre une photo du compteur → l'app affiche km / heure / jauge lus par l'IA.
3. Plus tard, taper "Je termine", prendre une nouvelle photo → le jour est clos, le lien "Voir la feuille véhicule du mois" apparaît et pointe vers le PDF à jour.
4. Recommencer le lendemain : le même PDF du mois est mis à jour avec une nouvelle ligne, pas régénéré comme un fichier séparé.
