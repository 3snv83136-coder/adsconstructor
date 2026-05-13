/**
 * Routes API REST - ROI
 */
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const roiOptimizer = require('../services/roiOptimizer');

// GET /api/roi/status - État global du ROI
router.get('/status', (req, res) => {
  const campaigns = db.prepare("SELECT * FROM campaigns WHERE status != 'removed'").all();

  const summary = campaigns.map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    spend: c.current_spend,
    conversions: c.conversions,
    roi: c.roi,
    cpa: c.conversions > 0 ? c.current_spend / c.conversions : null,
    targetCpa: c.target_cpa,
    recommendation: roiOptimizer._generateRecommendation(
      c,
      c.conversions > 0 ? c.current_spend / c.conversions : null,
      { direction: 'stable' }
    ),
  }));

  res.json(summary);
});

// GET /api/roi/adjustments - Historique des ajustements
router.get('/adjustments', (req, res) => {
  const adjustments = roiOptimizer.getAdjustmentsHistory(50);
  res.json(adjustments);
});

// POST /api/roi/optimize-now - Lance un cycle d'optimisation immédiat
router.post('/optimize-now', async (req, res) => {
  const result = await roiOptimizer._runOptimizationCycle();
  res.json(result);
});

// GET /api/roi/settings - Configuration ROI
router.get('/settings', (req, res) => {
  const config = require('../config');
  res.json({
    targetCpa: config.roi.targetCpa,
    minCostThreshold: config.roi.minCostThreshold,
    maxBidAdjustmentPct: config.roi.maxBidAdjustmentPct,
    minBidAdjustmentPct: config.roi.minBidAdjustmentPct,
    checkIntervalMinutes: config.roi.checkIntervalMinutes,
    conversionWindowDays: config.roi.conversionWindowDays,
  });
});

module.exports = router;
