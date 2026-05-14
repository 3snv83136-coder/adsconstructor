/**
 * Routes CRON - déclenchées par Vercel Cron Jobs
 *
 * En environnement serverless, les `setInterval` ne s'exécutent pas de façon
 * fiable entre les invocations. Ces endpoints permettent à Vercel Cron de
 * déclencher périodiquement les tâches de fond :
 *   - /api/cron/roi            → cycle d'optimisation ROI
 *   - /api/cron/calendar       → tick du calendrier de diffusion
 *   - /api/cron/fraud-cleanup  → purge des IPs bloquées expirées
 *
 * Sécurité : si la variable d'environnement CRON_SECRET est définie, les
 * requêtes doivent porter l'en-tête `Authorization: Bearer <CRON_SECRET>`.
 * Vercel Cron envoie automatiquement cet en-tête lorsque CRON_SECRET est
 * configuré dans le projet.
 */
const express = require('express');
const router = express.Router();
const roiOptimizer = require('../services/roiOptimizer');
const calendarScheduler = require('../services/calendarScheduler');
const fraudDetector = require('../services/fraudDetector');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Vérifie le secret CRON si configuré
router.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next();

  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${secret}`) return next();

  return res.status(401).json({ error: 'Non autorisé' });
});

// GET /api/cron/roi - Cycle d'optimisation ROI
router.get('/roi', wrap(async (req, res) => {
  const result = await roiOptimizer._runOptimizationCycle();
  res.json({ task: 'roi', ...result });
}));

// GET /api/cron/calendar - Tick du calendrier de diffusion
router.get('/calendar', wrap(async (req, res) => {
  const result = await calendarScheduler._minuteTick();
  res.json({ task: 'calendar', ...result });
}));

// GET /api/cron/fraud-cleanup - Purge des IPs bloquées expirées
router.get('/fraud-cleanup', wrap(async (req, res) => {
  await fraudDetector._cleanup();
  res.json({ task: 'fraud-cleanup', success: true });
}));

// GET /api/cron/all - Exécute toutes les tâches de fond en une invocation
// (utile pour ne consommer qu'un seul Cron Job — compatible plan Hobby)
router.get('/all', wrap(async (req, res) => {
  const results = {};
  for (const [task, fn] of [
    ['calendar', () => calendarScheduler._minuteTick()],
    ['roi', () => roiOptimizer._runOptimizationCycle()],
    ['fraud-cleanup', () => fraudDetector._cleanup()],
  ]) {
    try {
      results[task] = { ok: true, result: (await fn()) || null };
    } catch (err) {
      results[task] = { ok: false, error: err.message };
    }
  }
  res.json({ task: 'all', results, timestamp: new Date().toISOString() });
}));

module.exports = router;
