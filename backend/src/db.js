const { Pool, types } = require('pg');

// On garde les colonnes DATE en chaîne 'YYYY-MM-DD' brute : le parsing par défaut de pg
// les convertit en Date locale minuit, ce qui décale la date affichée selon le fuseau du serveur.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

// Pas d'ORM : un seul CREATE TABLE IF NOT EXISTS suffit pour ce MVP.
// Un "jour" est clos dès qu'il a un event 'debut' ET un event 'fin' (voir pdf.js).
// km en DOUBLE PRECISION : le compteur du camion affiche une décimale (ex. 502225.6 km).
// jauge en pourcentage 0-100 (estimé depuis la barre segmentée de la photo) ; null si l'écran
// photographié n'affiche pas de jauge (cf. docs/photos-et-sorties.md, type B) ou si illisible.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      event_date DATE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('debut', 'fin')),
      km DOUBLE PRECISION,
      heure TEXT,
      jauge INTEGER CHECK (jauge IS NULL OR (jauge >= 0 AND jauge <= 100)),
      conducteur TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date);
  `);
}

module.exports = { pool, initSchema };
