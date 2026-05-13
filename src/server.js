/**
 * AdWords Automator - Serveur principal
 *
 * Point d'entrée de l'application. Initialise :
 *   - La base de données
 *   - Les services (Google Ads, Fraude, ROI, Calendrier)
 *   - Le serveur HTTP + WebSocket
 *   - Les routes API REST
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const config = require('./config');
const { initDatabase } = require('./database');

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

// ============================================================
//  Initialisation de l'application
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

// Fallback vers le dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Gestion des erreurs ---
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ============================================================
//  Démarrage
// ============================================================
async function start() {
  console.log('═══════════════════════════════════════════════');
  console.log('  AdWords Automator v1.0.0');
  console.log('  Gestion automatisée de campagnes Google Ads');
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // 1. Base de données
  await initDatabase();
  console.log('');

  // 2. Service Google Ads
  await adsApi.initialize();
  console.log('');

  // 3. WebSocket temps réel
  realtimeMonitor.initialize(server);
  realtimeMonitor.startBroadcast();
  console.log('');

  // 4. Bloqueur de clics abusifs
  fraudDetector.start();
  console.log('');

  // 5. Optimiseur ROI
  roiOptimizer.start();
  console.log('');

  // 6. Calendrier de diffusion
  calendarScheduler.start();
  console.log('');

  // 7. Serveur HTTP
  server.listen(config.server.port, () => {
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log(`  🚀 Serveur démarré sur http://localhost:${config.server.port}`);
    console.log(`  📊 Dashboard: http://localhost:${config.server.port}`);
    console.log(`  📡 API:        http://localhost:${config.server.port}/api`);
    console.log(`  🔌 WebSocket:  ws://localhost:${config.server.port}`);
    console.log('═══════════════════════════════════════════════');
  });
}

// Gestion de l'arrêt propre
function shutdown() {
  console.log('\n🛑 Arrêt du serveur...');
  fraudDetector.stop();
  roiOptimizer.stop();
  calendarScheduler.stop();
  realtimeMonitor.stop();
  server.close(() => {
    console.log('✅ Serveur arrêté');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Démarrage
start().catch(err => {
  console.error('Erreur fatale au démarrage:', err);
  process.exit(1);
});

module.exports = app;
