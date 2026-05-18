/**
 * Base de données SQLite - Initialisation et accès
 * Utilise sql.js (pur JavaScript/WebAssembly) — compatible tous environnements
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');

let db = null;
let SQL = null;
let initialized = false;

// Crée le dossier data si inexistant
const dbDir = path.dirname(path.resolve(config.database.path));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.resolve(config.database.path);

/**
 * Initialise la base de données (asynchrone — sql.js charge le WASM)
 */
async function initDatabase() {
  const initSqlJs = require('sql.js');

  // Sur Vercel (et tout environnement où le wasm n'est pas trouvé via le chemin
  // par défaut), on pointe explicitement sur le binaire situé dans node_modules
  SQL = await initSqlJs({
    locateFile: (file) => {
      try {
        return require.resolve(`sql.js/dist/${file}`);
      } catch (e) {
        return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
      }
    },
  });

  // Charge une base existante ou en crée une nouvelle
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Active les foreign keys
  db.run('PRAGMA foreign_keys = ON');

  initialized = true;

  // Crée les tables
  createTables();

  // Active la sauvegarde automatique
  setupAutoSave();

  console.log('✅ Base de données initialisée (sql.js)');
  return db;
}

/**
 * Sauvegarde automatique périodique sur disque
 */
function setupAutoSave() {
  setInterval(() => {
    if (db && initialized) {
      try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
      } catch (err) {
        console.error('Erreur sauvegarde DB:', err.message);
      }
    }
  }, 30000); // Toutes les 30 secondes
}

/**
 * Sauvegarde manuelle
 */
function saveDatabase() {
  if (!db || !initialized) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/**
 * Wrapper autour de sql.js pour exposer une API compatible better-sqlite3
 */
function prepare(sql) {
  if (!db || !initialized) throw new Error('Base de données non initialisée');

  const stmt = db.prepare(sql);

  // sql.js refuse undefined → conversion en null pour compat better-sqlite3
  const safe = (params) => params.map(p => (p === undefined ? null : p));

  return {
    run(...params) {
      stmt.bind(safe(params));
      stmt.step();
      stmt.free();
      const changes = db.getRowsModified();
      let lastInsertRowid;
      try {
        const r = db.exec('SELECT last_insert_rowid() AS id');
        lastInsertRowid = r[0]?.values?.[0]?.[0];
      } catch (e) { /* ignore */ }
      return { changes, lastInsertRowid };
    },

    get(...params) {
      stmt.bind(safe(params));
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },

    all(...params) {
      stmt.bind(safe(params));
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    },
  };
}

/**
 * Exécute du SQL brut (CREATE TABLE, etc.)
 */
function exec(sql) {
  if (!db || !initialized) throw new Error('Base de données non initialisée');
  db.run(sql);
}

/**
 * Crée les tables
 */
function createTables() {
  exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_campaign_id TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'paused',
      daily_budget REAL NOT NULL DEFAULT 0,
      current_spend REAL DEFAULT 0,
      bid_strategy TEXT DEFAULT 'manual_cpc',
      target_cpa REAL,
      max_cpc REAL DEFAULT 1.0,
      current_cpc REAL,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      conversions REAL DEFAULT 0,
      conversion_value REAL DEFAULT 0,
      ctr REAL DEFAULT 0,
      roi REAL DEFAULT 0,
      last_sync_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ad_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      google_ad_group_id TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'enabled',
      max_cpc REAL DEFAULT 1.0,
      current_cpc REAL,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      conversions REAL DEFAULT 0,
      ctr REAL DEFAULT 0,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS click_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      ad_group_id INTEGER,
      ip_address TEXT NOT NULL,
      user_agent TEXT,
      referrer TEXT,
      country TEXT,
      city TEXT,
      is_fraudulent INTEGER DEFAULT 0,
      fraud_score REAL DEFAULT 0,
      fraud_reasons TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (ad_group_id) REFERENCES ad_groups(id)
    );

    CREATE INDEX IF NOT EXISTS idx_click_ip ON click_events(ip_address, created_at);
    CREATE INDEX IF NOT EXISTS idx_click_campaign ON click_events(campaign_id, created_at);

    CREATE TABLE IF NOT EXISTS fraud_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      action TEXT DEFAULT 'block',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL UNIQUE,
      reason TEXT,
      blocked_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_hour INTEGER NOT NULL,
      start_minute INTEGER DEFAULT 0,
      end_hour INTEGER NOT NULL,
      end_minute INTEGER DEFAULT 0,
      bid_adjustment REAL DEFAULT 1.0,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      bid_multiplier REAL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS roi_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      adjustment_type TEXT NOT NULL,
      old_value REAL,
      new_value REAL,
      reason TEXT,
      performance_snapshot TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      spend REAL DEFAULT 0,
      conversions REAL DEFAULT 0,
      avg_cpc REAL,
      ctr REAL,
      roi REAL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_campaign_time ON metrics_snapshot(campaign_id, timestamp);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      severity TEXT DEFAULT 'info',
      campaign_id INTEGER,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { db: { prepare, exec }, initDatabase, saveDatabase };
