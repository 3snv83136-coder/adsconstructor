/**
 * Routes API REST - Fraude
 */
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const fraudDetector = require('../services/fraudDetector');
const realtimeMonitor = require('../services/realtimeMonitor');

// POST /api/fraud/analyze - Analyse un clic pour fraude
router.post('/analyze', async (req, res) => {
  const { ip_address, user_agent, referrer, campaign_id, ad_group_id, country, city } = req.body;

  if (!ip_address) {
    return res.status(400).json({ error: 'ip_address requis' });
  }

  const result = await fraudDetector.analyzeClick({
    ip_address,
    user_agent,
    referrer,
    campaign_id,
    ad_group_id,
    country,
    city,
  });

  // Diffuse l'alerte si frauduleux
  if (result.isFraudulent) {
    realtimeMonitor.broadcastFraudAlert({
      ip_address,
      score: result.score,
      reasons: result.reasons,
      campaign_id,
      timestamp: result.timestamp,
    });
  }

  res.json(result);
});

// GET /api/fraud/stats - Statistiques du détecteur
router.get('/stats', async (req, res) => {
  const stats = await fraudDetector.getStats();
  res.json(stats);
});

// GET /api/fraud/blocked-ips - IPs bloquées
router.get('/blocked-ips', async (req, res) => {
  const blockedIps = await fraudDetector.getBlockedIps();
  res.json(blockedIps);
});

// POST /api/fraud/block-ip - Bloquer une IP manuellement
router.post('/block-ip', async (req, res) => {
  const { ip_address, reason, duration_minutes } = req.body;

  if (!ip_address) {
    return res.status(400).json({ error: 'ip_address requis' });
  }

  const expiresAt = new Date(Date.now() + (duration_minutes || 60) * 60000).toISOString();

  await db.prepare(`
    INSERT INTO blocked_ips (ip_address, reason, blocked_at, expires_at, is_active)
    VALUES (?, ?, datetime('now'), ?, 1)
    ON CONFLICT (ip_address) DO UPDATE SET
      reason = EXCLUDED.reason,
      blocked_at = EXCLUDED.blocked_at,
      expires_at = EXCLUDED.expires_at,
      is_active = EXCLUDED.is_active
  `).run(ip_address, reason || 'Blocage manuel', expiresAt);

  fraudDetector.blockedCache.add(ip_address);

  await db.prepare(
    "INSERT INTO audit_logs (event_type, severity, message) VALUES ('ip_blocked_manual', 'warning', ?)"
  ).run(`IP bloquée manuellement: ${ip_address}`);

  res.json({ success: true, ip_address, expiresAt });
});

// POST /api/fraud/unblock/:ip - Débloquer une IP
router.post('/unblock/:ip', async (req, res) => {
  const result = await fraudDetector.unblockIp(req.params.ip);
  res.json(result);
});

// GET /api/fraud/rules - Règles de fraude
router.get('/rules', async (req, res) => {
  const rules = await db.prepare('SELECT * FROM fraud_rules ORDER BY created_at DESC').all();
  res.json(rules);
});

// POST /api/fraud/rules - Ajouter une règle
router.post('/rules', async (req, res) => {
  const { name, type, pattern, action } = req.body;

  if (!name || !type || !pattern) {
    return res.status(400).json({ error: 'name, type et pattern requis' });
  }

  const result = await db.prepare(
    'INSERT INTO fraud_rules (name, type, pattern, action) VALUES (?, ?, ?, ?)'
  ).run(name, type, pattern, action || 'block');

  res.status(201).json({ id: result.lastInsertRowid, name, type, pattern, action });
});

// DELETE /api/fraud/rules/:id - Supprimer une règle
router.delete('/rules/:id', async (req, res) => {
  await db.prepare('DELETE FROM fraud_rules WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/fraud/recent - Clics frauduleux récents
router.get('/recent', async (req, res) => {
  const recent = await db.prepare(`
    SELECT * FROM click_events
    WHERE is_fraudulent = 1
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  res.json(recent);
});

module.exports = router;
