/**
 * Routes API REST - Calendrier de diffusion
 */
const express = require('express');
const router = express.Router();
const calendarScheduler = require('../services/calendarScheduler');

// Wrapper pour propager les erreurs async vers le middleware d'erreur
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/calendar/state - État actuel du calendrier
router.get('/state', wrap(async (req, res) => {
  const state = await calendarScheduler.getCurrentState();
  res.json(state);
}));

// GET /api/calendar/schedules - Tous les plannings
router.get('/schedules', wrap(async (req, res) => {
  const campaignId = req.query.campaign_id;
  let schedules;
  if (campaignId) {
    schedules = await calendarScheduler.getCampaignSchedules(parseInt(campaignId));
  } else {
    schedules = await calendarScheduler.getAllSchedules();
  }
  res.json(schedules);
}));

// POST /api/calendar/schedules - Ajouter une plage de diffusion
router.post('/schedules', wrap(async (req, res) => {
  const { campaign_id, day_of_week, start_hour, start_minute, end_hour, end_minute, bid_adjustment } = req.body;

  if (campaign_id === undefined || day_of_week === undefined || start_hour === undefined || end_hour === undefined) {
    return res.status(400).json({ error: 'campaign_id, day_of_week, start_hour, end_hour requis' });
  }

  try {
    const result = await calendarScheduler.addSchedule(
      campaign_id, day_of_week,
      start_hour, start_minute || 0,
      end_hour, end_minute || 0,
      bid_adjustment || 1.0
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/calendar/schedules/:id - Supprimer une plage
router.delete('/schedules/:id', wrap(async (req, res) => {
  const result = await calendarScheduler.removeSchedule(parseInt(req.params.id));
  res.json(result);
}));

// GET /api/calendar/events - Événements calendaires
router.get('/events', wrap(async (req, res) => {
  const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;
  const events = await calendarScheduler.getCalendarEvents(campaignId, req.query.all !== 'true');
  res.json(events);
}));

// POST /api/calendar/events - Ajouter un événement
router.post('/events', wrap(async (req, res) => {
  const { campaign_id, name, type, start_date, end_date, bid_multiplier } = req.body;

  if (!name || !type || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, type, start_date, end_date requis' });
  }

  try {
    const result = await calendarScheduler.addCalendarEvent(
      campaign_id || null, name, type, start_date, end_date, bid_multiplier || null
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/calendar/events/:id - Supprimer un événement
router.delete('/events/:id', wrap(async (req, res) => {
  const result = await calendarScheduler.removeCalendarEvent(parseInt(req.params.id));
  res.json(result);
}));

// GET /api/calendar/check/:campaignId - Vérifie si une campagne est programmée
router.get('/check/:campaignId', wrap(async (req, res) => {
  const scheduled = await calendarScheduler.isCampaignScheduledNow(parseInt(req.params.campaignId));
  res.json({ campaignId: parseInt(req.params.campaignId), scheduled });
}));

module.exports = router;
