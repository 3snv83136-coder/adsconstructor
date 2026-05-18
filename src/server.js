/**
 * AdWords Automator - Serveur principal
 *
 * Compatible Vercel serverless : détection automatique via VERCEL env.
 *   - Local       : démarre HTTP + WebSocket + setInterval (ROI, calendrier, fraude)
 *   - Vercel      : init paresseuse à la 1re requête, WS et setInterval désactivés
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

const adsApi = require('./services/adsApiClient');
const fraudDetector = require('./services/fraudDetector');
const roiOptimizer = require('./services/roiOptimizer');
const calendarScheduler = require('./services/calendarScheduler');
const realtimeMonitor = require('./services/realtimeMonitor');

const campaignsRouter = require('./routes/campaigns');
const fraudRouter = require('./routes/fraud');
const roiRouter = require('./routes/roi');
const calendarRouter = require('./routes/calendar');
const settingsRouter = require('./routes/settings');

const isVercel = !!process.env.VERCEL;

// ============================================================
//  Express app
// ============================================================
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
if (!isVercel) app.use(morgan('short'));

// ============================================================
//  Initialisation paresseuse — gate avant chaque requête
//  (sur Vercel, la 1re requête peut arriver avant que la DB ne soit prête)
// ============================================================
let initPromise = null;

function ensureInitialized() {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

app.use(async (req, res, next) => {
  try {
    await ensureInitialized();
    next();
  } catch (err) {
    console.error('Init failed:', err);
    res.status(503).json({ error: 'Service en cours d\'initialisation', detail: err.message });
  }
});

// ============================================================
//  Routes API
// ============================================================
app.use('/api/campaigns', campaignsRouter);
app.use('/api/fraud', fraudRouter);
app.use('/api/roi', roiRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/settings', settingsRouter);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    env: isVercel ? 'vercel' : 'local',
    timestamp: new Date().toISOString(),
    services: {
      adsApi: !!adsApi.initialized,
      fraudDetector: !!fraudDetector.isRunning,
      roiOptimizer: !!roiOptimizer.isRunning,
      calendarScheduler: !!calendarScheduler.isRunning,
      realtimeMonitor: !!realtimeMonitor.isRunning,
    },
  });
});

// ============================================================
//  Dashboard statique
// ============================================================
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ error: 'Erreur interne du serveur', detail: err.message });
});

// ============================================================
//  Initialisation
// ============================================================
async function initialize() {
  if (!isVercel) {
    console.log('═══════════════════════════════════════════════');
    console.log('  AdWords Automator v1.0.0');
    console.log('═══════════════════════════════════════════════\n');
  }

  await initDatabase();

  if (settingsRouter.loadStoredCredentialsIntoConfig) {
    settingsRouter.loadStoredCredentialsIntoConfig();
  }

  await adsApi.initialize();

  // setInterval et WebSocket n'ont aucun sens en serverless → local uniquement
  if (!isVercel) {
    realtimeMonitor.initialize(server);
    realtimeMonitor.startBroadcast();
    fraudDetector.start();
    roiOptimizer.start();
    calendarScheduler.start();
  } else {
    // En serverless, on charge juste les IPs bloquées en mémoire (cache rapide)
    try { fraudDetector.start(); } catch (e) { console.warn('fraudDetector.start failed:', e.message); }
  }
}

// ============================================================
//  Démarrage HTTP local uniquement
// ============================================================
if (!isVercel) {
  ensureInitialized()
    .then(() => {
      const port = config.server.port;
      server.listen(port, () => {
        console.log('═══════════════════════════════════════════════');
        console.log(`  🚀 http://localhost:${port}`);
        console.log(`  📊 Dashboard: http://localhost:${port}`);
        console.log(`  📡 API:        http://localhost:${port}/api`);
        console.log(`  🔌 WebSocket:  ws://localhost:${port}`);
        console.log('═══════════════════════════════════════════════');
      });
    })
    .catch(err => {
      console.error('Erreur fatale au démarrage:', err);
      process.exit(1);
    });

  function shutdown() {
    console.log('\n🛑 Arrêt...');
    try { fraudDetector.stop(); } catch {}
    try { roiOptimizer.stop(); } catch {}
    try { calendarScheduler.stop(); } catch {}
    try { realtimeMonitor.stop(); } catch {}
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
