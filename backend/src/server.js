require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { pool, initSchema } = require('./db');
const { extraireDonneesCompteur } = require('./claudeVision');
const { verifyPassword, issueToken, verifyToken } = require('./auth');
const {
  regenerateMonthPdf,
  pdfFileName,
  getDonneesVehiculeParJour,
  getEvenementsActiviteParJour,
  getOverridesParJour,
  mergeJourVehicule,
  mergeJourActivite,
  buildDateList,
} = require('./pdf');

const PORT = process.env.PORT || 3000;
const TRUCK_PLATE = process.env.TRUCK_PLATE || 'GC-506-VT';

// Nom affiché comme "Conducteur" sur la feuille : dérivé du compte connecté (chaque compte a sa
// propre feuille, cf. migration multi-compte) plutôt qu'un DRIVER_NAME global fixe.
function displayName(username) {
  return username.charAt(0).toUpperCase() + username.slice(1);
}
const PDF_STORAGE_DIR = path.resolve(process.env.PDF_STORAGE_DIR || './data/pdfs');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// En prod, AUTH_SECRET doit être fixe (sinon tout le monde est déconnecté à chaque redéploiement).
// Repli aléatoire uniquement pratique pour du dev/test local jetable.
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) {
  console.warn('AUTH_SECRET non défini : secret aléatoire généré pour ce process (sessions perdues au redémarrage).');
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Identifiants manquants.' });
  }
  try {
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE username = $1', [username]);
    // Message identique pour user inconnu / mauvais mot de passe : ne pas donner d'indice
    // permettant de deviner quels usernames existent.
    if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    const token = issueToken({ id: rows[0].id, username }, AUTH_SECRET);
    res.json({ token, username });
  } catch (err) {
    console.error('Erreur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = headerToken || req.query.token;
  const payload = verifyToken(token, AUTH_SECRET);
  if (!payload) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  req.user = payload;
  next();
}

// Le PDF est un lien direct (<a href>, ouvert dans un nouvel onglet) : pas d'en-tête
// Authorization possible, le token voyage donc en query string pour cette route uniquement.
// Pas de express.static ici : il faut vérifier que le fichier demandé appartient bien au compte
// connecté (le nom de fichier commence par son username, cf. pdf.js pdfFileName) — sinon
// n'importe quel utilisateur authentifié pourrait lire la feuille d'un autre en devinant/
// énumérant un nom de fichier.
app.get('/files/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9_-]+\.pdf$/.test(filename)) {
    return res.status(400).json({ error: 'Nom de fichier invalide.' });
  }
  const prefix = `feuille-vehicule-${req.user.username}-`;
  if (!filename.startsWith(prefix)) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }

  const filePath = path.join(PDF_STORAGE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    // Génère la feuille à la demande (vide si le compte n'a encore rien renseigné) plutôt que
    // de renvoyer 404 : un compte tout juste créé doit pouvoir consulter sa feuille (vide) dès
    // le départ, sans attendre une première photo.
    const match = filename.slice(prefix.length).match(/^(\d{4})-(\d{2})\.pdf$/);
    if (!match) return res.status(404).json({ error: 'Fichier introuvable.' });
    try {
      await regenerateMonthPdf({
        pool, storageDir: PDF_STORAGE_DIR, year: Number(match[1]), month: Number(match[2]),
        driverName: displayName(req.user.username), truckPlate: TRUCK_PLATE,
        userId: req.user.id, username: req.user.username,
      });
    } catch (err) {
      console.error('Erreur lors de la génération à la demande du PDF :', err);
      return res.status(500).json({ error: 'Erreur lors de la génération du PDF.' });
    }
  }

  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable.' });
  });
});

// Tout le reste de l'API (au-delà de /health et /api/login, déjà déclarés plus haut) exige une
// session valide : personne d'extérieur ne peut lire ni modifier la feuille.
app.use('/api', requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo, large marge pour une photo de compteur
});

// Date du jour = horloge serveur au moment de l'upload (décision CLAUDE.md, pas de sur-ingénierie).
function todayISODate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

app.post('/api/events', upload.single('photo'), async (req, res) => {
  try {
    const { type } = req.body;
    if (type !== 'debut' && type !== 'fin') {
      return res.status(400).json({ error: "Le champ 'type' doit valoir 'debut' ou 'fin'." });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Aucune photo reçue.' });
    }

    const mimeType = req.file.mimetype || 'image/jpeg';
    const donnees = await extraireDonneesCompteur(req.file.buffer, mimeType);

    const eventDate = todayISODate();
    const insertResult = await pool.query(
      `INSERT INTO events (event_date, type, km, heure, jauge, conducteur, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, event_date, type, km, heure, jauge, conducteur, created_at`,
      [eventDate, type, donnees.km, donnees.heure, donnees.jauge, displayName(req.user.username), req.user.id],
    );
    const event = insertResult.rows[0];

    // Un jour est clos dès qu'il a un event 'debut' ET un event 'fin' (cf. CLAUDE.md) : ça ne
    // conditionne que le remplissage des cases km/jauge de la feuille véhicule pour ce jour-là
    // (voir pdf.js). Le PDF (les 2 feuilles) est régénéré à chaque event, car la feuille
    // activité doit refléter tout event, même sur un jour pas encore clos.
    const { rows: typesDuJour } = await pool.query(
      `SELECT DISTINCT type FROM events WHERE event_date = $1 AND user_id = $2`,
      [eventDate, req.user.id],
    );
    const types = typesDuJour.map((r) => r.type);
    const jourClos = types.includes('debut') && types.includes('fin');

    const [year, month] = eventDate.split('-').map(Number);
    const { fileName } = await regenerateMonthPdf({
      pool,
      storageDir: PDF_STORAGE_DIR,
      year,
      month,
      driverName: displayName(req.user.username),
      truckPlate: TRUCK_PLATE,
      userId: req.user.id,
      username: req.user.username,
    });

    res.json({ event, jourClos, pdfUrl: `/files/${fileName}` });
  } catch (err) {
    console.error("Erreur lors du traitement de l'événement :", err);
    res.status(500).json({ error: "Erreur lors du traitement de la photo. Réessaie." });
  }
});

// Lien direct vers le PDF du mois en cours, pratique côté frontend même avant tout upload.
app.get('/api/pdf/current-url', (req, res) => {
  const now = new Date();
  const fileName = pdfFileName(now.getFullYear(), now.getMonth() + 1, req.user.username);
  res.json({ pdfUrl: `/files/${fileName}` });
});

// Donnée fusionnée (IA + corrections manuelles) d'un mois, pour l'écran "feuille éditable".
// Réutilise exactement les mêmes requêtes/fonctions de fusion que la génération du PDF (pdf.js)
// pour garantir que l'écran et le PDF ne divergent jamais.
async function getMonthPayload(year, month, userId) {
  const dates = buildDateList(year, month);
  const [donneesParJour, evenementsParJour, overridesParJour] = await Promise.all([
    getDonneesVehiculeParJour(pool, year, month, userId),
    getEvenementsActiviteParJour(pool, year, month, userId),
    getOverridesParJour(pool, year, month, userId),
  ]);

  const days = dates.map((date) => {
    const override = overridesParJour.get(date);
    return {
      date,
      vehicule: mergeJourVehicule(donneesParJour.get(date), override),
      activite: {
        ...mergeJourActivite(override),
        bande0: (evenementsParJour.get(date) || {}).bande0 || [],
        bande1: (evenementsParJour.get(date) || {}).bande1 || [],
        bande2: (evenementsParJour.get(date) || {}).bande2 || [],
      },
    };
  });

  return { year, month, days };
}

// Mois en cours au sens de l'horloge serveur (même convention que todayISODate ci-dessus) :
// évite un décalage entre "aujourd'hui" côté navigateur et côté serveur (qui fait foi pour
// event_date). Doit être déclaré avant la route paramétrée /api/month/:year/:month.
app.get('/api/month/current', async (req, res) => {
  const now = new Date();
  try {
    res.json(await getMonthPayload(now.getFullYear(), now.getMonth() + 1, req.user.id));
  } catch (err) {
    console.error('Erreur lors de la lecture du mois en cours :', err);
    res.status(500).json({ error: 'Erreur lors de la lecture des données du mois.' });
  }
});

app.get('/api/month/:year/:month', async (req, res) => {
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Année/mois invalides.' });
  }
  try {
    res.json(await getMonthPayload(year, month, req.user.id));
  } catch (err) {
    console.error('Erreur lors de la lecture du mois :', err);
    res.status(500).json({ error: 'Erreur lors de la lecture des données du mois.' });
  }
});

// Champs éditables manuellement (Partie 1) et/ou renseignés automatiquement par le workflow
// de questions post-photo (Partie 3) — même route pour les deux, day_overrides est la seule
// destination d'écriture des deux cas.
const CHAMPS_OVERRIDE = {
  km_depart: 'float',
  km_arrivee: 'float',
  jauge_depart: 'int',
  jauge_arrivee: 'int',
  conducteur: 'text',
  petit_dejeuner: 'bool',
  repas_midi: 'bool',
  repas_soir: 'bool',
  decouche_inter: 'bool',
  decouche_natio: 'bool',
};

function coerceValeurOverride(type, valeur) {
  if (valeur === null) return null;
  if (type === 'float' || type === 'int') {
    const n = Number(valeur);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'bool') return Boolean(valeur);
  return String(valeur);
}

app.patch('/api/days/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date invalide (format attendu : YYYY-MM-DD).' });
  }

  const champsRecus = Object.keys(req.body || {}).filter((k) => k in CHAMPS_OVERRIDE);
  if (champsRecus.length === 0) {
    return res.status(400).json({ error: 'Aucun champ éditable reconnu dans la requête.' });
  }

  const valeurs = champsRecus.map((champ) => coerceValeurOverride(CHAMPS_OVERRIDE[champ], req.body[champ]));
  const placeholders = champsRecus.map((_, i) => `$${i + 3}`);
  const insertCols = ['event_date', 'user_id', ...champsRecus].join(', ');
  const insertVals = ['$1', '$2', ...placeholders].join(', ');
  const updateSet = [...champsRecus.map((c) => `${c} = EXCLUDED.${c}`), 'updated_at = now()'].join(', ');

  try {
    await pool.query(
      `INSERT INTO day_overrides (${insertCols}) VALUES (${insertVals})
       ON CONFLICT (user_id, event_date) DO UPDATE SET ${updateSet}`,
      [date, req.user.id, ...valeurs],
    );

    const [year, month] = date.split('-').map(Number);
    const [{ fileName }, monthPayload] = await Promise.all([
      regenerateMonthPdf({
        pool, storageDir: PDF_STORAGE_DIR, year, month,
        driverName: displayName(req.user.username), truckPlate: TRUCK_PLATE,
        userId: req.user.id, username: req.user.username,
      }),
      getMonthPayload(year, month, req.user.id),
    ]);
    const day = monthPayload.days.find((d) => d.date === date);

    res.json({ day, pdfUrl: `/files/${fileName}` });
  } catch (err) {
    console.error("Erreur lors de l'enregistrement de la correction manuelle :", err);
    res.status(500).json({ error: 'Erreur lors de l\'enregistrement. Réessaie.' });
  }
});

// Correction manuelle de l'heure lue par l'IA sur un event précis (Début/Fin affichés dans la
// feuille activité) : contrairement aux champs de day_overrides, ceci modifie directement
// l'event source (pas un champ dérivé), donc écrit dans events plutôt que day_overrides.
app.patch('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Identifiant d'event invalide." });
  }
  const { heure } = req.body || {};
  if (typeof heure !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) {
    return res.status(400).json({ error: 'Heure invalide (format attendu : HH:MM).' });
  }

  try {
    // AND user_id = $3 : empêche un compte de corriger l'event d'un autre en devinant un id
    // (pas seulement une histoire de "trouver" — un id existant appartenant à un autre compte
    // doit être traité exactement comme un id inexistant, d'où le même 404 dans les deux cas).
    const { rows } = await pool.query(
      `UPDATE events SET heure = $1 WHERE id = $2 AND user_id = $3 RETURNING id, event_date, type, heure`,
      [heure, id, req.user.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event introuvable.' });
    }
    const event = rows[0];

    const [year, month] = event.event_date.split('-').map(Number);
    const { fileName } = await regenerateMonthPdf({
      pool, storageDir: PDF_STORAGE_DIR, year, month,
      driverName: displayName(req.user.username), truckPlate: TRUCK_PLATE,
      userId: req.user.id, username: req.user.username,
    });

    res.json({ event, pdfUrl: `/files/${fileName}` });
  } catch (err) {
    console.error("Erreur lors de la correction de l'heure d'un event :", err);
    res.status(500).json({ error: "Erreur lors de l'enregistrement. Réessaie." });
  }
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend feuille véhicule démarré sur le port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Impossible d'initialiser la base de données :", err);
    process.exit(1);
  });
