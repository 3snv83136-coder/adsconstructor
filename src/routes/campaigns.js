/**
 * Routes API REST - Campagnes
 */
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const adsApi = require('../services/adsApiClient');
const roiOptimizer = require('../services/roiOptimizer');
const realtimeMonitor = require('../services/realtimeMonitor');

// Wrapper pour propager les erreurs async vers le middleware d'erreur
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/campaigns - Liste toutes les campagnes
router.get('/', wrap(async (req, res) => {
  const campaigns = await db.prepare("SELECT * FROM campaigns WHERE status != 'removed' ORDER BY created_at DESC").all();
  res.json(campaigns);
}));

// GET /api/campaigns/:id - Détail d'une campagne
router.get('/:id', wrap(async (req, res) => {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

  const adGroups = await db.prepare('SELECT * FROM ad_groups WHERE campaign_id = ?').all(campaign.id);

  res.json({ ...campaign, adGroups });
}));

// POST /api/campaigns - Crée une campagne
router.post('/', wrap(async (req, res) => {
  const { name, dailyBudget, maxCpc, bidStrategy, targetCpa } = req.body;

  if (!name || !dailyBudget) {
    return res.status(400).json({ error: 'Nom et budget quotidien requis' });
  }

  const result = await db.prepare(`
    INSERT INTO campaigns (name, daily_budget, max_cpc, bid_strategy, target_cpa)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).run(name, dailyBudget, maxCpc || 1.0, bidStrategy || 'manual_cpc', targetCpa || null);

  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json(campaign);
}));

// PUT /api/campaigns/:id - Met à jour une campagne
router.put('/:id', wrap(async (req, res) => {
  const { name, dailyBudget, maxCpc, status } = req.body;
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

  const oldStatus = campaign.status;

  await db.prepare(`
    UPDATE campaigns SET
      name = COALESCE(?, name),
      daily_budget = COALESCE(?, daily_budget),
      max_cpc = COALESCE(?, max_cpc),
      status = COALESCE(?, status),
      updated_at = now()
    WHERE id = ?
  `).run(name || null, dailyBudget || null, maxCpc || null, status || null, req.params.id);

  if (status && status !== oldStatus) {
    realtimeMonitor.broadcastCampaignStatus(parseInt(req.params.id), oldStatus, status);
  }

  const updated = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  res.json(updated);
}));

// DELETE /api/campaigns/:id - Supprime une campagne (soft delete)
router.delete('/:id', wrap(async (req, res) => {
  await db.prepare("UPDATE campaigns SET status = 'removed', updated_at = now() WHERE id = ?").run(req.params.id);
  res.json({ success: true });
}));

// POST /api/campaigns/:id/pause - Met en pause
router.post('/:id/pause', wrap(async (req, res) => {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

  await adsApi.setCampaignStatus(campaign.id, 'paused');
  await db.prepare("UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = ?").run(campaign.id);

  realtimeMonitor.broadcastCampaignStatus(campaign.id, 'active', 'paused');
  res.json({ success: true, status: 'paused' });
}));

// POST /api/campaigns/:id/resume - Réactive
router.post('/:id/resume', wrap(async (req, res) => {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

  await adsApi.setCampaignStatus(campaign.id, 'active');
  await db.prepare("UPDATE campaigns SET status = 'active', updated_at = now() WHERE id = ?").run(campaign.id);

  realtimeMonitor.broadcastCampaignStatus(campaign.id, 'paused', 'active');
  res.json({ success: true, status: 'active' });
}));

// GET /api/campaigns/:id/metrics - Métriques temps réel
router.get('/:id/metrics', wrap(async (req, res) => {
  const metrics = await adsApi.getCampaignMetrics(parseInt(req.params.id));
  if (!metrics) return res.status(404).json({ error: 'Métriques non disponibles' });
  res.json(metrics);
}));

// GET /api/campaigns/:id/roi-analysis - Analyse ROI complète
router.get('/:id/roi-analysis', wrap(async (req, res) => {
  const analysis = await roiOptimizer.analyzeRoi(parseInt(req.params.id));
  if (!analysis) return res.status(404).json({ error: 'Campagne non trouvée' });
  res.json(analysis);
}));

// GET /api/campaigns/:id/adjustments - Historique des ajustements
router.get('/:id/adjustments', wrap(async (req, res) => {
  const adjustments = await db.prepare(
    'SELECT * FROM roi_adjustments WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.id);
  res.json(adjustments);
}));

module.exports = router;
