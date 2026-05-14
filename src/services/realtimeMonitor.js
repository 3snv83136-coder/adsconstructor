/**
 * Service de monitoring temps réel via WebSocket
 *
 * Diffuse les événements en temps réel à tous les clients connectés :
 *   - Métriques des campagnes (impressions, clics, coûts)
 *   - Alertes de fraude
 *   - Ajustements ROI
 *   - Changements d'état du calendrier
 */
const WebSocket = require('ws');
const config = require('../config');
const { db } = require('../database');

class RealtimeMonitor {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this.broadcastInterval = null;
    this.isRunning = false;
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      messagesBroadcast: 0,
    };
  }

  /**
   * Initialise le serveur WebSocket sur le serveur HTTP existant
   */
  initialize(httpServer) {
    this.wss = new WebSocket.Server({ server: httpServer });

    this.wss.on('connection', (ws, req) => {
      this.metrics.totalConnections++;
      this.metrics.activeConnections = this.wss.clients.size;
      this.clients.add(ws);

      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      console.log(`🔗 WebSocket connecté: ${clientIp} (${this.wss.clients.size} actifs)`);

      // Envoie l'état initial
      this._sendInitialState(ws).catch(err => console.error('Erreur état initial WS:', err.message));

      ws.on('message', (message) => {
        this._handleClientMessage(ws, message);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.metrics.activeConnections = this.wss.clients.size;
        console.log(`🔌 WebSocket déconnecté: ${clientIp} (${this.wss.clients.size} actifs)`);
      });

      ws.on('error', (err) => {
        console.error('Erreur WebSocket:', err.message);
      });
    });

    console.log('🔌 Serveur WebSocket prêt');
  }

  /**
   * Démarre la diffusion périodique
   */
  startBroadcast() {
    this.isRunning = true;
    // Diffusion toutes les 30 secondes
    this.broadcastInterval = setInterval(() => {
      this._broadcastMetrics().catch(err => console.error('Erreur broadcast métriques:', err.message));
    }, 30000);

    // Première diffusion immédiate
    this._broadcastMetrics().catch(err => console.error('Erreur broadcast métriques:', err.message));
  }

  /**
   * Envoie l'état initial à un nouveau client
   */
  async _sendInitialState(ws) {
    const campaigns = await db.prepare("SELECT * FROM campaigns WHERE status != 'removed'").all();

    const fraudStats = await db.prepare(
      "SELECT COUNT(*) as cnt FROM blocked_ips WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > now())"
    ).get();

    ws.send(JSON.stringify({
      type: 'initial_state',
      data: {
        campaigns: campaigns.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          dailyBudget: c.daily_budget,
          currentSpend: c.current_spend,
          clicks: c.clicks,
          impressions: c.impressions,
          conversions: c.conversions,
          ctr: c.ctr,
          roi: c.roi,
          maxCpc: c.max_cpc,
        })),
        fraudStats: {
          activeBlockedIps: fraudStats?.cnt || 0,
        },
        timestamp: new Date().toISOString(),
      },
    }));
  }

  /**
   * Diffuse les métriques à tous les clients
   */
  async _broadcastMetrics() {
    const campaigns = await db.prepare("SELECT * FROM campaigns WHERE status != 'removed'").all();

    if (campaigns.length === 0) return;

    const payload = {
      type: 'metrics_update',
      data: {
        campaigns: campaigns.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          impressions: c.impressions,
          clicks: c.clicks,
          spend: parseFloat(c.current_spend.toFixed(2)),
          conversions: c.conversions,
          ctr: parseFloat((c.ctr || 0).toFixed(2)),
          cpc: parseFloat((c.current_cpc || c.max_cpc).toFixed(2)),
          roi: parseFloat((c.roi || 0).toFixed(1)),
          dailyBudget: c.daily_budget,
          budgetUsage: c.daily_budget > 0 ? parseFloat(((c.current_spend / c.daily_budget) * 100).toFixed(1)) : 0,
        })),
        timestamp: new Date().toISOString(),
      },
    };

    this._broadcast(payload);
    this.metrics.messagesBroadcast++;
  }

  /**
   * Diffuse un événement à tous les clients
   */
  broadcast(eventType, data) {
    const payload = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
    };
    this._broadcast(payload);
    this.metrics.messagesBroadcast++;
  }

  /**
   * Envoie un message à tous les clients connectés
   */
  _broadcast(payload) {
    const message = JSON.stringify(payload);
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Gère les messages des clients
   */
  _handleClientMessage(ws, message) {
    try {
      const parsed = JSON.parse(message);

      switch (parsed.action) {
        case 'subscribe_campaign':
          // Le client veut suivre une campagne spécifique
          ws.campaignSubscription = parsed.campaignId;
          break;

        case 'unsubscribe':
          ws.campaignSubscription = null;
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;

        default:
          console.log('Message client inconnu:', parsed.action);
      }
    } catch (err) {
      console.error('Erreur parsing message client:', err.message);
    }
  }

  /**
   * Diffuse une alerte de fraude
   */
  broadcastFraudAlert(fraudData) {
    this.broadcast('fraud_alert', {
      ip: fraudData.ip_address,
      score: fraudData.score,
      reasons: fraudData.reasons,
      campaignId: fraudData.campaign_id,
      timestamp: fraudData.timestamp,
    });
  }

  /**
   * Diffuse un ajustement ROI
   */
  broadcastRoiAdjustment(adjustment) {
    this.broadcast('roi_adjustment', adjustment);
  }

  /**
   * Diffuse un changement d'état de campagne
   */
  broadcastCampaignStatus(campaignId, oldStatus, newStatus) {
    this.broadcast('campaign_status_change', {
      campaignId,
      oldStatus,
      newStatus,
    });
  }

  /**
   * Retourne les stats du service
   */
  getStats() {
    return {
      ...this.metrics,
      activeConnections: this.wss ? this.wss.clients.size : 0,
      isBroadcasting: this.isRunning,
    };
  }

  /**
   * Arrête le service
   */
  stop() {
    this.isRunning = false;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.wss) {
      this.wss.close();
    }
    console.log('🔌 Serveur WebSocket arrêté');
  }
}

// Singleton
const realtimeMonitor = new RealtimeMonitor();

module.exports = realtimeMonitor;
