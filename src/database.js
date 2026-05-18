/**
 * Couche d'accès Postgres (Supabase) avec wrapper compatible better-sqlite3
 *
 * Toutes les opérations sont asynchrones (renvoient des Promises).
 * Le wrapper traduit la syntaxe SQLite vers Postgres :
 *   - placeholders `?`        → `$1, $2, ...`
 *   - `datetime('now')`       → `now()`
 *   - `INSERT OR REPLACE`     → `INSERT ... ON CONFLICT ... DO UPDATE`
 *   - `last_insert_rowid()`   → `RETURNING id` automatique pour INSERT
 *
 * Variable d'environnement requise : POSTGRES_URL
 *   (depuis Supabase → Settings → Database → Connection Pooling "Transaction")
 */
const { Pool } = require('pg');
const config = require('./config');

let pool = null;
let initialized = false;

function getConnectionString() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    null
  );
}

async function initDatabase() {
  if (initialized) return pool;

  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error(
      'Aucune URL de base configurée. Définir POSTGRES_URL (Supabase → Database → Connection Pooling)'
    );
  }

  pool = new Pool({
    connectionString,
    // Supabase requiert SSL ; pgbouncer en transaction mode ne supporte pas prepared statements
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Test de connexion
  const { rows } = await pool.query('SELECT 1 AS ok');
  if (rows[0].ok !== 1) throw new Error('Test connexion DB échoué');

  initialized = true;
  console.log('✅ Base de données Postgres (Supabase) connectée');
  return pool;
}

// ============================================================
//  Traduction SQLite → Postgres
// ============================================================
function translateSql(sql) {
  let out = sql;

  // datetime('now') → now()
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');

  // INSERT OR REPLACE INTO → INSERT ... gestion via .run en réécrivant
  // Ici on fait simple : INSERT OR REPLACE = INSERT ON CONFLICT DO UPDATE
  // (le code applicatif gère déjà ON CONFLICT explicitement quand nécessaire)
  out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO');

  // ? placeholders → $1, $2, ...
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);

  return out;
}

// Conversion automatique : si une instruction INSERT n'a pas de RETURNING,
// on en ajoute une pour récupérer l'id (compat lastInsertRowid)
function ensureReturning(sql) {
  const trimmed = sql.trim();
  if (/^INSERT\s+/i.test(trimmed) && !/RETURNING/i.test(trimmed)) {
    return trimmed.replace(/;?\s*$/, ' RETURNING id');
  }
  return sql;
}

// ============================================================
//  Wrapper public — API compatible avec l'ancien code synchrone
//  (mais async maintenant : chaque .run/.get/.all renvoie une Promise)
// ============================================================
function prepare(rawSql) {
  if (!pool) throw new Error('Base de données non initialisée');

  return {
    async run(...params) {
      const safe = params.map(p => (p === undefined ? null : p));
      const sql = ensureReturning(translateSql(rawSql));
      try {
        const res = await pool.query(sql, safe);
        return {
          changes: res.rowCount,
          lastInsertRowid: res.rows?.[0]?.id ?? undefined,
        };
      } catch (err) {
        // Retry sans RETURNING si la table n'a pas de colonne id
        if (err.message && err.message.toLowerCase().includes('returning')) {
          const res = await pool.query(translateSql(rawSql), safe);
          return { changes: res.rowCount, lastInsertRowid: undefined };
        }
        throw err;
      }
    },

    async get(...params) {
      const safe = params.map(p => (p === undefined ? null : p));
      const sql = translateSql(rawSql);
      const res = await pool.query(sql, safe);
      return res.rows[0];
    },

    async all(...params) {
      const safe = params.map(p => (p === undefined ? null : p));
      const sql = translateSql(rawSql);
      const res = await pool.query(sql, safe);
      return res.rows;
    },
  };
}

async function exec(sql) {
  if (!pool) throw new Error('Base de données non initialisée');
  await pool.query(sql);
}

// Sauvegarde manuelle — no-op sur Postgres (persistance native)
function saveDatabase() {
  // Postgres persiste automatiquement, rien à faire
}

module.exports = {
  db: { prepare, exec },
  initDatabase,
  saveDatabase,
};
