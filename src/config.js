/**
 * Configuration centrale de l'application
 * Charge les variables d'environnement et expose les paramètres typés
 */
require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'development',
  },
  database: {
    path: process.env.DB_PATH || './data/adwords.db',
  },
  googleAds: {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '',
  },
  fraud: {
    maxClicksPerIpPerMinute: parseInt(process.env.FRAUD_MAX_CLICKS_PER_IP_PER_MINUTE, 10) || 10,
    maxClicksPerIpPerHour: parseInt(process.env.FRAUD_MAX_CLICKS_PER_IP_PER_HOUR, 10) || 50,
    clickVelocityThresholdMs: parseInt(process.env.FRAUD_CLICK_VELOCITY_THRESHOLD_MS, 10) || 200,
    suspiciousUaPatterns: (process.env.FRAUD_SUSPICIOUS_UA_PATTERNS || 'bot,crawler,spider,scraper,headless')
      .split(',').map(s => s.trim().toLowerCase()),
    blockDurationMinutes: parseInt(process.env.FRAUD_BLOCK_DURATION_MINUTES, 10) || 60,
    autoBlockEnabled: process.env.FRAUD_AUTO_BLOCK_ENABLED !== 'false',
  },
  roi: {
    minCostThreshold: parseFloat(process.env.ROI_MIN_COST_THRESHOLD) || 5.0,
    targetCpa: parseFloat(process.env.ROI_TARGET_CPA) || 15.0,
    maxBidAdjustmentPct: parseInt(process.env.ROI_MAX_BID_ADJUSTMENT_PCT, 10) || 50,
    minBidAdjustmentPct: parseInt(process.env.ROI_MIN_BID_ADJUSTMENT_PCT, 10) || -30,
    checkIntervalMinutes: parseInt(process.env.ROI_CHECK_INTERVAL_MINUTES, 10) || 5,
    conversionWindowDays: parseInt(process.env.ROI_CONVERSION_WINDOW_DAYS, 10) || 7,
  },
  calendar: {
    defaultTimezone: process.env.CALENDAR_DEFAULT_TIMEZONE || 'Europe/Paris',
    maxConcurrentCampaigns: parseInt(process.env.CALENDAR_MAX_CONCURRENT_CAMPAIGNS, 10) || 5,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/app.log',
  },
};

module.exports = config;
