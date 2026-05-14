/**
 * Base de données PostgreSQL (Supabase) — pool de connexions partagé
 *
 * Compatible serverless (Vercel) : le pool est créé une seule fois par
 * instance de fonction et réutilisé entre les invocations à chaud.
 *
 * L'API expose un wrapper `db.prepare(sql)` qui renvoie des méthodes
 * asynchrones (`run`, `get`, `all`) afin de limiter les changements dans
 * le code appelant. Les placeholders SQLite `?` sont traduits en `$1, $2…`.
 */
const { Pool, types } = require('pg');
const config = require('./config');

// PostgreSQL renvoie les BIGINT (OID 20) sous forme de chaînes par défaut.
// Les valeurs manipulées ici (compteurs, ids) restent bien en-deçà de 2^53,
// on les parse donc en nombres pour rester compatible avec le code existant.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

let pool = null;

/**
 * Initialise (ou récupère) le pool de connexions PostgreSQL
 */
function getPool() {
  if (pool) return pool;

  if (!config.database.url) {
    throw new Error('DATABASE_URL non défini — connexion PostgreSQL impossible');
  }

  pool = new Pool({
    connectionString: config.database.url,
    ssl: { rejectUnauthorized: false },
    max: config.database.poolMax,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Erreur pool PostgreSQL:', err.message);
  });

  return pool;
}

/**
 * Traduit les placeholders `?` (style SQLite) en `$1, $2…` (style PostgreSQL)
 */
function translatePlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Exécute une requête paramétrée
 */
async function query(sql, params = []) {
  const text = translatePlaceholders(sql);
  return getPool().query(text, params);
}

/**
 * Wrapper compatible avec l'ancien code (`db.prepare(sql).get(...)`).
 * Les méthodes sont asynchrones — les appelants doivent utiliser `await`.
 */
function prepare(sql) {
  return {
    async run(...params) {
      const res = await query(sql, params);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined,
      };
    },

    async get(...params) {
      const res = await query(sql, params);
      return res.rows[0];
    },

    async all(...params) {
      const res = await query(sql, params);
      return res.rows;
    },
  };
}

/**
 * Exécute du SQL brut (DDL, etc.)
 */
async function exec(sql) {
  await getPool().query(sql);
}

/**
 * Vérifie la connexion à la base de données
 */
async function initDatabase() {
  const res = await getPool().query('SELECT 1 AS ok');
  if (!res.rows[0] || res.rows[0].ok !== 1) {
    throw new Error('Échec de la vérification de connexion PostgreSQL');
  }
  console.log('✅ Base de données PostgreSQL connectée (Supabase)');
  return getPool();
}

/**
 * Ferme le pool (arrêt propre, usage local uniquement)
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { db: { prepare, exec, query }, initDatabase, closeDatabase };
