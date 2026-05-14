/**
 * Bloqueur de clics abusifs - Détection de fraude en temps réel
 *
 * Analyse chaque clic entrant selon plusieurs axes :
 *   1. Fréquence IP (par minute et par heure)
 *   2. Vélocité des clics (intervalle inter-clics)
 *   3. Patterns User-Agent suspects
 *   4. Anomalies géographiques
 *   5. Patterns de referrer suspects
 *
 * Score de fraude : 0 (légitime) → 100 (fraude certaine)
 * Seuil de blocage automatique : score ≥ 70
 *
 * Note serverless : le cache mémoire (`ipStats`, `blockedCache`) n'est pas
 * partagé entre instances ni persistant. La liste noire est donc également
 * vérifiée en base à chaque analyse.
 */
const config = require('../config');
const { db } = require('../database');

class FraudDetector {
  constructor() {
    this.ipStats = new Map();        // Cache IP → { minuteCount, hourCount, lastClickTs }
    this.blockedCache = new Set();   // Cache rapide des IPs bloquées
    this.cleanupInterval = null;
    this.metrics = {
      totalClicksAnalyzed: 0,
      fraudulentClicks: 0,
      blockedIps: 0,
      falsePositives: 0,
    };
  }

  /**
   * Démarre le détecteur de fraude (usage local — sur Vercel, voir /api/cron)
   */
  async start() {
    // Charge les IPs bloquées depuis la DB
    const blockedIps = await db.prepare(
      "SELECT ip_address FROM blocked_ips WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > now())"
    ).all();
    blockedIps.forEach(row => this.blockedCache.add(row.ip_address));

    // Nettoyage périodique toutes les 5 minutes
    this.cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);

    console.log(`🛡️  Bloqueur de clics abusifs actif - ${blockedIps.length} IPs bloquées en cache`);
  }

  /**
   * Vérifie si une IP est actuellement bloquée (cache mémoire + base)
   */
  async _isBlocked(ip) {
    if (this.blockedCache.has(ip)) return true;

    const row = await db.prepare(
      "SELECT 1 AS blocked FROM blocked_ips WHERE ip_address = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > now()) LIMIT 1"
    ).get(ip);

    if (row) {
      this.blockedCache.add(ip);
      return true;
    }
    return false;
  }

  /**
   * Analyse un clic entrant et retourne le score de fraude + décision
   *
   * @param {Object} clickData
   * @param {string} clickData.ip_address - Adresse IP
   * @param {string} clickData.user_agent - User-Agent header
   * @param {string} clickData.referrer - Referrer URL
   * @param {number} clickData.campaign_id - ID de la campagne
   * @param {number} clickData.ad_group_id - ID du groupe d'annonces
   * @param {string} clickData.country - Code pays
   * @returns {Promise<Object>} { isFraudulent, score, reasons, action }
   */
  async analyzeClick(clickData) {
    this.metrics.totalClicksAnalyzed++;
    const reasons = [];
    let score = 0;

    const ip = clickData.ip_address;
    const now = Date.now();

    // --- Vérification 1 : IP déjà bloquée (cache + base) ---
    if (await this._isBlocked(ip)) {
      return this._verdict(true, 100, ['IP bloquée (liste noire)'], 'block');
    }

    // --- Vérification 2 : Fréquence IP par minute ---
    const minuteScore = this._checkIpFrequency(ip, now);
    score += minuteScore;
    if (minuteScore > 20) reasons.push(`Fréquence IP excessive: ${minuteScore}/min`);

    // --- Vérification 3 : Vélocité des clics ---
    const velocityScore = this._checkClickVelocity(ip, now);
    score += velocityScore;
    if (velocityScore > 20) reasons.push(`Vélocité suspecte: ${velocityScore}ms entre clics`);

    // --- Vérification 4 : User-Agent suspect ---
    if (clickData.user_agent) {
      const uaScore = this._checkUserAgent(clickData.user_agent);
      score += uaScore;
      if (uaScore > 15) reasons.push('User-Agent suspect (bot/crawler)');
    }

    // --- Vérification 5 : Referrer vide ou suspect ---
    if (!clickData.referrer || clickData.referrer === '') {
      score += 5;
      reasons.push('Referrer absent');
    } else if (this._isSuspiciousReferrer(clickData.referrer)) {
      score += 15;
      reasons.push('Referrer suspect');
    }

    // --- Vérification 6 : Patterns géographiques ---
    if (clickData.country) {
      const geoScore = this._checkGeoAnomaly(ip, clickData.country, now);
      score += geoScore;
      if (geoScore > 10) reasons.push(`Anomalie géographique: ${clickData.country}`);
    }

    // --- Vérification 7 : Clics multiples sur même campagne depuis même IP ---
    const campaignScore = await this._checkCampaignAbuse(ip, clickData.campaign_id, now);
    score += campaignScore;
    if (campaignScore > 15) reasons.push('Abus campagne (multi-clics même IP)');

    // Plafonnement du score à 100
    score = Math.min(score, 100);

    // Décision automatique
    const isFraudulent = score >= 70;
    const action = isFraudulent && config.fraud.autoBlockEnabled ? 'block' : (score >= 40 ? 'flag' : 'allow');

    if (isFraudulent) {
      this.metrics.fraudulentClicks++;
      if (action === 'block') {
        await this._blockIp(ip, reasons.join('; '));
      }
    }

    // Enregistre le clic dans la base
    await this._logClick(clickData, isFraudulent, score, reasons);

    return this._verdict(isFraudulent, score, reasons, action);
  }

  /**
   * Vérifie la fréquence de clics par IP (par minute et par heure)
   */
  _checkIpFrequency(ip, now) {
    let stats = this.ipStats.get(ip);

    if (!stats) {
      stats = { minuteClicks: [], hourClicks: [], lastClickTs: now };
      this.ipStats.set(ip, stats);
    }

    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    // Nettoie les clics expirés
    stats.minuteClicks = stats.minuteClicks.filter(ts => ts > oneMinuteAgo);
    stats.hourClicks = stats.hourClicks.filter(ts => ts > oneHourAgo);

    // Ajoute le clic actuel
    stats.minuteClicks.push(now);
    stats.hourClicks.push(now);

    const minuteCount = stats.minuteClicks.length;
    const hourCount = stats.hourClicks.length;

    let score = 0;

    // Score basé sur le ratio par rapport aux seuils
    if (minuteCount > config.fraud.maxClicksPerIpPerMinute) {
      score += Math.min(40, (minuteCount - config.fraud.maxClicksPerIpPerMinute) * 5);
    }
    if (hourCount > config.fraud.maxClicksPerIpPerHour) {
      score += Math.min(30, (hourCount - config.fraud.maxClicksPerIpPerHour) * 2);
    }

    return score;
  }

  /**
   * Vérifie la vélocité entre clics
   */
  _checkClickVelocity(ip, now) {
    const stats = this.ipStats.get(ip);
    if (!stats) return 0;

    const sinceLastClick = now - stats.lastClickTs;
    stats.lastClickTs = now;

    if (sinceLastClick < config.fraud.clickVelocityThresholdMs) {
      // Plus c'est rapide, plus le score est élevé
      const ratio = 1 - (sinceLastClick / config.fraud.clickVelocityThresholdMs);
      return Math.floor(ratio * 30);
    }

    return 0;
  }

  /**
   * Vérifie le User-Agent contre les patterns suspects
   */
  _checkUserAgent(ua) {
    if (!ua) return 10; // UA absent = suspect

    const uaLower = ua.toLowerCase();
    let score = 0;

    // Vérifie les patterns de la config
    for (const pattern of config.fraud.suspiciousUaPatterns) {
      if (uaLower.includes(pattern)) {
        score += 20;
      }
    }

    // User-Agent trop court
    if (ua.length < 30) score += 5;

    // User-Agent vide ou générique
    if (ua === '-' || ua === '""' || ua === "''") score += 15;

    return Math.min(score, 30);
  }

  /**
   * Détecte les anomalies géographiques
   * (changement de pays impossible en peu de temps)
   */
  _checkGeoAnomaly(ip, country, now) {
    // Vérifie si l'IP a changé de pays en moins de 5 minutes
    const stats = this.ipStats.get(ip);
    if (!stats || !stats.lastCountry) {
      if (stats) stats.lastCountry = country;
      return 0;
    }

    if (stats.lastCountry !== country && stats.lastCountryTs) {
      const timeSinceChange = now - stats.lastCountryTs;
      // Changement de pays en moins de 10 minutes = suspect
      if (timeSinceChange < 600000) {
        return 25;
      }
    }

    stats.lastCountry = country;
    stats.lastCountryTs = now;
    return 0;
  }

  /**
   * Vérifie les clics abusifs sur une même campagne
   */
  async _checkCampaignAbuse(ip, campaignId, now) {
    if (campaignId === undefined || campaignId === null) return 0;

    const oneMinuteAgo = new Date(now - 60000).toISOString();

    const count = await db.prepare(
      `SELECT COUNT(*) as cnt FROM click_events
       WHERE ip_address = ? AND campaign_id = ? AND created_at > ?::timestamptz`
    ).get(ip, campaignId, oneMinuteAgo);

    if (count && Number(count.cnt) > 3) {
      return Math.min(20, (Number(count.cnt) - 3) * 5);
    }

    return 0;
  }

  /**
   * Vérifie un referrer suspect
   */
  _isSuspiciousReferrer(referrer) {
    const suspiciousDomains = [
      'click-farm', 'traffic-bot', 'buy-cheap-traffic', 'ad-sense-clicker',
      'clickexchange', 'ptc-', 'autoclick',
    ];
    const refLower = referrer.toLowerCase();
    return suspiciousDomains.some(d => refLower.includes(d));
  }

  /**
   * Bloque une IP automatiquement
   */
  async _blockIp(ip, reason) {
    if (this.blockedCache.has(ip)) return;

    this.blockedCache.add(ip);
    this.metrics.blockedIps++;

    const expiresAt = new Date(Date.now() + config.fraud.blockDurationMinutes * 60000).toISOString();

    await db.prepare(
      `INSERT INTO blocked_ips (ip_address, reason, blocked_at, expires_at, is_active)
       VALUES (?, ?, now(), ?::timestamptz, 1)
       ON CONFLICT (ip_address) DO UPDATE SET
         reason = EXCLUDED.reason,
         blocked_at = now(),
         expires_at = EXCLUDED.expires_at,
         is_active = 1`
    ).run(ip, reason, expiresAt);

    // Log d'audit
    await db.prepare(
      `INSERT INTO audit_logs (event_type, severity, message, details)
       VALUES ('ip_blocked', 'warning', ?, ?)`
    ).run(`IP bloquée: ${ip}`, JSON.stringify({ reason, expiresAt }));

    console.log(`🚫 IP bloquée: ${ip} — ${reason} (expire: ${expiresAt})`);
  }

  /**
   * Débloque une IP manuellement
   */
  async unblockIp(ip) {
    this.blockedCache.delete(ip);

    await db.prepare('UPDATE blocked_ips SET is_active = 0 WHERE ip_address = ?').run(ip);

    await db.prepare(
      `INSERT INTO audit_logs (event_type, severity, message)
       VALUES ('ip_unblocked', 'info', ?)`
    ).run(`IP débloquée: ${ip}`);

    return { success: true, ip };
  }

  /**
   * Enregistre un événement de clic dans la DB
   */
  async _logClick(clickData, isFraudulent, score, reasons) {
    await db.prepare(
      `INSERT INTO click_events (campaign_id, ad_group_id, ip_address, user_agent, referrer,
        country, city, is_fraudulent, fraud_score, fraud_reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      clickData.campaign_id || null,
      clickData.ad_group_id || null,
      clickData.ip_address,
      clickData.user_agent || null,
      clickData.referrer || null,
      clickData.country || null,
      clickData.city || null,
      isFraudulent ? 1 : 0,
      score,
      reasons.join('; ')
    );
  }

  /**
   * Construit le verdict
   */
  _verdict(isFraudulent, score, reasons, action) {
    return {
      isFraudulent,
      score,
      reasons,
      action,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Retourne les statistiques du détecteur
   */
  async getStats() {
    const blockedCount = await db.prepare(
      "SELECT COUNT(*) as cnt FROM blocked_ips WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > now())"
    ).get();

    const recentFraud = await db.prepare(
      "SELECT COUNT(*) as cnt FROM click_events WHERE is_fraudulent = 1 AND created_at > now() - interval '1 hour'"
    ).get();

    const totalRecent = await db.prepare(
      "SELECT COUNT(*) as cnt FROM click_events WHERE created_at > now() - interval '1 hour'"
    ).get();

    const recentFraudCnt = Number(recentFraud?.cnt || 0);
    const totalRecentCnt = Number(totalRecent?.cnt || 0);

    return {
      ...this.metrics,
      activeBlockedIps: Number(blockedCount?.cnt || 0),
      recentFraudClicks: recentFraudCnt,
      recentTotalClicks: totalRecentCnt,
      fraudRate: totalRecentCnt > 0
        ? ((recentFraudCnt / totalRecentCnt) * 100).toFixed(1)
        : 0,
    };
  }

  /**
   * Retourne les IPs bloquées
   */
  async getBlockedIps() {
    return db.prepare(
      "SELECT * FROM blocked_ips WHERE is_active = 1 ORDER BY blocked_at DESC LIMIT 500"
    ).all();
  }

  /**
   * Nettoie les entrées expirées
   */
  async _cleanup() {
    const now = Date.now();
    // Nettoie le cache IP
    for (const [ip, stats] of this.ipStats) {
      const oneHourAgo = now - 3600000;
      if (stats.lastClickTs < oneHourAgo) {
        this.ipStats.delete(ip);
      }
    }

    // Désactive les IPs bloquées expirées
    await db.prepare(
      "UPDATE blocked_ips SET is_active = 0 WHERE expires_at IS NOT NULL AND expires_at <= now()"
    ).run();
  }

  /**
   * Arrête le détecteur
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    console.log('🛡️  Bloqueur de clics arrêté');
  }
}

// Singleton
const fraudDetector = new FraudDetector();

module.exports = fraudDetector;
