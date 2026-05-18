/**
 * Calendrier de diffusion - Gestion précise minute par minute
 *
 * Gère les plages horaires de diffusion et les événements calendaires :
 *   - Plannings hebdomadaires (jour + heure début/fin + ajustement enchère)
 *   - Événements exceptionnels (blackout, boost, pause)
 *   - Contrôle minute par minute via node-schedule ou node-cron
 *   - Résolution de conflits entre événements
 *
 * Granularité : minute
 */
const config = require('../config');
const { db } = require('../database');

class CalendarScheduler {
  constructor() {
    this.activeTimers = new Map();   // campaignId → { cronJob, schedule }
    this.eventTimers = new Map();    // eventId → { cronJob, event }
    this.isRunning = false;
    this.checkInterval = null;
    this.minuteInterval = null;
  }

  /**
   * Démarre le planificateur
   */
  start() {
    this.isRunning = true;
    console.log('📅 Calendrier de diffusion démarré (granularité: minute)');

    // Charge tous les plannings actifs
    this._loadAllSchedules().catch(err => console.error('Erreur chargement plannings:', err.message));

    // Vérifie toutes les minutes l'état des campagnes
    this.minuteInterval = setInterval(() => {
      this._minuteTick().catch(err => console.error('Erreur tick calendrier:', err.message));
    }, 60000);

    // Exécute immédiatement le premier tick
    this._minuteTick().catch(err => console.error('Erreur tick calendrier:', err.message));

    console.log(`📅 ${this.activeTimers.size} campagne(s) planifiée(s)`);
  }

  /**
   * Tick minute par minute - vérifie l'état de chaque campagne
   */
  async _minuteTick() {
    if (!this.isRunning) return;

    const now = new Date();
    const currentDay = now.getDay();     // 0=dimanche, 6=samedi
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute;

    // Récupère toutes les campagnes actives
    const campaigns = await db.prepare(
      "SELECT * FROM campaigns WHERE status != 'removed'"
    ).all();

    for (const campaign of campaigns) {
      await this._checkCampaignSchedule(campaign, currentDay, currentHour, currentMinute, now);
    }
  }

  /**
   * Vérifie le planning d'une campagne pour le tick actuel
   */
  async _checkCampaignSchedule(campaign, currentDay, currentHour, currentMinute, now) {
    // 1. Vérifie d'abord les événements exceptionnels (prioritaires)
    const activeEvent = await this._getActiveCalendarEvent(campaign.id, now);
    if (activeEvent) {
      await this._applyCalendarEvent(campaign, activeEvent);
      return;
    }

    // 2. Vérifie le planning hebdomadaire
    const currentSchedule = await db.prepare(`
      SELECT * FROM schedules
      WHERE campaign_id = ?
        AND day_of_week = ?
        AND (? * 60 + ?) >= (start_hour * 60 + start_minute)
        AND (? * 60 + ?) < (end_hour * 60 + end_minute)
      ORDER BY bid_adjustment DESC
      LIMIT 1
    `).get(
      campaign.id, currentDay,
      currentHour, currentMinute,
      currentHour, currentMinute
    );

    if (currentSchedule) {
      // Dans la plage de diffusion → activer si pause
      if (campaign.status === 'paused') {
        await this._activateCampaign(campaign, currentSchedule);
      }
      // Appliquer l'ajustement d'enchère si différent
      if (campaign.max_cpc !== campaign.max_cpc * currentSchedule.bid_adjustment) {
        await this._applyBidAdjustment(campaign, currentSchedule.bid_adjustment);
      }
    } else {
      // Hors plage de diffusion → mettre en pause si active
      if (campaign.status === 'active') {
        await this._pauseCampaignForSchedule(campaign);
      }
    }
  }

  /**
   * Récupère un événement calendaire actif
   */
  async _getActiveCalendarEvent(campaignId, now) {
    const nowIso = now.toISOString();

    // Événements spécifiques à la campagne
    let event = await db.prepare(`
      SELECT * FROM calendar_events
      WHERE campaign_id = ? AND is_active = 1
        AND start_date <= ? AND end_date >= ?
      ORDER BY
        CASE type
          WHEN 'blackout' THEN 1
          WHEN 'pause' THEN 2
          WHEN 'boost' THEN 3
        END
      LIMIT 1
    `).get(campaignId, nowIso, nowIso);

    // Événements globaux (campaign_id IS NULL)
    if (!event) {
      event = await db.prepare(`
        SELECT * FROM calendar_events
        WHERE campaign_id IS NULL AND is_active = 1
          AND start_date <= ? AND end_date >= ?
        LIMIT 1
      `).get(nowIso, nowIso);
    }

    return event;
  }

  /**
   * Applique un événement calendaire
   */
  async _applyCalendarEvent(campaign, event) {
    switch (event.type) {
      case 'blackout':
        // Pause forcée
        if (campaign.status === 'active') {
          await db.prepare(
            "UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?"
          ).run(campaign.id);
          console.log(`📅 BLACKOUT: campagne ${campaign.name} mise en pause (${event.name})`);
        }
        break;

      case 'boost':
        // Activation + multiplicateur d'enchère
        if (campaign.status === 'paused') {
          await db.prepare(
            "UPDATE campaigns SET status = 'active', updated_at = datetime('now') WHERE id = ?"
          ).run(campaign.id);
        }
        if (event.bid_multiplier && event.bid_multiplier !== 1) {
          await this._applyBidAdjustment(campaign, event.bid_multiplier);
        }
        console.log(`📅 BOOST: campagne ${campaign.name} (${event.name}) x${event.bid_multiplier}`);
        break;

      case 'pause':
        if (campaign.status === 'active') {
          await db.prepare(
            "UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?"
          ).run(campaign.id);
          console.log(`📅 PAUSE: campagne ${campaign.name} (${event.name})`);
        }
        break;
    }
  }

  /**
   * Active une campagne selon son planning
   */
  async _activateCampaign(campaign, schedule) {
    await db.prepare(
      "UPDATE campaigns SET status = 'active', updated_at = datetime('now') WHERE id = ?"
    ).run(campaign.id);
    console.log(`▶️  Campagne ${campaign.name} activée (planning jour ${schedule.day_of_week}, ${schedule.start_hour}h${String(schedule.start_minute).padStart(2, '0')})`);
  }

  /**
   * Met en pause une campagne hors planning
   */
  async _pauseCampaignForSchedule(campaign) {
    await db.prepare(
      "UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?"
    ).run(campaign.id);
  }

  /**
   * Applique un ajustement d'enchère
   */
  async _applyBidAdjustment(campaign, multiplier) {
    const newCpc = parseFloat((campaign.max_cpc * multiplier).toFixed(2));
    await db.prepare(
      "UPDATE campaigns SET max_cpc = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newCpc, campaign.id);
  }

  /**
   * Charge tous les plannings depuis la base
   */
  async _loadAllSchedules() {
    const schedules = await db.prepare(`
      SELECT s.*, c.name as campaign_name, c.status
      FROM schedules s
      JOIN campaigns c ON s.campaign_id = c.id
      WHERE c.status != 'removed'
    `).all();

    const campaignIds = new Set(schedules.map(s => s.campaign_id));
    campaignIds.forEach(id => this.activeTimers.set(id, { schedules: schedules.filter(s => s.campaign_id === id) }));
  }

  // ============================================================
  //  API : CRUD plannings
  // ============================================================

  /**
   * Ajoute une plage de diffusion
   */
  async addSchedule(campaignId, dayOfWeek, startHour, startMinute, endHour, endMinute, bidAdjustment = 1.0) {
    // Validation
    if (dayOfWeek < 0 || dayOfWeek > 6) throw new Error('Jour invalide (0-6, 0=dimanche)');
    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) throw new Error('Heure invalide (0-23)');
    if (startMinute < 0 || startMinute > 59 || endMinute < 0 || endMinute > 59) throw new Error('Minute invalide (0-59)');

    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;
    if (startTime >= endTime) throw new Error('L\'heure de début doit être avant l\'heure de fin');

    const result = await db.prepare(`
      INSERT INTO schedules (campaign_id, day_of_week, start_hour, start_minute, end_hour, end_minute, bid_adjustment)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, dayOfWeek, startHour, startMinute, endHour, endMinute, bidAdjustment);

    // Recharge les plannings pour cette campagne
    const schedules = await db.prepare('SELECT * FROM schedules WHERE campaign_id = ?').all(campaignId);
    this.activeTimers.set(campaignId, { schedules });

    return {
      id: result.lastInsertRowid,
      campaignId,
      dayOfWeek,
      startTime: `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`,
      endTime: `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`,
      bidAdjustment,
    };
  }

  /**
   * Supprime une plage de diffusion
   */
  async removeSchedule(scheduleId) {
    await db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
    return { success: true, scheduleId };
  }

  /**
   * Liste les plannings d'une campagne
   */
  async getCampaignSchedules(campaignId) {
    return await db.prepare(`
      SELECT * FROM schedules
      WHERE campaign_id = ?
      ORDER BY day_of_week, start_hour, start_minute
    `).all(campaignId);
  }

  /**
   * Liste tous les plannings
   */
  async getAllSchedules() {
    return await db.prepare(`
      SELECT s.*, c.name as campaign_name
      FROM schedules s
      JOIN campaigns c ON s.campaign_id = c.id
      ORDER BY c.name, s.day_of_week, s.start_hour, s.start_minute
    `).all();
  }

  // ============================================================
  //  API : CRUD événements calendaires
  // ============================================================

  /**
   * Ajoute un événement calendaire
   */
  async addCalendarEvent(campaignId, name, type, startDate, endDate, bidMultiplier = null) {
    if (!['blackout', 'boost', 'pause'].includes(type)) {
      throw new Error('Type invalide: blackout, boost, pause');
    }

    const result = await db.prepare(`
      INSERT INTO calendar_events (campaign_id, name, type, start_date, end_date, bid_multiplier)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId || null, name, type, startDate, endDate, bidMultiplier);

    return {
      id: result.lastInsertRowid,
      campaignId,
      name,
      type,
      startDate,
      endDate,
      bidMultiplier,
    };
  }

  /**
   * Supprime un événement calendaire
   */
  async removeCalendarEvent(eventId) {
    await db.prepare('UPDATE calendar_events SET is_active = 0 WHERE id = ?').run(eventId);
    return { success: true, eventId };
  }

  /**
   * Liste les événements calendaires
   */
  async getCalendarEvents(campaignId = null, activeOnly = true) {
    let query = 'SELECT * FROM calendar_events';
    const params = [];

    if (campaignId) {
      query += ' WHERE (campaign_id = ? OR campaign_id IS NULL)';
      params.push(campaignId);
    }

    if (activeOnly) {
      query += campaignId ? ' AND is_active = 1' : ' WHERE is_active = 1';
    }

    query += ' ORDER BY start_date DESC';

    return await db.prepare(query).all(...params);
  }

  // ============================================================
  //  État actuel
  // ============================================================

  /**
   * Retourne l'état actuel du calendrier
   */
  async getCurrentState() {
    const now = new Date();
    const nowIso = now.toISOString();
    const currentDay = now.getDay();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    // Campagnes actuellement actives
    const activeCampaigns = await db.prepare(
      "SELECT * FROM campaigns WHERE status = 'active'"
    ).all();

    // Prochains événements
    const upcomingEvents = await db.prepare(`
      SELECT * FROM calendar_events
      WHERE is_active = 1 AND start_date > ?
      ORDER BY start_date ASC
      LIMIT 10
    `).all(nowIso);

    // Plannings actifs pour le jour
    const todaySchedules = await db.prepare(`
      SELECT s.*, c.name as campaign_name
      FROM schedules s
      JOIN campaigns c ON s.campaign_id = c.id
      WHERE s.day_of_week = ?
      ORDER BY s.start_hour, s.start_minute
    `).all(currentDay);

    return {
      timestamp: nowIso,
      currentDay,
      currentTime: `${String(Math.floor(currentTime / 60)).padStart(2, '0')}:${String(currentTime % 60).padStart(2, '0')}`,
      activeCampaigns: activeCampaigns.length,
      activeCampaignList: activeCampaigns.map(c => ({ id: c.id, name: c.name })),
      todaySchedules: todaySchedules.map(s => ({
        campaignName: s.campaign_name,
        start: `${String(s.start_hour).padStart(2, '0')}:${String(s.start_minute).padStart(2, '0')}`,
        end: `${String(s.end_hour).padStart(2, '0')}:${String(s.end_minute).padStart(2, '0')}`,
        bidAdjustment: s.bid_adjustment,
      })),
      upcomingEvents: upcomingEvents.map(e => ({
        name: e.name,
        type: e.type,
        startDate: e.start_date,
        endDate: e.end_date,
      })),
    };
  }

  /**
   * Vérifie si une campagne doit être active maintenant
   */
  async isCampaignScheduledNow(campaignId) {
    const now = new Date();
    const currentDay = now.getDay();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    const schedule = await db.prepare(`
      SELECT COUNT(*) as cnt FROM schedules
      WHERE campaign_id = ?
        AND day_of_week = ?
        AND ? >= (start_hour * 60 + start_minute)
        AND ? < (end_hour * 60 + end_minute)
    `).get(campaignId, currentDay, currentTime, currentTime);

    return (schedule && schedule.cnt > 0);
  }

  /**
   * Arrête le planificateur
   */
  stop() {
    this.isRunning = false;
    if (this.minuteInterval) {
      clearInterval(this.minuteInterval);
      this.minuteInterval = null;
    }
    console.log('📅 Calendrier de diffusion arrêté');
  }
}

// Singleton
const calendarScheduler = new CalendarScheduler();

module.exports = calendarScheduler;
