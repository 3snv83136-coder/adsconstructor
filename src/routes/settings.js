/**
 * Routes API REST - Réglages / Connexion API
 *
 * Permet de stocker les credentials Google Ads depuis l'interface et
 * de réinitialiser le client API à la volée.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const adsApi = require('../services/adsApiClient');
const config = require('../config');

const ADS_KEYS = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
];

async function readSetting(key) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function writeSetting(key, value) {
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function mask(v) {
  if (!v) return null;
  if (v.length <= 6) return '••••';
  return v.slice(0, 3) + '•••' + v.slice(-3);
}

// GET /api/settings/api - retourne l'état (masqué) des credentials et le mode actif
router.get('/api', async (req, res) => {
  const stored = {};
  for (const k of ADS_KEYS) {
    stored[k] = await readSetting(k);
  }

  const merged = {
    clientId: stored.GOOGLE_ADS_CLIENT_ID || config.googleAds.clientId,
    clientSecret: stored.GOOGLE_ADS_CLIENT_SECRET || config.googleAds.clientSecret,
    developerToken: stored.GOOGLE_ADS_DEVELOPER_TOKEN || config.googleAds.developerToken,
    refreshToken: stored.GOOGLE_ADS_REFRESH_TOKEN || config.googleAds.refreshToken,
    customerId: stored.GOOGLE_ADS_CUSTOMER_ID || config.googleAds.customerId,
    loginCustomerId: stored.GOOGLE_ADS_LOGIN_CUSTOMER_ID || config.googleAds.loginCustomerId,
  };

  const configured = !!(merged.clientId && merged.clientSecret && merged.refreshToken);

  res.json({
    configured,
    simulated: !!adsApi.simulated,
    initialized: !!adsApi.initialized,
    masked: {
      clientId: mask(merged.clientId),
      clientSecret: mask(merged.clientSecret),
      developerToken: mask(merged.developerToken),
      refreshToken: mask(merged.refreshToken),
      customerId: merged.customerId || null,
      loginCustomerId: merged.loginCustomerId || null,
    },
  });
});

// POST /api/settings/api - sauvegarde les credentials puis réinitialise le client
router.post('/api', async (req, res) => {
  const body = req.body || {};
  const map = {
    clientId: 'GOOGLE_ADS_CLIENT_ID',
    clientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
    developerToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
    refreshToken: 'GOOGLE_ADS_REFRESH_TOKEN',
    customerId: 'GOOGLE_ADS_CUSTOMER_ID',
    loginCustomerId: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  };

  for (const [field, key] of Object.entries(map)) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      await writeSetting(key, String(body[field]));
      // applique aussi dans la config courante (process.env reste prioritaire en lecture initiale,
      // on met à jour l'objet config en mémoire pour les prochains appels)
      config.googleAds[field] = String(body[field]);
    }
  }

  await db.prepare(
    "INSERT INTO audit_logs (event_type, severity, message) VALUES ('api_credentials_updated', 'info', ?)"
  ).run('Credentials Google Ads mis à jour via dashboard');

  // Reset client puis réinitialise
  adsApi.simulated = false;
  adsApi.accessToken = null;
  adsApi.tokenExpiry = null;
  await adsApi.initialize();

  res.json({
    success: true,
    simulated: !!adsApi.simulated,
    initialized: !!adsApi.initialized,
  });
});

// DELETE /api/settings/api - efface les credentials stockés
router.delete('/api', async (req, res) => {
  for (const k of ADS_KEYS) {
    await db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
  }
  // Réinitialise la config en mémoire à partir de l'env (peut être vide)
  config.googleAds.clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  config.googleAds.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  config.googleAds.developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  config.googleAds.refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  config.googleAds.customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  config.googleAds.loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '';

  adsApi.simulated = false;
  adsApi.accessToken = null;
  adsApi.tokenExpiry = null;
  await adsApi.initialize();

  res.json({ success: true, simulated: !!adsApi.simulated });
});

// POST /api/settings/api/test - test une connexion sans persister
router.post('/api/test', async (req, res) => {
  const body = req.body || {};
  if (!body.clientId || !body.clientSecret || !body.refreshToken) {
    return res.status(400).json({ success: false, error: 'clientId, clientSecret, refreshToken requis' });
  }
  try {
    // Stash temporaire
    const backup = { ...config.googleAds };
    config.googleAds.clientId = body.clientId;
    config.googleAds.clientSecret = body.clientSecret;
    config.googleAds.refreshToken = body.refreshToken;
    adsApi.simulated = false;
    adsApi.accessToken = null;
    const ok = await adsApi.initialize();
    const wasSimulated = !!adsApi.simulated;
    // Restaure
    config.googleAds = backup;
    if (wasSimulated) {
      return res.json({ success: false, error: 'Échec authentification (fallback simulation)' });
    }
    res.json({ success: true, ok });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Charge les credentials depuis la DB au démarrage si présents
async function loadStoredCredentialsIntoConfig() {
  try {
    const map = {
      clientId: 'GOOGLE_ADS_CLIENT_ID',
      clientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
      developerToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
      refreshToken: 'GOOGLE_ADS_REFRESH_TOKEN',
      customerId: 'GOOGLE_ADS_CUSTOMER_ID',
      loginCustomerId: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    };
    for (const [field, key] of Object.entries(map)) {
      const v = await readSetting(key);
      if (v && !config.googleAds[field]) {
        config.googleAds[field] = v;
      }
    }
  } catch (e) {
    // table peut ne pas exister à tout premier démarrage
  }
}

module.exports = router;
module.exports.loadStoredCredentialsIntoConfig = loadStoredCredentialsIntoConfig;
