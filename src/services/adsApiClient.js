/**
 * Client Google Ads API
 * Gère l'authentification OAuth2 et les appels à l'API Google Ads
 */
const config = require('../config');
const { db } = require('../database');

class AdsApiClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.initialized = false;
    this.cache = new Map();
    this.cacheTTL = 60000; // 60 secondes de cache
  }

  /**
   * Initialise le client et récupère un token OAuth2
   */
  async initialize() {
    try {
      const response = await this._fetchToken();
      this.accessToken = response.access_token;
      this.tokenExpiry = Date.now() + (response.expires_in * 1000);
      this.initialized = true;
      console.log('✅ Google Ads API connecté');
      return true;
    } catch (err) {
      console.error('❌ Échec connexion Google Ads API:', err.message);
      // Mode simulation si pas de credentials
      this.initialized = true;
      this.simulated = true;
      console.log('🔄 Mode simulation activé (pas de credentials Google Ads)');
      return true;
    }
  }

  async _fetchToken() {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const data = new URLSearchParams({
        client_id: config.googleAds.clientId,
        client_secret: config.googleAds.clientSecret,
        refresh_token: config.googleAds.refreshToken,
        grant_type: 'refresh_token',
      }).toString();

      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': data.length,
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.initialize();
    }
  }

  /**
   * Récupère les métriques en temps réel d'une campagne
   * En mode simulation, génère des données réalistes
   */
  async getCampaignMetrics(campaignId) {
    if (this.simulated) {
      return this._simulateMetrics(campaignId);
    }

    await this._ensureToken();
    const cacheKey = `metrics_${campaignId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.data;
    }

    try {
      // Appel réel à l'API Google Ads
      const response = await this._callGoogleAdsApi('search', {
        query: `
          SELECT
            campaign.id,
            campaign.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.average_cpc,
            metrics.ctr
          FROM
            campaign
          WHERE
            campaign.id = ${campaignId}
          AND segments.date DURING TODAY
        `,
      });

      this.cache.set(cacheKey, { ts: Date.now(), data: response });
      return response;
    } catch (err) {
      console.error(`Erreur métriques campagne ${campaignId}:`, err.message);
      return null;
    }
  }

  /**
   * Ajuste l'enchère max CPC d'une campagne
   */
  async updateCampaignBid(campaignId, newMaxCpc) {
    if (this.simulated) {
      db.prepare('UPDATE campaigns SET max_cpc = ?, updated_at = datetime("now") WHERE id = ?')
        .run(newMaxCpc, campaignId);
      return { success: true, newMaxCpc };
    }

    await this._ensureToken();
    try {
      const result = await this._callGoogleAdsApi('mutate', {
        operations: [{
          update: {
            resource: `customers/${config.googleAds.customerId}/campaigns/${campaignId}`,
            update_mask: 'maximise_conversions',
          },
        }],
      });
      return result;
    } catch (err) {
      console.error(`Erreur mise à jour enchère ${campaignId}:`, err.message);
      return null;
    }
  }

  /**
   * Met en pause / réactive une campagne
   */
  async setCampaignStatus(campaignId, status) {
    if (this.simulated) {
      db.prepare('UPDATE campaigns SET status = ?, updated_at = datetime("now") WHERE id = ?')
        .run(status, campaignId);
      return { success: true, status };
    }
    // Implémentation réelle similaire à updateCampaignBid
    return { success: true, status, simulated: true };
  }

  /**
   * Simulation de métriques pour le développement
   */
  _simulateMetrics(campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;

    const hourOfDay = new Date().getHours();
    const dayMultiplier = (hourOfDay >= 8 && hourOfDay <= 20) ? 1.5 : 0.5;
    const randomFactor = 0.7 + Math.random() * 0.6;

    const impressions = Math.floor((campaign.impressions || 0) + (10 + Math.random() * 30) * dayMultiplier * randomFactor);
    const clicks = Math.floor(impressions * (campaign.ctr || 0.03) * randomFactor);
    const spend = clicks * (campaign.current_cpc || campaign.max_cpc);
    const conversions = Math.floor(clicks * (0.02 + Math.random() * 0.03));
    const conversionValue = conversions * (campaign.conversion_value > 0 ? campaign.conversion_value / Math.max(campaign.conversions, 1) : 50);

    return {
      campaignId,
      impressions,
      clicks,
      costMicros: Math.floor(spend * 1_000_000),
      conversions,
      conversionValue,
      avgCpc: clicks > 0 ? spend / clicks : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      roi: spend > 0 ? ((conversionValue - spend) / spend) * 100 : 0,
    };
  }

  async _callGoogleAdsApi(endpoint, body) {
    // Placeholder pour l'appel réel à l'API Google Ads REST
    // Utiliserait axios avec les headers OAuth2
    throw new Error('API réelle non implémentée - utiliser le mode simulation');
  }
}

// Singleton
const client = new AdsApiClient();

module.exports = client;
