/**
 * Client Google Ads API (v17 REST)
 *
 * Gère :
 *   - OAuth2 (refresh token) via le module `https` natif
 *   - Listing / sync des campagnes (GAQL)
 *   - Récupération des métriques temps réel
 *   - Pause / resume d'une campagne
 *   - Mise à jour du CPC max et du budget quotidien
 *   - Création d'une campagne (budget + campagne + ad group)
 *
 * Modes :
 *   - réel       : credentials valides → vrais appels HTTPS vers googleads.googleapis.com
 *   - simulation : credentials manquants ou échec auth → DB locale uniquement
 */
const https = require('https');
const { URL } = require('url');
const config = require('../config');
const { db } = require('../database');

const GOOGLE_ADS_API_HOST = 'googleads.googleapis.com';
const GOOGLE_ADS_API_VERSION = 'v17';
const HTTPS_TIMEOUT_MS = 30000;

class AdsApiClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.initialized = false;
    this.simulated = false;
    this.cache = new Map();
    this.cacheTTL = 60_000;
    this._dbColumnsChecked = false;
    this._hasGoogleCampaignId = false;
  }

  // ============================================================
  //  Initialisation / OAuth
  // ============================================================
  async initialize() {
    const g = config.googleAds || {};

    if (!g.clientId || !g.clientSecret || !g.refreshToken) {
      this.initialized = true;
      this.simulated = true;
      console.log('🔄 Mode simulation activé (pas de credentials Google Ads)');
      return true;
    }

    try {
      const tok = await this._fetchToken();
      this.accessToken = tok.access_token;
      this.tokenExpiry = Date.now() + (tok.expires_in * 1000) - 30_000; // marge 30s
      this.initialized = true;
      this.simulated = false;
      console.log('✅ Google Ads API connecté (mode réel)');
      return true;
    } catch (err) {
      console.error('❌ Échec connexion Google Ads API:', err.message);
      this.initialized = true;
      this.simulated = true;
      console.log('🔄 Mode simulation activé (fallback après échec auth)');
      return true;
    }
  }

  _fetchToken() {
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
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: HTTPS_TIMEOUT_MS,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Réponse OAuth invalide: ' + e.message)); }
          } else {
            reject(new Error(`OAuth HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('OAuth timeout')); });
      req.write(data);
      req.end();
    });
  }

  async _ensureToken() {
    if (this.simulated) return;
    if (!this.accessToken || !this.tokenExpiry || Date.now() >= this.tokenExpiry) {
      const tok = await this._fetchToken();
      this.accessToken = tok.access_token;
      this.tokenExpiry = Date.now() + (tok.expires_in * 1000) - 30_000;
    }
  }

  // ============================================================
  //  Helpers config
  // ============================================================
  _customerId() {
    const raw = (config.googleAds.customerId || '').toString();
    return raw.replace(/-/g, '').trim();
  }

  _loginCustomerId() {
    const raw = (config.googleAds.loginCustomerId || '').toString();
    return raw.replace(/-/g, '').trim();
  }

  _baseHeaders() {
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'developer-token': config.googleAds.developerToken || '',
      'Content-Type': 'application/json',
    };
    const login = this._loginCustomerId();
    if (login) headers['login-customer-id'] = login;
    return headers;
  }

  // ============================================================
  //  Appel HTTPS générique
  // ============================================================
  async _callApi(method, path, body, _retry = false) {
    await this._ensureToken();

    const payload = body ? JSON.stringify(body) : null;
    const url = new URL(`https://${GOOGLE_ADS_API_HOST}${path}`);

    const headers = this._baseHeaders();
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const resp = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        method,
        headers,
        timeout: HTTPS_TIMEOUT_MS,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: chunks });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Google Ads API timeout')); });
      if (payload) req.write(payload);
      req.end();
    });

    // 401 → refresh token et retry une fois
    if (resp.status === 401 && !_retry) {
      this.accessToken = null;
      this.tokenExpiry = null;
      await this._ensureToken();
      return this._callApi(method, path, body, true);
    }

    let parsed = null;
    if (resp.body) {
      try { parsed = JSON.parse(resp.body); } catch { parsed = { raw: resp.body }; }
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = parsed && parsed.error ? JSON.stringify(parsed.error) : (resp.body || '');
      const err = new Error(`Google Ads API ${resp.status}: ${detail.slice(0, 500)}`);
      err.status = resp.status;
      err.details = parsed;
      throw err;
    }

    return parsed || {};
  }

  // ============================================================
  //  GAQL search avec pagination
  // ============================================================
  async _searchGaql(query) {
    const cid = this._customerId();
    if (!cid) throw new Error('customerId Google Ads non configuré');

    const results = [];
    let pageToken = null;
    do {
      const body = { query };
      if (pageToken) body.pageToken = pageToken;
      const resp = await this._callApi(
        'POST',
        `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:search`,
        body
      );
      if (Array.isArray(resp.results)) results.push(...resp.results);
      pageToken = resp.nextPageToken || null;
    } while (pageToken);

    return results;
  }

  // ============================================================
  //  DB helpers (schema-tolérant pour google_campaign_id)
  // ============================================================
  async _ensureGoogleCampaignIdColumn() {
    if (this._dbColumnsChecked) return this._hasGoogleCampaignId;
    this._dbColumnsChecked = true;
    try {
      // Tente d'ajouter la colonne (no-op si déjà là grâce à IF NOT EXISTS)
      await db.exec(
        'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_campaign_id TEXT'
      );
      this._hasGoogleCampaignId = true;
    } catch (e) {
      console.warn('⚠️  Impossible d\'ajouter campaigns.google_campaign_id:', e.message);
      this._hasGoogleCampaignId = false;
    }
    return this._hasGoogleCampaignId;
  }

  async _getLocalCampaign(localId) {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(localId);
  }

  async _resolveGoogleId(localId) {
    await this._ensureGoogleCampaignIdColumn();
    const c = await this._getLocalCampaign(localId);
    if (!c) return null;
    return c.google_campaign_id || null;
  }

  // ============================================================
  //  Métriques
  // ============================================================
  async getCampaignMetrics(campaignId) {
    if (this.simulated) return this._simulateMetrics(campaignId);

    const cacheKey = `metrics_${campaignId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;

    try {
      const googleId = await this._resolveGoogleId(campaignId);
      if (!googleId) {
        // Pas d'ID Google → on retombe sur la simulation pour éviter un crash
        return this._simulateMetrics(campaignId);
      }

      const query = `
        SELECT
          campaign.id,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.average_cpc,
          metrics.ctr
        FROM campaign
        WHERE campaign.id = ${googleId}
          AND segments.date DURING TODAY
      `;
      const rows = await this._searchGaql(query);

      const agg = {
        impressions: 0, clicks: 0, costMicros: 0,
        conversions: 0, conversionValue: 0, avgCpcSum: 0, n: 0,
      };
      for (const r of rows) {
        const m = r.metrics || {};
        agg.impressions += Number(m.impressions || 0);
        agg.clicks += Number(m.clicks || 0);
        agg.costMicros += Number(m.costMicros || 0);
        agg.conversions += Number(m.conversions || 0);
        agg.conversionValue += Number(m.conversionsValue || 0);
        agg.avgCpcSum += Number(m.averageCpc || 0);
        agg.n += 1;
      }

      const spend = agg.costMicros / 1_000_000;
      const avgCpc = agg.clicks > 0 ? spend / agg.clicks : 0;
      const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0;
      const roi = spend > 0 ? ((agg.conversionValue - spend) / spend) * 100 : 0;

      const data = {
        campaignId,
        impressions: agg.impressions,
        clicks: agg.clicks,
        costMicros: agg.costMicros,
        conversions: agg.conversions,
        conversionValue: agg.conversionValue,
        avgCpc,
        ctr,
        roi,
      };
      this.cache.set(cacheKey, { ts: Date.now(), data });
      return data;
    } catch (err) {
      console.error(`Erreur métriques campagne ${campaignId}:`, err.message);
      return this._simulateMetrics(campaignId);
    }
  }

  // ============================================================
  //  Status (pause / resume)
  // ============================================================
  async setCampaignStatus(campaignId, status) {
    const lower = String(status || '').toLowerCase();
    const apiStatus = lower === 'paused' ? 'PAUSED' : lower === 'active' ? 'ENABLED' : 'PAUSED';

    if (this.simulated) {
      await db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(lower, campaignId);
      return { success: true, status: lower, simulated: true };
    }

    try {
      const googleId = await this._resolveGoogleId(campaignId);
      if (!googleId) {
        console.warn(`Aucun google_campaign_id pour campagne ${campaignId}, push ignoré`);
        await db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(lower, campaignId);
        return { success: true, status: lower, skipped: 'no_google_id' };
      }

      const cid = this._customerId();
      await this._callApi(
        'POST',
        `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/campaigns:mutate`,
        {
          operations: [{
            update: {
              resourceName: `customers/${cid}/campaigns/${googleId}`,
              status: apiStatus,
            },
            updateMask: 'status',
          }],
        }
      );

      await db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(lower, campaignId);
      return { success: true, status: lower };
    } catch (err) {
      console.error(`Erreur setCampaignStatus(${campaignId}, ${status}):`, err.message);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  //  Mise à jour du CPC max
  // ============================================================
  async updateCampaignBid(campaignId, newMaxCpc) {
    const newMaxCpcNum = Number(newMaxCpc);
    if (!Number.isFinite(newMaxCpcNum) || newMaxCpcNum <= 0) {
      return { success: false, error: 'CPC invalide' };
    }

    if (this.simulated) {
      await db.prepare("UPDATE campaigns SET max_cpc = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newMaxCpcNum, campaignId);
      return { success: true, newMaxCpc: newMaxCpcNum, simulated: true };
    }

    try {
      const googleId = await this._resolveGoogleId(campaignId);
      if (!googleId) {
        await db.prepare("UPDATE campaigns SET max_cpc = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newMaxCpcNum, campaignId);
        return { success: true, newMaxCpc: newMaxCpcNum, skipped: 'no_google_id' };
      }

      const cid = this._customerId();
      const micros = Math.round(newMaxCpcNum * 1_000_000);

      // Manual CPC : on met à jour la stratégie d'enchère via manualCpc
      await this._callApi(
        'POST',
        `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/campaigns:mutate`,
        {
          operations: [{
            update: {
              resourceName: `customers/${cid}/campaigns/${googleId}`,
              manualCpc: { enhancedCpcEnabled: false },
            },
            updateMask: 'manualCpc.enhancedCpcEnabled',
          }],
        }
      ).catch((e) => {
        // Pas bloquant : on continue et on met à jour les ad groups
        console.warn(`updateCampaignBid: switch manualCpc ignoré (${e.message})`);
      });

      // Met à jour le CPC max sur tous les ad groups de la campagne
      const adGroups = await this._searchGaql(
        `SELECT ad_group.id, ad_group.resource_name
         FROM ad_group
         WHERE campaign.id = ${googleId} AND ad_group.status != 'REMOVED'`
      );
      const ops = adGroups.map((row) => ({
        update: {
          resourceName: row.adGroup.resourceName,
          cpcBidMicros: String(micros),
        },
        updateMask: 'cpcBidMicros',
      }));

      if (ops.length) {
        await this._callApi(
          'POST',
          `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/adGroups:mutate`,
          { operations: ops }
        );
      }

      await db.prepare("UPDATE campaigns SET max_cpc = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newMaxCpcNum, campaignId);
      return { success: true, newMaxCpc: newMaxCpcNum, adGroupsUpdated: ops.length };
    } catch (err) {
      console.error(`Erreur updateCampaignBid(${campaignId}):`, err.message);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  //  Mise à jour du budget quotidien
  // ============================================================
  async updateCampaignBudget(campaignId, newDailyBudgetEur) {
    const newBudget = Number(newDailyBudgetEur);
    if (!Number.isFinite(newBudget) || newBudget <= 0) {
      return { success: false, error: 'Budget invalide' };
    }

    if (this.simulated) {
      await db.prepare("UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newBudget, campaignId);
      return { success: true, dailyBudget: newBudget, simulated: true };
    }

    try {
      const googleId = await this._resolveGoogleId(campaignId);
      if (!googleId) {
        await db.prepare("UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newBudget, campaignId);
        return { success: true, dailyBudget: newBudget, skipped: 'no_google_id' };
      }

      const cid = this._customerId();
      // 1) Récupère le resource name du budget rattaché
      const rows = await this._searchGaql(
        `SELECT campaign.id, campaign_budget.resource_name
         FROM campaign
         WHERE campaign.id = ${googleId}`
      );
      if (!rows.length || !rows[0].campaignBudget) {
        throw new Error('Budget de la campagne introuvable');
      }
      const budgetRn = rows[0].campaignBudget.resourceName;
      const micros = Math.round(newBudget * 1_000_000);

      await this._callApi(
        'POST',
        `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/campaignBudgets:mutate`,
        {
          operations: [{
            update: {
              resourceName: budgetRn,
              amountMicros: String(micros),
            },
            updateMask: 'amountMicros',
          }],
        }
      );

      await db.prepare("UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newBudget, campaignId);
      return { success: true, dailyBudget: newBudget };
    } catch (err) {
      console.error(`Erreur updateCampaignBudget(${campaignId}):`, err.message);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  //  Création d'une campagne complète
  // ============================================================
  async createCampaign({ name, dailyBudget, maxCpc, bidStrategy, targetCpa, customerId }) {
    if (!name || !dailyBudget) throw new Error('name et dailyBudget requis');

    const safeMaxCpc = Number(maxCpc) > 0 ? Number(maxCpc) : 1.0;
    const safeStrategy = bidStrategy || 'manual_cpc';
    const safeTargetCpa = targetCpa ? Number(targetCpa) : null;

    // --- Mode simulation : DB locale uniquement ---
    if (this.simulated) {
      await this._ensureGoogleCampaignIdColumn();
      const result = await db.prepare(`
        INSERT INTO campaigns (name, daily_budget, max_cpc, bid_strategy, target_cpa, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(name, dailyBudget, safeMaxCpc, safeStrategy, safeTargetCpa);

      const localId = result.lastInsertRowid;
      const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(localId);
      return { ...campaign, simulated: true };
    }

    // --- Mode réel ---
    await this._ensureGoogleCampaignIdColumn();
    const cid = (customerId ? String(customerId).replace(/-/g, '') : this._customerId());
    if (!cid) throw new Error('customerId Google Ads requis');

    // 1) Crée le budget
    const budgetMicros = Math.round(Number(dailyBudget) * 1_000_000);
    const budgetResp = await this._callApi(
      'POST',
      `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/campaignBudgets:mutate`,
      {
        operations: [{
          create: {
            name: `${name} - Budget ${Date.now()}`,
            amountMicros: String(budgetMicros),
            deliveryMethod: 'STANDARD',
            explicitlyShared: false,
          },
        }],
      }
    );
    const budgetRn =
      budgetResp.results?.[0]?.resourceName ||
      budgetResp.mutateOperationResponses?.[0]?.campaignBudgetResult?.resourceName;
    if (!budgetRn) throw new Error('Impossible de créer le budget');

    // 2) Crée la campagne
    const campaignPayload = {
      name,
      status: 'PAUSED', // sécurité : créer en pause, l'utilisateur active explicitement
      advertisingChannelType: 'SEARCH',
      campaignBudget: budgetRn,
      networkSettings: {
        targetGoogleSearch: true,
        targetSearchNetwork: true,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      },
    };

    if (safeStrategy === 'target_cpa' && safeTargetCpa) {
      campaignPayload.targetCpa = {
        targetCpaMicros: String(Math.round(safeTargetCpa * 1_000_000)),
      };
    } else if (safeStrategy === 'maximize_conversions') {
      campaignPayload.maximizeConversions = {};
    } else {
      campaignPayload.manualCpc = { enhancedCpcEnabled: false };
    }

    const campResp = await this._callApi(
      'POST',
      `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/campaigns:mutate`,
      { operations: [{ create: campaignPayload }] }
    );
    const campRn =
      campResp.results?.[0]?.resourceName ||
      campResp.mutateOperationResponses?.[0]?.campaignResult?.resourceName;
    if (!campRn) throw new Error('Impossible de créer la campagne');

    const googleCampaignId = campRn.split('/').pop();

    // 3) Insère en DB locale
    const result = await db.prepare(`
      INSERT INTO campaigns (name, daily_budget, max_cpc, bid_strategy, target_cpa, status, google_campaign_id)
      VALUES (?, ?, ?, ?, ?, 'paused', ?)
    `).run(name, dailyBudget, safeMaxCpc, safeStrategy, safeTargetCpa, googleCampaignId);

    const localId = result.lastInsertRowid;

    // 4) Crée un ad group vide par défaut
    try {
      await this.createAdGroup({ campaignId: localId, name: `${name} - AdGroup`, maxCpc: safeMaxCpc });
    } catch (e) {
      console.warn(`Création ad group par défaut échouée: ${e.message}`);
    }

    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(localId);
    return { ...campaign, googleCampaignId };
  }

  // ============================================================
  //  Création d'un ad group
  // ============================================================
  async createAdGroup({ campaignId, name, maxCpc }) {
    if (!campaignId || !name) throw new Error('campaignId et name requis');
    const safeMaxCpc = Number(maxCpc) > 0 ? Number(maxCpc) : 1.0;

    if (this.simulated) {
      const r = await db.prepare(`
        INSERT INTO ad_groups (campaign_id, name, max_cpc, status)
        VALUES (?, ?, ?, 'active')
      `).run(campaignId, name, safeMaxCpc);
      return { id: r.lastInsertRowid, campaignId, name, maxCpc: safeMaxCpc, simulated: true };
    }

    const googleId = await this._resolveGoogleId(campaignId);
    if (!googleId) throw new Error('google_campaign_id manquant pour cette campagne');

    const cid = this._customerId();
    const micros = Math.round(safeMaxCpc * 1_000_000);

    const resp = await this._callApi(
      'POST',
      `/${GOOGLE_ADS_API_VERSION}/customers/${cid}/adGroups:mutate`,
      {
        operations: [{
          create: {
            name,
            campaign: `customers/${cid}/campaigns/${googleId}`,
            status: 'ENABLED',
            type: 'SEARCH_STANDARD',
            cpcBidMicros: String(micros),
          },
        }],
      }
    );

    const rn =
      resp.results?.[0]?.resourceName ||
      resp.mutateOperationResponses?.[0]?.adGroupResult?.resourceName;
    const googleAdGroupId = rn ? rn.split('/').pop() : null;

    let localRowId;
    try {
      const r = await db.prepare(`
        INSERT INTO ad_groups (campaign_id, name, max_cpc, status)
        VALUES (?, ?, ?, 'active')
      `).run(campaignId, name, safeMaxCpc);
      localRowId = r.lastInsertRowid;
    } catch (e) {
      console.warn(`Persist ad_group local échoué: ${e.message}`);
    }

    return { id: localRowId, googleAdGroupId, campaignId, name, maxCpc: safeMaxCpc };
  }

  // ============================================================
  //  Sync : pull all campaigns depuis Google Ads vers la DB locale
  // ============================================================
  async syncFromGoogleAds() {
    if (this.simulated) {
      return { created: 0, updated: 0, total: 0, simulated: true };
    }

    await this._ensureGoogleCampaignIdColumn();

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.bidding_strategy_type,
        campaign.target_cpa.target_cpa_micros,
        campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `;
    const rows = await this._searchGaql(query);

    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const c = row.campaign || {};
      const b = row.campaignBudget || {};
      const googleId = String(c.id || '');
      if (!googleId) continue;

      const name = c.name || `Campagne ${googleId}`;
      const apiStatus = String(c.status || 'ENABLED').toUpperCase();
      const dbStatus = apiStatus === 'PAUSED' ? 'paused'
                     : apiStatus === 'REMOVED' ? 'removed'
                     : 'active';
      const dailyBudget = b.amountMicros ? Number(b.amountMicros) / 1_000_000 : 0;
      const targetCpa = c.targetCpa && c.targetCpa.targetCpaMicros
        ? Number(c.targetCpa.targetCpaMicros) / 1_000_000
        : null;
      const bidStrategy = (c.biddingStrategyType || 'MANUAL_CPC').toLowerCase();

      // Match par google_campaign_id
      const existing = await db.prepare(
        'SELECT id FROM campaigns WHERE google_campaign_id = ?'
      ).get(googleId);

      if (existing) {
        await db.prepare(`
          UPDATE campaigns SET
            name = ?,
            daily_budget = ?,
            status = ?,
            bid_strategy = ?,
            target_cpa = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(name, dailyBudget, dbStatus, bidStrategy, targetCpa, existing.id);
        updated += 1;
      } else {
        await db.prepare(`
          INSERT INTO campaigns
            (name, daily_budget, max_cpc, bid_strategy, target_cpa, status, google_campaign_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(name, dailyBudget, 1.0, bidStrategy, targetCpa, dbStatus, googleId);
        created += 1;
      }
    }

    return { created, updated, total: rows.length };
  }

  // ============================================================
  //  Simulation (mode hors-ligne / dev)
  // ============================================================
  async _simulateMetrics(campaignId) {
    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;

    const hourOfDay = new Date().getHours();
    const dayMultiplier = (hourOfDay >= 8 && hourOfDay <= 20) ? 1.5 : 0.5;
    const randomFactor = 0.7 + Math.random() * 0.6;

    const impressions = Math.floor(
      (campaign.impressions || 0) + (10 + Math.random() * 30) * dayMultiplier * randomFactor
    );
    const clicks = Math.floor(impressions * (campaign.ctr || 0.03) * randomFactor);
    const spend = clicks * (campaign.current_cpc || campaign.max_cpc || 1);
    const conversions = Math.floor(clicks * (0.02 + Math.random() * 0.03));
    const conversionValue = conversions *
      (campaign.conversion_value > 0
        ? campaign.conversion_value / Math.max(campaign.conversions, 1)
        : 50);

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
}

// Singleton
const client = new AdsApiClient();
module.exports = client;
