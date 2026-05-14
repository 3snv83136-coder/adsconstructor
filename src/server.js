/**
 * AdWords Automator - Serveur principal
 *
 * Point d'entrée de l'application. Initialise :
 *   - La base de données
 *   - Les services (Google Ads, Fraude, ROI, Calendrier)
 *   - Le serveur HTTP + WebSocket (local uniquement)
 *   - Les routes API REST
 *
 * Compatible Vercel serverless : détection automatique via VERCEL env.
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const config = require('./config');
const { initDatabase, closeDatabase } = require('./database');

// Services
const adsApi = require('./services/adsApiClient');
const fraudDetector = require('./services/fraudDetector');
const roiOptimizer = require('./services/roiOptimizer');
const calendarScheduler = require('./services/calendarScheduler');
const realtimeMonitor = require('./services/realtimeMonitor');

// Routes
const campaignsRouter = require('./routes/campaigns');
const fraudRouter = require('./routes/fraud');
const roiRouter = require('./routes/roi');
const calendarRouter = require('./routes/calendar');
const cronRouter = require('./routes/cron');

// ============================================================
//  Création de l'app Express
// ============================================================
const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(morgan('short'));

// --- Routes API ---
app.use('/api/campaigns', campaignsRouter);
app.use('/api/fraud', fraudRouter);
app.use('/api/roi', roiRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/cron', cronRouter);

// --- Route de santé ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      adsApi: adsApi.initialized,
      fraudDetector: fraudDetector.isRunning || true,
      roiOptimizer: roiOptimizer.isRunning,
      calendarScheduler: calendarScheduler.isRunning,
      realtimeMonitor: realtimeMonitor.isRunning,
    },
  });
});

// --- Dashboard statique ---
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Gestion des erreurs ---
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ============================================================
//  Initialisation asynchrone (top-level await supporté par Vercel / Node 14+)
// ============================================================
async function initialize() {
  const isVercel = !!process.env.VERCEL;

  if (!isVercel) {
    console.log('═══════════════════════════════════════════════');
    console.log('  AdWords Automator v1.0.0');
    console.log('  Gestion automatisée de campagnes Google Ads');
    console.log('═══════════════════════════════════════════════');
    console.log('');
  }

  // 1. Base de données
  await initDatabase();

  // 2. Service Google Ads
  await adsApi.initialize();

  // 3. WebSocket temps réel (désactivé sur Vercel — pas de WS persistant)
  if (!isVercel) {
    realtimeMonitor.initialize(server);
    realtimeMonitor.startBroadcast();
  }

  // 4-6. Tâches de fond : en local via setInterval, sur Vercel via /api/cron
  if (!isVercel) {
    await fraudDetector.start();   // Bloqueur de clics abusifs
    roiOptimizer.start();          // Optimiseur ROI
    await calendarScheduler.start(); // Calendrier de diffusion
  } else {
    console.log('⏱️  Tâches de fond pilotées par Vercel Cron (/api/cron/all)');
  }

  // 7. Démarrage du serveur HTTP (local uniquement)
  if (!isVercel) {
    const port = config.server.port;
    server.listen(port, () => {
      console.log('');
      console.log('═══════════════════════════════════════════════');
      console.log(`  🚀 Serveur démarré sur http://localhost:${port}`);
      console.log(`  📊 Dashboard: http://localhost:${port}`);
      console.log(`  📡 API:        http://localhost:${port}/api`);
      console.log(`  🔌 WebSocket:  ws://localhost:${port}`);
      console.log('═══════════════════════════════════════════════');
    });
  }
}

// Initialisation
const initPromise = initialize().catch(err => {
  console.error('Erreur fatale au démarrage:', err);
  if (!process.env.VERCEL) process.exit(1);
});

// Gestion de l'arrêt propre (local uniquement)
if (!process.env.VERCEL) {
  function shutdown() {
    console.log('\n🛑 Arrêt du serveur...');
    fraudDetector.stop();
    roiOptimizer.stop();
    calendarScheduler.stop();
    realtimeMonitor.stop();
    server.close(async () => {
      await closeDatabase().catch(() => {});
      console.log('✅ Serveur arrêté');
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
