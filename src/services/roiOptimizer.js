/**
 * Optimiseur ROI Automatique
 *
 * Analyse les performances de chaque campagne et ajuste automatiquement :
 *   - Les enchères max CPC
 *   - Les budgets quotidiens
 *   - La mise en pause/reprise
 *
 * Règles d'optimisation :
 *   1. Si CPA > target_cpa * 1.5 → réduire l'enchère
 *   2. Si CPA < target_cpa * 0.5 → augmenter l'enchère
 *   3. Si coût quotidien approche le budget → ralentir
 *   4. Si ROI < 0 pendant > 24h → pauser la campagne
 *   5. Si seuil de coût minimum non atteint → ne pas ajuster
 */
const config = require('../config');
const { db } = require('../database');
const adsApi = require('./adsApiClient');

class RoiOptimizer {
  constructor() {
    this.adjustmentHistory = [];
    this.optimizationInterval = null;
    this.isRunning = false;
  }

  /**
   * Démarre le cycle d'optimisation (usage local — sur Vercel, voir /api/cron)
   */
  start() {
    this.isRunning = true;
    const intervalMs = config.roi.checkIntervalMinutes * 60 * 1000;

    // Premier lancement immédiat
    this._runOptimizationCycle();

    // Puis lancement périodique
    this.optimizationInterval = setInterval(() => {
      this._runOptimizationCycle();
    }, intervalMs);

    console.log(`📈 Optimiseur ROI démarré (intervalle: ${config.roi.checkIntervalMinutes} min)`);
  }

  /**
   * Cycle d'optimisation principal
   */
  async _runOptimizationCycle() {
    console.log('📊 Début du cycle d\'optimisation ROI...');
    const startTime = Date.now();

    // Récupère toutes les campagnes actives
    const campaigns = await db.prepare(
      "SELECT * FROM campaigns WHERE status != 'removed'"
    ).all();

    let adjustments = 0;

    for (const campaign of campaigns) {
      try {
        const result = await this._optimizeCampaign(campaign);
        if (result.adjusted) {
          adjustments++;
        }
      } catch (err) {
        console.error(`Erreur optimisation campagne ${campaign.id}:`, err.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`📊 Cycle terminé: ${adjustments} ajustements en ${duration}ms`);

    return { adjustments, duration };
  }

  /**
   * Optimise une campagne spécifique
   */
  async _optimizeCampaign(campaign) {
    // Récupère les métriques les plus récentes
    const metrics = await adsApi.getCampaignMetrics(campaign.id);
    if (!metrics) return { adjusted: false, reason: 'Pas de métriques disponibles' };

    // Met à jour les métriques dans la DB
    await this._updateCampaignMetrics(campaign.id, metrics);

    // Récupère la campagne fraîchement mise à jour
    const freshCampaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id);

    // Vérifie le seuil de coût minimum
    const totalSpend = freshCampaign.current_spend;
    if (totalSpend < config.roi.minCostThreshold) {
      return {
        adjusted: false,
        reason: `Coût total (${totalSpend.toFixed(2)} €) < seuil minimum (${config.roi.minCostThreshold} €)`,
        cpa: null,
      };
    }

    // Calcule le CPA actuel
    const cpa = freshCampaign.conversions > 0
      ? totalSpend / freshCampaign.conversions
      : null;

    // Calcule le ROI actuel
    const roi = freshCampaign.roi || 0;

    // Décision d'ajustement
    let adjustment = null;

    // --- Règle 1 : CPA trop élevé → réduire l'enchère ---
    if (cpa && cpa > config.roi.targetCpa * 1.5) {
      const reduction = Math.min(0.3, (cpa - config.roi.targetCpa) / cpa);
      adjustment = await this._adjustBid(freshCampaign, -reduction, `CPA élevé: ${cpa.toFixed(2)} € > cible ${config.roi.targetCpa} €`);
    }

    // --- Règle 2 : CPA très bas → augmenter l'enchère pour plus de volume ---
    else if (cpa && cpa < config.roi.targetCpa * 0.5 && freshCampaign.daily_budget > totalSpend * 0.8) {
      const increase = Math.min(0.2, (config.roi.targetCpa - cpa) / config.roi.targetCpa);
      if (freshCampaign.status === 'active') {
        adjustment = await this._adjustBid(freshCampaign, increase, `CPA bas: ${cpa.toFixed(2)} € — augmentation pour volume`);
      }
    }

    // --- Règle 3 : Budget quotidien presque épuisé → réduire l'enchère ---
    else if (freshCampaign.daily_budget > 0 && totalSpend > freshCampaign.daily_budget * 0.8) {
      const spendRatio = totalSpend / freshCampaign.daily_budget;
      const reduction = Math.min(0.5, (spendRatio - 0.8) * 2);
      adjustment = await this._adjustBid(freshCampaign, -reduction, `Budget ${(spendRatio * 100).toFixed(0)}% consommé`);
    }

    // --- Règle 4 : ROI négatif persistant → pause ---
    else if (roi < -50 && freshCampaign.conversions === 0 && freshCampaign.clicks > 100) {
      if (freshCampaign.status === 'active') {
        adjustment = await this._pauseCampaign(freshCampaign, `ROI négatif (${roi.toFixed(1)}%) après ${freshCampaign.clicks} clics sans conversion`);
      }
    }

    // Enregistre un snapshot de métriques
    await this._saveMetricsSnapshot(campaign.id, metrics);

    return adjustment || { adjusted: false, cpa, roi, reason: 'Aucun ajustement nécessaire' };
  }

  /**
   * Ajuste l'enchère d'une campagne
   */
  async _adjustBid(campaign, adjustmentPct, reason) {
    // Applique les limites de configuration
    adjustmentPct = Math.max(
      config.roi.minBidAdjustmentPct / 100,
      Math.min(config.roi.maxBidAdjustmentPct / 100, adjustmentPct)
    );

    const oldMaxCpc = campaign.max_cpc;
    const newMaxCpc = Math.max(0.01, oldMaxCpc * (1 + adjustmentPct));

    // Appelle l'API pour ajuster l'enchère
    await adsApi.updateCampaignBid(campaign.id, parseFloat(newMaxCpc.toFixed(2)));

    // Enregistre l'ajustement
    await this._logAdjustment(campaign.id, 'bid_change', oldMaxCpc, newMaxCpc, reason, {
      cpa: campaign.current_spend / Math.max(campaign.conversions, 1),
      roi: campaign.roi,
      clicks: campaign.clicks,
    });

    console.log(`💰 Campagne ${campaign.name}: enchère ${oldMaxCpc.toFixed(2)} → ${newMaxCpc.toFixed(2)} € (${(adjustmentPct * 100).toFixed(0)}%) — ${reason}`);

    // Met à jour en local
    await db.prepare(
      "UPDATE campaigns SET max_cpc = ?, updated_at = now() WHERE id = ?"
    ).run(newMaxCpc, campaign.id);

    return {
      adjusted: true,
      type: 'bid_change',
      oldValue: oldMaxCpc,
      newValue: newMaxCpc,
      adjustmentPct: Math.round(adjustmentPct * 100),
      reason,
    };
  }

  /**
   * Met en pause une campagne
   */
  async _pauseCampaign(campaign, reason) {
    await adsApi.setCampaignStatus(campaign.id, 'paused');

    await this._logAdjustment(campaign.id, 'pause', null, null, reason, {
      cpa: campaign.current_spend / Math.max(campaign.conversions, 1),
      roi: campaign.roi,
    });

    console.log(`⏸️  Campagne ${campaign.name} mise en pause — ${reason}`);

    await db.prepare(
      "UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = ?"
    ).run(campaign.id);

    return {
      adjusted: true,
      type: 'pause',
      oldValue: 'active',
      newValue: 'paused',
      reason,
    };
  }

  /**
   * Réactive une campagne
   */
  async resumeCampaign(campaignId, reason = 'Réactivation manuelle') {
    await adsApi.setCampaignStatus(campaignId, 'active');

    await this._logAdjustment(campaignId, 'resume', null, null, reason);

    await db.prepare(
      "UPDATE campaigns SET status = 'active', updated_at = now() WHERE id = ?"
    ).run(campaignId);

    console.log(`▶️  Campagne ${campaignId} réactivée — ${reason}`);

    return { adjusted: true, type: 'resume' };
  }

  /**
   * Met à jour les métriques locales d'une campagne
   */
  async _updateCampaignMetrics(campaignId, metrics) {
    const cost = (metrics.costMicros || 0) / 1_000_000;
    const roi = cost > 0
      ? ((metrics.conversionValue - cost) / cost) * 100
      : 0;

    await db.prepare(`
      UPDATE campaigns SET
        impressions = impressions + ?,
        clicks = clicks + ?,
        current_spend = current_spend + ?,
        conversions = conversions + ?,
        conversion_value = conversion_value + ?,
        current_cpc = ?,
        ctr = ?,
        roi = ?,
        last_sync_at = now(),
        updated_at = now()
      WHERE id = ?
    `).run(
      metrics.impressions || 0,
      metrics.clicks || 0,
      cost,
      metrics.conversions || 0,
      metrics.conversionValue || 0,
      metrics.avgCpc || 0,
      metrics.ctr || 0,
      roi,
      campaignId
    );
  }

  /**
   * Sauvegarde un snapshot de métriques
   */
  async _saveMetricsSnapshot(campaignId, metrics) {
    const cost = (metrics.costMicros || 0) / 1_000_000;
    const roi = cost > 0
      ? ((metrics.conversionValue - cost) / cost) * 100
      : 0;

    await db.prepare(`
      INSERT INTO metrics_snapshot (campaign_id, impressions, clicks, spend, conversions, avg_cpc, ctr, roi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      campaignId,
      metrics.impressions || 0,
      metrics.clicks || 0,
      cost,
      metrics.conversions || 0,
      metrics.avgCpc || 0,
      metrics.ctr || 0,
      roi
    );
  }

  /**
   * Enregistre un ajustement dans l'historique
   */
  async _logAdjustment(campaignId, type, oldValue, newValue, reason, snapshot) {
    await db.prepare(`
      INSERT INTO roi_adjustments (campaign_id, adjustment_type, old_value, new_value, reason, performance_snapshot)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, type, oldValue, newValue, reason, JSON.stringify(snapshot || {}));
  }

  /**
   * Analyse complète du ROI pour une campagne
   */
  async analyzeRoi(campaignId) {
    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;

    const cpa = campaign.conversions > 0
      ? campaign.current_spend / campaign.conversions
      : null;

    // Récupère l'historique des métriques (7 derniers jours)
    const history = await db.prepare(`
      SELECT * FROM metrics_snapshot
      WHERE campaign_id = ? AND timestamp > now() - interval '7 days'
      ORDER BY timestamp ASC
    `).all(campaignId);

    // Tendances
    const recentHistory = history.slice(-12); // 1h de données (si intervalle 5min)

    const trend = this._calculateTrend(recentHistory);

    return {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      currentMetrics: {
        spend: campaign.current_spend,
        impressions: campaign.impressions,
        clicks: campaign.clicks,
        conversions: campaign.conversions,
        ctr: campaign.ctr,
        cpc: campaign.current_cpc || campaign.max_cpc,
        cpa,
        roi: campaign.roi,
      },
      trend,
      targetCpa: config.roi.targetCpa,
      minCostThreshold: config.roi.minCostThreshold,
      recommendation: this._generateRecommendation(campaign, cpa, trend),
    };
  }

  /**
   * Calcule la tendance des métriques
   */
  _calculateTrend(history) {
    if (history.length < 2) return { direction: 'stable' };

    const first = history[0];
    const last = history[history.length - 1];

    const ctrChange = (last.ctr || 0) - (first.ctr || 0);
    const roiChange = (last.roi || 0) - (first.roi || 0);
    const spendChange = (last.spend || 0) - (first.spend || 0);

    return {
      ctr: ctrChange > 0.1 ? 'up' : ctrChange < -0.1 ? 'down' : 'stable',
      roi: roiChange > 1 ? 'up' : roiChange < -1 ? 'down' : 'stable',
      spend: spendChange > 0.5 ? 'up' : spendChange < -0.5 ? 'down' : 'stable',
      direction: roiChange > 1 ? 'improving' : roiChange < -1 ? 'declining' : 'stable',
    };
  }

  /**
   * Génère une recommandation
   */
  _generateRecommendation(campaign, cpa, trend) {
    if (campaign.status !== 'active') {
      return { action: 'none', message: 'Campagne inactive — réactiver si les conditions sont favorables' };
    }

    if (campaign.current_spend < config.roi.minCostThreshold) {
      return { action: 'wait', message: `Coût insuffisant (${campaign.current_spend.toFixed(2)} € < ${config.roi.minCostThreshold} €) — attente de données` };
    }

    if (cpa && cpa > config.roi.targetCpa * 1.5) {
      return { action: 'reduce_bid', message: `CPA élevé (${cpa.toFixed(2)} €) — réduire l'enchère` };
    }

    if (cpa && cpa < config.roi.targetCpa * 0.5) {
      return { action: 'increase_bid', message: `CPA bas (${cpa.toFixed(2)} €) — augmenter l'enchère pour plus de volume` };
    }

    if (trend.direction === 'declining') {
      return { action: 'monitor', message: 'Tendance à la baisse — surveiller' };
    }

    return { action: 'maintain', message: 'Performances dans la cible — maintenir' };
  }

  /**
   * Retourne l'historique des ajustements
   */
  async getAdjustmentsHistory(limit = 50) {
    return db.prepare(`
      SELECT ra.*, c.name as campaign_name
      FROM roi_adjustments ra
      JOIN campaigns c ON ra.campaign_id = c.id
      ORDER BY ra.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Arrête l'optimiseur
   */
  stop() {
    this.isRunning = false;
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = null;
    }
    console.log('📈 Optimiseur ROI arrêté');
  }
}

// Singleton
const roiOptimizer = new RoiOptimizer();

module.exports = roiOptimizer;
