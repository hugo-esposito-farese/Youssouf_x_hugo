const { Pool, types } = require('pg');
const { hashPassword } = require('./auth');

// On garde les colonnes DATE en chaîne 'YYYY-MM-DD' brute : le parsing par défaut de pg
// les convertit en Date locale minuit, ce qui décale la date affichée selon le fuseau du serveur.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

// Nom du compte auquel attribuer les données créées avant l'introduction du multi-compte (voir
// migrateUserId ci-dessous) : c'était le seul compte existant à ce moment-là.
const LEGACY_DATA_OWNER = 'hugo';

// Ajoute une contrainte (constraint/PK) de façon idempotente : Postgres n'a pas de
// "ADD CONSTRAINT IF NOT EXISTS", donc on avale l'erreur "already exists" (42710/42P16) plutôt
// que d'ajouter un outil de migration complet pour ce MVP.
async function addConstraintIfMissing(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    // 42710 duplicate_object (contrainte), 42P16 invalid_table_definition (PK déjà présente),
    // 42P07 duplicate_table (l'index sous-jacent d'un UNIQUE existe déjà).
    if (!['42710', '42P16', '42P07'].includes(err.code)) throw err;
  }
}

// Pas d'ORM : un seul CREATE TABLE IF NOT EXISTS suffit pour ce MVP.
// Un "jour" est clos dès qu'il a un event 'debut' ET un event 'fin' (voir pdf.js).
// km en DOUBLE PRECISION : le compteur du camion affiche une décimale (ex. 502225.6 km).
// jauge en pourcentage 0-100 (estimé depuis la barre segmentée de la photo) ; null si l'écran
// photographié n'affiche pas de jauge (cf. docs/photos-et-sorties.md, type B) ou si illisible.
async function initSchema() {
  // La table users doit exister (et être seedée) avant les migrations user_id ci-dessous, qui
  // ont besoin d'un compte existant pour attribuer les données créées avant le multi-compte.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await seedUserFromEnv();

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

  // Corrections manuelles / réponses du workflow post-photo (repas, découché), par jour.
  // Une valeur non-NULL ici prime sur la donnée dérivée des events pour l'affichage/le PDF
  // (voir pdf.js) : la donnée IA reste la base, ceci n'est qu'une surcouche optionnelle.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_overrides (
      event_date DATE PRIMARY KEY,
      km_depart DOUBLE PRECISION,
      km_arrivee DOUBLE PRECISION,
      jauge_depart INTEGER CHECK (jauge_depart IS NULL OR (jauge_depart >= 0 AND jauge_depart <= 100)),
      jauge_arrivee INTEGER CHECK (jauge_arrivee IS NULL OR (jauge_arrivee >= 0 AND jauge_arrivee <= 100)),
      conducteur TEXT,
      petit_dejeuner BOOLEAN NOT NULL DEFAULT false,
      repas_midi BOOLEAN NOT NULL DEFAULT false,
      repas_soir BOOLEAN NOT NULL DEFAULT false,
      decouche_inter BOOLEAN NOT NULL DEFAULT false,
      decouche_natio BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await migrateToPerUserData();
}

// Pas d'endpoint d'inscription (ce serait un trou de sécurité : n'importe qui pourrait créer un
// compte et modifier la feuille). Le seul moyen de créer/mettre à jour un compte est via ces
// variables d'env au démarrage — cf. README pour la procédure de rotation du mot de passe.
async function seedUserFromEnv() {
  const username = process.env.SEED_USERNAME;
  const password = process.env.SEED_PASSWORD;
  if (!username || !password) return;

  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (rows.length > 0) return; // déjà créé : ne jamais écraser silencieusement un mot de passe existant

  await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
    [username, hashPassword(password)],
  );
  console.log(`Utilisateur "${username}" créé depuis SEED_USERNAME/SEED_PASSWORD.`);
}

// Migration : passage d'une feuille unique partagée à une feuille par compte. `events` et
// `day_overrides` existaient déjà en prod sans notion de compte ; on ajoute user_id, on
// attribue les lignes existantes à LEGACY_DATA_OWNER (seul compte qui existait avant cette
// migration), puis on verrouille la colonne. Idempotent : sans effet une fois déjà migré.
async function migrateToPerUserData() {
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);`);
  await pool.query(`ALTER TABLE day_overrides ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);`);

  const { rows: legacyOwner } = await pool.query('SELECT id FROM users WHERE username = $1', [LEGACY_DATA_OWNER]);
  if (legacyOwner.length > 0) {
    const ownerId = legacyOwner[0].id;
    await pool.query('UPDATE events SET user_id = $1 WHERE user_id IS NULL', [ownerId]);
    await pool.query('UPDATE day_overrides SET user_id = $1 WHERE user_id IS NULL', [ownerId]);
  }

  const { rows: orphanEvents } = await pool.query('SELECT count(*)::int AS n FROM events WHERE user_id IS NULL');
  if (orphanEvents[0].n === 0) {
    await pool.query('ALTER TABLE events ALTER COLUMN user_id SET NOT NULL');
  }
  const { rows: orphanOverrides } = await pool.query('SELECT count(*)::int AS n FROM day_overrides WHERE user_id IS NULL');
  if (orphanOverrides[0].n === 0) {
    await pool.query('ALTER TABLE day_overrides ALTER COLUMN user_id SET NOT NULL');
  }

  // day_overrides était clé par event_date seul (un seul compte à l'origine) ; il faut une clé
  // par (compte, date) pour que chaque utilisateur ait ses propres corrections sur une même date.
  await pool.query('ALTER TABLE day_overrides DROP CONSTRAINT IF EXISTS day_overrides_pkey');
  await pool.query('ALTER TABLE day_overrides ADD COLUMN IF NOT EXISTS id SERIAL');
  await addConstraintIfMissing('ALTER TABLE day_overrides ADD CONSTRAINT day_overrides_pkey PRIMARY KEY (id)');
  await addConstraintIfMissing(
    'ALTER TABLE day_overrides ADD CONSTRAINT day_overrides_user_date_unique UNIQUE (user_id, event_date)',
  );

  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_user_date ON events (user_id, event_date)');
}

module.exports = { pool, initSchema };
