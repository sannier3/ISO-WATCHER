/**
 * Configuration centralisée — toutes les variables d'environnement du projet.
 */

export const APP_VERSION = '0.2.0';

export function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function loadConfig() {
  const dbDriver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();

  return {
    appHost: process.env.APP_HOST || '0.0.0.0',
    appPort: Number(process.env.APP_PORT || 3088),
    intranetToken: process.env.INTRANET_SHARED_TOKEN || '',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    publicUiEnabled: parseBool(process.env.PUBLIC_UI_ENABLED, true),
    publicUi: {
      allowActions: parseBool(process.env.PUBLIC_UI_ALLOW_ACTIONS, false),
      actionsAutoAuth: parseBool(process.env.PUBLIC_UI_ACTIONS_AUTO_AUTH, false),
      restrictToPrivateNetwork: parseBool(process.env.PUBLIC_UI_RESTRICT_TO_PRIVATE_NETWORK, true)
    },
    adminUi: {
      enabled: parseBool(process.env.ADMIN_UI_ENABLED, true),
      authRequired: parseBool(process.env.ADMIN_UI_AUTH_REQUIRED, true),
      password: String(process.env.ADMIN_UI_PASSWORD || '').trim(),
      restrictToPrivateNetwork: parseBool(process.env.ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK, true)
    },
    db: {
      driver: dbDriver === 'mysql' ? 'mysql' : 'sqlite',
      sqlitePath: process.env.SQLITE_PATH || './data/iso-watcher.db',
      mysql: {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'iso_watcher',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'iso_watcher',
        connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10)
      }
    },
    storage: {
      enabled: parseBool(process.env.STORAGE_ENABLED, false),
      root: process.env.STORAGE_ROOT || './data/storage',
      useSubfolders: parseBool(process.env.STORAGE_USE_SUBFOLDERS, true),
      downloadOnDetect: parseBool(process.env.STORAGE_DOWNLOAD_ON_DETECT, true),
      replaceOldFiles: parseBool(process.env.STORAGE_REPLACE_OLD, true),
      maxParallelDownloads: clamp(Number(process.env.STORAGE_MAX_PARALLEL_DOWNLOADS || 2), 1, 10)
    },
    schedulerEnabled: parseBool(process.env.SCHEDULER_ENABLED, true),
    schedulerCron: process.env.SCHEDULER_CRON || '0 * * * *',
    /** interrupt | ignore — scans « running » laissés par un arrêt/crash du processus */
    scanStartupRecovery: String(process.env.SCAN_STARTUP_RECOVERY || 'interrupt').toLowerCase(),
    smtp: {
      host: process.env.SMTP_HOST || '127.0.0.1',
      port: Number(process.env.SMTP_PORT || 25),
      secure: parseBool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      ignoreTls: parseBool(process.env.SMTP_IGNORE_TLS, false),
      requireTls: parseBool(process.env.SMTP_REQUIRE_TLS, false),
      tlsRejectUnauthorized: parseBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
      fromName: process.env.SMTP_FROM_NAME || 'ISO Watcher',
      fromAddress: process.env.SMTP_FROM_ADDRESS || 'iso-watcher@localhost'
    },
    timeouts: {
      httpMs: Number(process.env.HTTP_TIMEOUT_MS || 30000),
      ftpMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      downloadMs: Number(process.env.STORAGE_DOWNLOAD_TIMEOUT_MS || 7200000)
    },
    limits: {
      maxParallelSources: Number(process.env.MAX_PARALLEL_SOURCES || 5),
      /** 0 = illimité (pas de purge en base) */
      maxScanLogLines: clamp(Number(process.env.SCAN_MAX_LOG_LINES ?? 2000), 0, 500000),
      /** 0 = illimité pour log_excerpt sur scan_run_sources */
      maxScanLogExcerpt: clamp(Number(process.env.SCAN_LOG_EXCERPT_CHARS ?? 32000), 0, 2000000),
      maxScanLogMessage: clamp(Number(process.env.SCAN_LOG_MAX_MESSAGE_CHARS ?? 16000), 256, 64000),
      scanLogPruneBatch: clamp(Number(process.env.SCAN_LOG_PRUNE_BATCH || 200), 10, 5000),
      /** debug | info | warn | error — niveau minimum enregistré en base */
      scanLogMinLevel: String(process.env.SCAN_LOG_MIN_LEVEL || 'debug').toLowerCase(),
      scanLogApiDefaultLimit: clamp(Number(process.env.SCAN_LOG_API_DEFAULT_LIMIT || 2000), 1, 100000),
      /** 0 = pas de plafond côté API (jusqu'à 100000) */
      scanLogApiMaxLimit: clamp(Number(process.env.SCAN_LOG_API_MAX_LIMIT ?? 10000), 0, 100000),
      discordMaxEmbedsPerMessage: Number(process.env.DISCORD_MAX_EMBEDS_PER_MESSAGE || 10),
      discordMaxEmbedChars: Number(process.env.DISCORD_MAX_EMBED_TOTAL_CHARS || 6000),
      discordMaxMessagesPerMinute: Number(process.env.DISCORD_MAX_MESSAGES_PER_MINUTE || 30),
      teamsMaxPayloadBytes: Number(process.env.TEAMS_MAX_PAYLOAD_BYTES || 28672),
      teamsMaxRequestsPerSecond: Number(process.env.TEAMS_MAX_REQUESTS_PER_SECOND || 4),
      maxDeliveryAttempts: Number(process.env.MAX_DELIVERY_ATTEMPTS || 8)
    },
    digest: {
      dailyHour: Number(process.env.DIGEST_DAILY_HOUR || 8),
      deliveryCron: process.env.DELIVERY_CRON || '*/5 * * * *'
    },
    admin: {
      email: String(process.env.ADMIN_EMAIL || '').trim(),
      instantNotify: parseBool(process.env.ADMIN_INSTANT_NOTIFY, true)
    },
    linkCheck: {
      enabled: parseBool(process.env.LINK_CHECK_ENABLED, true),
      cron: process.env.LINK_CHECK_CRON || '0 4 * * *',
      concurrency: clamp(Number(process.env.LINK_CHECK_CONCURRENCY || 5), 1, 20),
      reportHours: clamp(Number(process.env.LINK_CHECK_REPORT_HOURS || 24), 1, 168)
    },
    security: {
      trustProxy: parseBool(process.env.TRUST_PROXY, false),
      cookieSecure: parseBool(process.env.UI_SESSION_COOKIE_SECURE, false),
      cookieSameSite: String(process.env.UI_SESSION_COOKIE_SAME_SITE || 'lax').toLowerCase(),
      sessionMaxAgeMs: Number(process.env.UI_SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
      loginMaxAttempts: clamp(Number(process.env.LOGIN_MAX_ATTEMPTS || 5), 1, 50),
      loginWindowMs: Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000),
      loginLockoutMs: Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000),
      apiRateLimitMax: clamp(Number(process.env.API_RATE_LIMIT_MAX || 300), 30, 5000),
      apiRateLimitWindowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000),
      hstsEnabled: parseBool(process.env.SECURITY_HSTS_ENABLED, false),
      cspReportOnly: parseBool(process.env.CSP_REPORT_ONLY, false)
    }
  };
}
