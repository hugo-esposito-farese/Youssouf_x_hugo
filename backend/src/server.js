require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { pool, initSchema } = require('./db');
const { extraireDonneesCompteur } = require('./claudeVision');
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
const DRIVER_NAME = process.env.DRIVER_NAME || 'Chauffeur';
const TRUCK_PLATE = process.env.TRUCK_PLATE || 'GC-506-VT';
const PDF_STORAGE_DIR = path.resolve(process.env.PDF_STORAGE_DIR || './data/pdfs');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use('/files', express.static(PDF_STORAGE_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo, large marge pour une photo de compteur
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
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
      `INSERT INTO events (event_date, type, km, heure, jauge, conducteur)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_date, type, km, heure, jauge, conducteur, created_at`,
      [eventDate, type, donnees.km, donnees.heure, donnees.jauge, DRIVER_NAME],
    );
    const event = insertResult.rows[0];

    // Un jour est clos dès qu'il a un event 'debut' ET un event 'fin' (cf. CLAUDE.md) : ça ne
    // conditionne que le remplissage des cases km/jauge de la feuille véhicule pour ce jour-là
    // (voir pdf.js). Le PDF (les 2 feuilles) est régénéré à chaque event, car la feuille
    // activité doit refléter tout event, même sur un jour pas encore clos.
    const { rows: typesDuJour } = await pool.query(
      `SELECT DISTINCT type FROM events WHERE event_date = $1`,
      [eventDate],
    );
    const types = typesDuJour.map((r) => r.type);
    const jourClos = types.includes('debut') && types.includes('fin');

    const [year, month] = eventDate.split('-').map(Number);
    const { fileName } = await regenerateMonthPdf({
      pool,
      storageDir: PDF_STORAGE_DIR,
      year,
      month,
      driverName: DRIVER_NAME,
      truckPlate: TRUCK_PLATE,
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
  const fileName = pdfFileName(now.getFullYear(), now.getMonth() + 1);
  res.json({ pdfUrl: `/files/${fileName}` });
});

// Donnée fusionnée (IA + corrections manuelles) d'un mois, pour l'écran "feuille éditable".
// Réutilise exactement les mêmes requêtes/fonctions de fusion que la génération du PDF (pdf.js)
// pour garantir que l'écran et le PDF ne divergent jamais.
async function getMonthPayload(year, month) {
  const dates = buildDateList(year, month);
  const [donneesParJour, evenementsParJour, overridesParJour] = await Promise.all([
    getDonneesVehiculeParJour(pool, year, month),
    getEvenementsActiviteParJour(pool, year, month),
    getOverridesParJour(pool, year, month),
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
    res.json(await getMonthPayload(now.getFullYear(), now.getMonth() + 1));
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
    res.json(await getMonthPayload(year, month));
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
  const placeholders = champsRecus.map((_, i) => `$${i + 2}`);
  const insertCols = ['event_date', ...champsRecus].join(', ');
  const insertVals = ['$1', ...placeholders].join(', ');
  const updateSet = [...champsRecus.map((c) => `${c} = EXCLUDED.${c}`), 'updated_at = now()'].join(', ');

  try {
    await pool.query(
      `INSERT INTO day_overrides (${insertCols}) VALUES (${insertVals})
       ON CONFLICT (event_date) DO UPDATE SET ${updateSet}`,
      [date, ...valeurs],
    );

    const [year, month] = date.split('-').map(Number);
    const [{ fileName }, monthPayload] = await Promise.all([
      regenerateMonthPdf({ pool, storageDir: PDF_STORAGE_DIR, year, month, driverName: DRIVER_NAME, truckPlate: TRUCK_PLATE }),
      getMonthPayload(year, month),
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
    const { rows } = await pool.query(
      `UPDATE events SET heure = $1 WHERE id = $2 RETURNING id, event_date, type, heure`,
      [heure, id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event introuvable.' });
    }
    const event = rows[0];

    const [year, month] = event.event_date.split('-').map(Number);
    const { fileName } = await regenerateMonthPdf({
      pool, storageDir: PDF_STORAGE_DIR, year, month, driverName: DRIVER_NAME, truckPlate: TRUCK_PLATE,
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
