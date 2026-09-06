require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { pool, initSchema } = require('./db');
const { extraireDonneesCompteur } = require('./claudeVision');
const { regenerateMonthPdf, pdfFileName } = require('./pdf');

const PORT = process.env.PORT || 3000;
const DRIVER_NAME = process.env.DRIVER_NAME || 'Chauffeur';
const TRUCK_PLATE = process.env.TRUCK_PLATE || 'GC-506-VT';
const PDF_STORAGE_DIR = path.resolve(process.env.PDF_STORAGE_DIR || './data/pdfs');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
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
