import 'dotenv/config';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import * as ftp from 'basic-ftp';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { APP_VERSION, loadConfig, parseBool, clamp } from './lib/config.js';
import { createDatabase, sqlDetectedSince } from './lib/database.js';
import { createFileStorage } from './lib/storage.js';
import cookie from '@fastify/cookie';
import { createApiRateLimiter } from './lib/api-rate-limit.js';
import { createLoginGuard, sendRateLimited } from './lib/login-guard.js';
import { buildHelmetOptions, timingSafeEqualString } from './lib/security-utils.js';
import {
  clearUiSessionCookie,
  resolveUiSessionToken,
  setUiSessionCookie
} from './lib/ui-cookie.js';
import { createUiSessionStore, assertPrivateNetwork, getClientIp } from './lib/ui-session.js';
import { createPresetsService } from './lib/presets.js';
import { createAdminNotify } from './lib/admin-notify.js';
import {
  DESTINATION_TYPES,
  sendDestinationPush,
  validateDestinationPayload,
  maskDestinationTarget,
  buildReleasePlainText,
  buildReleaseNotificationTitle,
  escapeHtml as notifyEscapeHtml,
  formatFileSize as notifyFormatFileSize,
  truncate as notifyTruncate
} from './lib/notify-channels.js';
import { parseLocale, t, localeBcp47 } from './lib/locale.js';

/** Sous-dossiers à explorer quand discovery_regex est vide (exclut . et ..). */
const DEFAULT_DISCOVERY_REGEX = '^[^./][^/]+/$';

const SCAN_STARTUP_INTERRUPT_REASON =
  'Scan interrompu au redémarrage du service (processus précédent terminé).';

const SCAN_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SCAN_LOG_LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const serverLocale = parseLocale(config.defaultLanguage, 'fr');

let releaseLinkCheckRunning = false;

if (!config.intranetToken) {
  console.error('INTRANET_SHARED_TOKEN est obligatoire. Copiez .env.example vers .env et définissez un token.');
  process.exit(1);
}

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024 * 2,
  trustProxy: config.security.trustProxy
});

const { pool, driver: dbDriver } = await createDatabase(config, app.log);
const storage = createFileStorage(config, pool, app.log);
const uiSessions = createUiSessionStore(config.intranetToken);
const mailer = nodemailer.createTransport(buildSmtpTransportOptions());
const loginGuard = createLoginGuard({
  maxAttempts: config.security.loginMaxAttempts,
  windowMs: config.security.loginWindowMs,
  lockoutMs: config.security.loginLockoutMs
});
const apiRateLimit = createApiRateLimiter({
  max: config.security.apiRateLimitMax,
  windowMs: config.security.apiRateLimitWindowMs
});
const presetsService = createPresetsService({ rootDir: __dirname, config, pool });
const adminNotify = createAdminNotify({
  config,
  mailer,
  log: app.log,
  dataDir: path.join(__dirname, 'data')
});

function isAdminActor(request) {
  return request.actor?.type === 'admin';
}

function replyPresetError(reply, err) {
  const msg = err?.message || String(err);

  if (msg.startsWith('catalog_fetch_failed')) {
    return reply.code(502).send({ error: msg });
  }

  const statusByError = {
    preset_not_found: 404,
    presets_remote_url_missing: 400,
    iso_item_ids_required: 400,
    iso_items_not_found: 404,
    no_exportable_presets: 400,
    invalid_catalog_format: 500,
    unsupported_catalog_schema: 500,
    bundled_catalog_missing: 503,
    catalog_unavailable: 503
  };

  if (msg.startsWith('invalid_preset') || msg.startsWith('invalid_source')) {
    return reply.code(500).send({ error: msg });
  }

  return reply.code(statusByError[msg] || 500).send({ error: msg });
}

await app.register(cookie);
await app.register(helmet, buildHelmetOptions(config.security));

const corsOrigins = config.corsOrigin.split(',').map((item) => item.trim()).filter(Boolean);
const corsWildcard = corsOrigins.includes('*');

if (corsOrigins.length) {
  await app.register(cors, {
    origin: corsWildcard ? true : corsOrigins,
    credentials: !corsWildcard,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Intranet-Token', 'X-UI-Session', 'X-Actor-Username', 'X-Actor-Type', 'X-Public-Email']
  });
}

function loginGuardKey(request, scope) {
  return `${scope}:${getClientIp(request)}`;
}

function issueUiSession(reply, actor) {
  const token = uiSessions.issue(actor);
  setUiSessionCookie(reply, token, config.security);

  return {
    ok: true,
    ui_session: token,
    actor
  };
}

function isPublicPath(urlPath) {
  if (['/health', '/ready', '/version', '/', '/index.html', '/docs', '/admin', '/admin/'].includes(urlPath)) {
    return true;
  }

  if (urlPath.startsWith('/ui/') || urlPath.startsWith('/admin/') || urlPath.endsWith('.css') || urlPath.endsWith('.js')) {
    return true;
  }

  if (
    urlPath === '/api/v1/admin/ui-config'
    || urlPath === '/api/v1/admin/ui-login'
    || urlPath === '/api/v1/admin/ui-logout'
    || urlPath === '/api/v1/public/ui-config'
    || urlPath === '/api/v1/public/ui-session'
    || urlPath === '/api/v1/public/ui-logout'
  ) {
    return true;
  }

  return !urlPath.startsWith('/api/v1');
}

app.addHook('preHandler', async (request, reply) => {
  const urlPath = request.url.split('?')[0];

  if (urlPath.startsWith('/api/v1')) {
    const apiLimit = apiRateLimit(`api:${getClientIp(request)}`);

    if (!apiLimit.allowed) {
      reply.header('Retry-After', String(apiLimit.retryAfterSec));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: 'Trop de requêtes API. Réessayez plus tard.',
        retry_after_seconds: apiLimit.retryAfterSec
      });
    }
  }

  if (isPublicPath(urlPath)) {
    return;
  }

  if (request.method === 'GET' && urlPath === '/api/v1/releases/recent') {
    const qs = new URL(request.url, 'http://127.0.0.1').searchParams;

    if (qs.get('public') === 'true') {
      request.actor = { username: 'public', type: 'public' };
      return;
    }
  }

  const uiSessionRaw = resolveUiSessionToken(request);

  if (uiSessionRaw) {
    const actor = uiSessions.verify(uiSessionRaw);

    if (!actor) {
      return reply.code(401).send({ error: 'invalid_ui_session' });
    }

    request.actor = actor;
    request.authVia = 'ui_session';
    return;
  }

  const token = request.headers['x-intranet-token'];

  if (!token || !timingSafeEqualString(token, config.intranetToken)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  request.actor = {
    username: String(request.headers['x-actor-username'] || 'system'),
    type: String(request.headers['x-actor-type'] || 'internal')
  };
});

if (config.publicUiEnabled) {
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/ui/'
  });

  app.get('/', async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  app.get('/docs', async (_request, reply) => {
    return reply.sendFile('api.html', path.join(__dirname, 'docs'));
  });

  app.get('/docs/API.md', async (_request, reply) => {
    return reply
      .type('text/markdown; charset=utf-8')
      .sendFile('API.md', path.join(__dirname, 'docs'));
  });

  app.get('/docs/API.en.md', async (_request, reply) => {
    return reply
      .type('text/markdown; charset=utf-8')
      .sendFile('API.en.md', path.join(__dirname, 'docs'));
  });

  if (config.adminUi.enabled) {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, 'public', 'admin'),
      prefix: '/admin/',
      decorateReply: false
    });

    app.get('/admin', async (_request, reply) => {
      return reply.sendFile('index.html', path.join(__dirname, 'public', 'admin'));
    });
  }
}

app.addHook('onResponse', async (request, reply) => {
  if (!request.url.startsWith('/api/v1')) return;

  app.log.info({
    event: 'iso_watcher_api',
    method: request.method,
    url: request.url,
    status_code: reply.statusCode,
    actor: request.actor?.username,
    actor_type: request.actor?.type,
    response_time_ms: reply.elapsedTime
  }, 'Requête API ISO Watcher');
});

registerRoutes();

if (config.schedulerEnabled) {
  cron.schedule(config.schedulerCron, async () => {
    app.log.info('Démarrage du scan planifié');
    try {
      await runScan({ triggerType: 'scheduler', notify: true });
      await sendPendingDeliveries();
    } catch (error) {
      app.log.error(error, 'Erreur pendant le scan planifié');
    }
  });

  cron.schedule(config.digest.deliveryCron, async () => {
    try {
      const result = await sendPendingDeliveries();
      if (result.processed_groups > 0) {
        app.log.info(result, 'Notifications planifiées traitées');
      }
    } catch (error) {
      app.log.error(error, 'Erreur envoi notifications planifiées');
    }
  });
}

if (config.linkCheck.enabled) {
  cron.schedule(config.linkCheck.cron, async () => {
    app.log.info('Démarrage de la vérification quotidienne des liens de releases');
    try {
      const result = await runReleaseLinkValidation({ sendAdminReport: true });
      app.log.info(result, 'Vérification des liens de releases terminée');
    } catch (error) {
      app.log.error(error, 'Erreur vérification des liens de releases');
    }
  });
}

app.setErrorHandler((error, request, reply) => {
  if (reply.sent) return;

  const statusCode = Number(error.statusCode) >= 400 ? Number(error.statusCode) : 500;
  const urlPath = request.url.split('?')[0];
  const isNotificationRoute = urlPath.includes('/notifications/') || urlPath.includes('/destinations/') && urlPath.endsWith('/test');

  const payload = isNotificationRoute
    ? deliveryErrorPayload(error, { channel: 'api' })
    : {
      error: 'api_error',
      message: String(error.message || error || 'Erreur interne')
    };

  app.log.error({
    err: error,
    url: request.url,
    method: request.method,
    ...payload
  }, 'Erreur API ISO Watcher');

  reply.code(statusCode >= 500 ? 502 : statusCode).send(payload);
});

app.log.info({
  smtp_host: config.smtp.host,
  smtp_port: config.smtp.port,
  smtp_secure: config.smtp.secure,
  smtp_ignore_tls: config.smtp.ignoreTls,
  smtp_require_tls: config.smtp.requireTls
}, 'Configuration SMTP');

const startupScanRecovery = await recoverOrphanedScansOnStartup();
if (startupScanRecovery.recovered > 0) {
  app.log.warn(startupScanRecovery, 'Scans orphelins marqués interrompus au démarrage');
}

await app.listen({ host: config.appHost, port: config.appPort });

function buildSmtpTransportOptions() {
  const options = {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: config.smtp.requireTls,
    ignoreTLS: config.smtp.ignoreTls
  };

  // SMTP en clair : ignoreTLS=true évite STARTTLS même si le serveur le propose.
  if (!config.smtp.ignoreTls) {
    options.tls = {
      rejectUnauthorized: config.smtp.tlsRejectUnauthorized
    };
  }

  if (config.smtp.user) {
    options.auth = {
      user: config.smtp.user,
      pass: config.smtp.pass
    };
  }

  return options;
}

function deliveryErrorPayload(error, { channel = null } = {}) {
  const code = error?.code || 'delivery_error';
  const message = String(error?.message || error || 'Erreur d\'envoi');

  return {
    error: 'delivery_failed',
    channel,
    code,
    message
  };
}

function registerRoutes() {
  app.get('/health', async () => {
    const storageFs = await storage.checkFilesystemAccess();
    const storageOk = !storageFs.enabled || storageFs.ok;

    return {
      ok: storageOk,
      version: APP_VERSION,
      db_driver: dbDriver,
      storage_enabled: config.storage.enabled,
      storage: storageFs
    };
  });

  app.get('/ready', async () => {
    await pool.query('SELECT 1 AS ok');
    return { ok: true, db_driver: dbDriver, version: APP_VERSION };
  });

  app.get('/version', async () => ({ version: APP_VERSION, db_driver: dbDriver }));

  app.get('/api/v1/config/public', async () => ({
    version: APP_VERSION,
    db_driver: dbDriver,
    storage_enabled: config.storage.enabled,
    storage_use_subfolders: config.storage.useSubfolders,
    ui_enabled: config.publicUiEnabled,
    public_actions_enabled: config.publicUi.allowActions,
    public_actions_auto_auth: config.publicUi.actionsAutoAuth,
    admin_ui_enabled: config.adminUi.enabled,
    admin_ui_auth_required: config.adminUi.authRequired
  }));

  app.get('/api/v1/public/ui-config', async () => ({
    version: APP_VERSION,
    db_driver: dbDriver,
    default_language: serverLocale,
    public_actions_enabled: config.publicUi.allowActions,
    public_actions_auto_auth: config.publicUi.actionsAutoAuth,
    admin_ui_enabled: config.adminUi.enabled,
    admin_ui_auth_required: config.adminUi.authRequired,
    link_check_enabled: config.linkCheck.enabled,
    scheduler_enabled: config.schedulerEnabled
  }));

  app.post('/api/v1/public/ui-session', async (request, reply) => {
    if (!config.publicUi.allowActions) {
      return reply.code(403).send({ error: 'public_actions_disabled' });
    }

    if (!config.publicUi.actionsAutoAuth) {
      return reply.code(400).send({ error: 'auto_auth_disabled' });
    }

    if (!assertPrivateNetwork(request, reply, { enabled: config.publicUi.restrictToPrivateNetwork })) {
      return;
    }

    const guardKey = loginGuardKey(request, 'public-session');
    const guard = loginGuard.check(guardKey);

    if (!guard.allowed) {
      return sendRateLimited(reply, guard.retryAfterSec);
    }

    const actor = { username: 'operator', type: 'internal' };
    loginGuard.recordSuccess(guardKey);

    return issueUiSession(reply, actor);
  });

  app.post('/api/v1/public/ui-logout', async (_request, reply) => {
    clearUiSessionCookie(reply, config.security);
    return { ok: true };
  });

  app.get('/api/v1/admin/ui-config', async () => ({
    version: APP_VERSION,
    db_driver: dbDriver,
    default_language: serverLocale,
    admin_ui_enabled: config.adminUi.enabled,
    auth_required: config.adminUi.authRequired,
    storage_enabled: config.storage.enabled,
    scheduler_enabled: config.schedulerEnabled,
    link_check_enabled: config.linkCheck.enabled
  }));

  app.post('/api/v1/admin/ui-login', async (request, reply) => {
    if (!config.adminUi.enabled) {
      return reply.code(503).send({ error: 'admin_ui_disabled' });
    }

    if (!assertPrivateNetwork(request, reply, { enabled: config.adminUi.restrictToPrivateNetwork })) {
      return;
    }

    const guardKey = loginGuardKey(request, 'admin-login');
    const guard = loginGuard.check(guardKey);

    if (!guard.allowed) {
      return sendRateLimited(reply, guard.retryAfterSec);
    }

    const password = String(request.body?.password || '');

    if (config.adminUi.authRequired) {
      const expected = config.adminUi.password || config.intranetToken;

      if (!expected || !timingSafeEqualString(password, expected)) {
        loginGuard.recordFailure(guardKey);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
    }

    loginGuard.recordSuccess(guardKey);
    const actor = { username: 'admin', type: 'admin' };

    return issueUiSession(reply, actor);
  });

  app.post('/api/v1/admin/ui-logout', async (_request, reply) => {
    clearUiSessionCookie(reply, config.security);
    return { ok: true };
  });

  app.get('/api/v1/admin/overview', async (request, reply) => {
    if (request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'admin_required' });
    }

    const [[isoCount]] = await pool.query('SELECT COUNT(*) AS c FROM iso_items');
    const [[releaseCount]] = await pool.query('SELECT COUNT(*) AS c FROM iso_releases');
    const [[userCount]] = await pool.query('SELECT COUNT(*) AS c FROM users');
    const [recentScans] = await pool.query(
      'SELECT id, status, trigger_type, started_at, finished_at, new_releases, total_sources, completed_sources FROM scan_runs ORDER BY id DESC LIMIT 8'
    );

    let storageStatus = null;

    try {
      storageStatus = await storage.getStorageStatus();
    } catch {
      storageStatus = { enabled: config.storage.enabled };
    }

    return {
      version: APP_VERSION,
      db_driver: dbDriver,
      counts: {
        iso_items: Number(isoCount?.c || 0),
        releases: Number(releaseCount?.c || 0),
        users: Number(userCount?.c || 0)
      },
      recent_scans: recentScans,
      storage: storageStatus,
      config: {
        storage_enabled: config.storage.enabled,
        scheduler_enabled: config.schedulerEnabled,
        scheduler_cron: config.schedulerCron,
        link_check_enabled: config.linkCheck.enabled,
        admin_email: config.admin.email,
        admin_notify: adminNotify.getPublicConfig()
      }
    };
  });

  app.get('/api/v1/admin/notify-config', async (request, reply) => {
    if (request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'admin_required' });
    }

    return adminNotify.getPublicConfig();
  });

  app.get('/api/v1/admin/reports', async (request, reply) => {
    if (request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'admin_required' });
    }

    const limit = clamp(Number(request.query.limit || 20), 1, 50);
    const type = request.query.type ? String(request.query.type) : undefined;

    return {
      reports: adminNotify.listReports({ limit, type })
    };
  });

  app.get('/api/v1/admin/reports/:reportId', async (request, reply) => {
    if (request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'admin_required' });
    }

    const report = adminNotify.getReport(request.params.reportId);

    if (!report) {
      return reply.code(404).send({ error: 'report_not_found' });
    }

    return report;
  });

  app.get('/api/v1/admin/users', async (request, reply) => {
    if (request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'admin_required' });
    }

    const limit = clamp(Number(request.query.limit || 100), 1, 500);
    const [rows] = await pool.query(
      'SELECT id, user_type, username, email, display_name, external_ref, created_at FROM users ORDER BY id DESC LIMIT ?',
      [limit]
    );

    return rows;
  });

  app.get('/api/v1/storage/status', async (request, reply) => {
    if (request.actor?.type !== 'admin' && request.actor?.type !== 'internal') {
      return reply.code(403).send({ error: 'forbidden' });
    }

    return storage.getStorageStatus();
  });

  app.get('/api/v1/destination-types', async () => DESTINATION_TYPES);

  app.post('/api/v1/users/upsert', async (request) => {
    return upsertUser({ ...request.body, created_by_username: request.actor.username });
  });

  app.get('/api/v1/users/:userId', async (request, reply) => {
    const user = await getOne('SELECT * FROM users WHERE id = ?', [request.params.userId]);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });
    return user;
  });

  app.get('/api/v1/public/users/by-email', async (request, reply) => {
    const email = normalizeEmail(request.query.email);
    if (!email) return reply.code(400).send({ error: 'email_required' });
    const user = await getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', ['public', email]);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });
    return user;
  });

  app.delete('/api/v1/public/users/by-email', async (request, reply) => {
    const email = normalizeEmail(request.query.email);
    if (!email) return reply.code(400).send({ error: 'email_required' });
    const user = await getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', ['public', email]);
    if (!user) return { deleted: false, reason: 'not_found' };

    const count = await getOne('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ? AND enabled = TRUE', [user.id]);
    if (Number(count.count) > 0) return reply.code(409).send({ error: 'user_has_active_subscriptions' });

    await pool.query('DELETE FROM users WHERE id = ?', [user.id]);
    return { deleted: true };
  });

  app.get('/api/v1/presets/catalog/meta', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      return presetsService.getCatalogMeta();
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/presets', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      return await presetsService.listPresets({ q: request.query.q, tag: request.query.tag });
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/presets/drift-updates', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      return await presetsService.listPresetDriftUpdates();
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/presets/:presetId/drift', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      const drift = await presetsService.getPresetDrift(request.params.presetId);

      if (!drift) {
        return reply.code(404).send({ error: 'preset_not_found' });
      }

      return drift;
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/presets/:presetId', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      const preset = presetsService.getPreset(request.params.presetId);
      if (!preset) return reply.code(404).send({ error: 'preset_not_found' });
      return preset;
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/presets/exportable', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      return await presetsService.listExportableIsoItems({
        onlyWithOkSources: request.query.only_ok !== 'false'
      });
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.post('/api/v1/presets/catalog/build', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      const ids = request.body?.iso_item_ids;

      if (!Array.isArray(ids) || !ids.length) {
        return reply.code(400).send({ error: 'iso_item_ids_required' });
      }

      return await presetsService.buildCatalogFromSelection({
        isoItemIds: ids,
        onlyOkSources: request.body?.only_ok_sources !== false,
        catalogId: request.body?.catalog_id || 'iso-watcher-community'
      });
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.post('/api/v1/presets/catalog/refresh', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      const url = request.body?.url || config.presets.remoteUrl;
      return await presetsService.refreshFromRemote(url);
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.post('/api/v1/presets/:presetId/apply', async (request, reply) => {
    if (!isAdminActor(request)) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    try {
      const result = await presetsService.applyPreset(request.params.presetId, {
        mode: request.body?.mode || 'import',
        created_by_user_id: request.body?.created_by_user_id || null,
        catalog_source: request.body?.catalog_source || presetsService.getActiveCatalogKind()
      });

      if (request.body?.run_scan) {
        const scan = await startScanAsync({
          isoItemId: result.iso_item_id,
          triggerType: 'manual',
          notify: request.body?.notify !== false
        });
        result.scan = scan;
      }

      return result;
    } catch (err) {
      return replyPresetError(reply, err);
    }
  });

  app.get('/api/v1/iso-items', async (request) => {
    const filters = [];
    const params = [];

    addFilter(filters, params, 'distribution', request.query.distribution);
    addFilter(filters, params, 'architecture', request.query.architecture);
    addBoolFilter(filters, params, 'enabled', request.query.enabled);
    addBoolFilter(filters, params, 'is_public', request.query.public);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT * FROM iso_items ${where} ORDER BY distribution, name`, params);

    if (request.actor?.type === 'admin' && parseBool(request.query.include_catalog_drift)) {
      const enriched = [];

      for (const row of rows) {
        const item = { ...row };
        const drift = await presetsService.getDriftForIsoItem(row);

        if (drift) {
          item.catalog_drift = drift;
          item.catalog_update_available = Boolean(drift.content_drift);
          item.catalog_linking_recommended = Boolean(drift.linking_recommended);
          item.catalog_drift_summary = drift.summary || null;
        }

        enriched.push(item);
      }

      return enriched;
    }

    return rows;
  });

  app.post('/api/v1/iso-items', async (request) => {
    const body = request.body;

    const [result] = await pool.query(
      `INSERT INTO iso_items
       (name, system_family, distribution, edition, version_track, architecture, file_type, description, enabled, is_public, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name,
        body.system_family || null,
        body.distribution || null,
        body.edition || null,
        body.version_track || null,
        body.architecture || 'amd64',
        body.file_type || 'iso',
        body.description || null,
        body.enabled !== false,
        body.is_public !== false,
        body.created_by_user_id || null
      ]
    );

    const item = await getIsoItem(result.insertId);

    await pool.query(
      'UPDATE iso_items SET catalog_source = ? WHERE id = ? AND catalog_source IS NULL',
      ['manual', item.id]
    );

    return getIsoItem(item.id);
  });

  app.get('/api/v1/iso-items/:isoItemId', async (request, reply) => {
    const item = await getIsoItem(request.params.isoItemId);
    if (!item) return reply.code(404).send({ error: 'iso_item_not_found' });
    return item;
  });

  app.patch('/api/v1/iso-items/:isoItemId', async (request, reply) => {
    await patchTable('iso_items', 'id', request.params.isoItemId, [
      'name',
      'system_family',
      'distribution',
      'edition',
      'version_track',
      'architecture',
      'file_type',
      'description',
      'enabled',
      'is_public'
    ], request.body);

    const item = await getIsoItem(request.params.isoItemId);
    if (!item) return reply.code(404).send({ error: 'iso_item_not_found' });
    return item;
  });

  app.post('/api/v1/iso-items/:isoItemId/disable', async (request) => setIsoItemEnabled(request.params.isoItemId, false));

  app.post('/api/v1/iso-items/:isoItemId/enable', async (request) => setIsoItemEnabled(request.params.isoItemId, true));

  app.delete('/api/v1/iso-items/:isoItemId', async (request) => {
    await pool.query('DELETE FROM iso_items WHERE id = ?', [request.params.isoItemId]);
    return { deleted: true };
  });

  app.get('/api/v1/iso-items/:isoItemId/sources', async (request) => {
    const [rows] = await pool.query(
      'SELECT * FROM iso_sources WHERE iso_item_id = ? ORDER BY priority ASC, id ASC',
      [request.params.isoItemId]
    );
    return rows;
  });

  app.post('/api/v1/iso-items/:isoItemId/sources', async (request, reply) => {
    const body = request.body;
    const protocol = body.protocol || detectProtocol(body.url);

    const discovery = parseDiscoveryFields(body);

    if (discovery.discovery_enabled && !discovery.discovery_regex) {
      return reply.code(400).send({ error: 'discovery_regex_required' });
    }

    validateDiscoveryRegex(discovery.discovery_regex);

    const [result] = await pool.query(
      `INSERT INTO iso_sources
       (iso_item_id, name, protocol, url, allow_insecure_tls, ftp_passive, match_regex, version_regex, checksum_regex,
        discovery_enabled, discovery_depth, discovery_regex, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.params.isoItemId,
        body.name,
        protocol,
        body.url,
        Boolean(body.allow_insecure_tls),
        body.ftp_passive !== false,
        body.match_regex,
        body.version_regex || null,
        body.checksum_regex || null,
        discovery.discovery_enabled,
        discovery.discovery_depth,
        discovery.discovery_regex,
        Number(body.priority || 100),
        body.enabled !== false
      ]
    );

    const source = await getSource(result.insertId);

    await pool.query(
      `UPDATE iso_sources SET catalog_source = 'manual'
       WHERE id = ? AND catalog_source IS NULL`,
      [source.id]
    );

    return getSource(source.id);
  });

  app.patch('/api/v1/sources/:sourceId', async (request, reply) => {
    const body = { ...request.body };

    if (Object.hasOwn(body, 'discovery_enabled') || Object.hasOwn(body, 'discovery_depth') || Object.hasOwn(body, 'discovery_regex')) {
      const current = await getSource(request.params.sourceId);
      if (!current) return reply.code(404).send({ error: 'source_not_found' });

      const discovery = parseDiscoveryFields({
        discovery_enabled: Object.hasOwn(body, 'discovery_enabled') ? body.discovery_enabled : current.discovery_enabled,
        discovery_depth: Object.hasOwn(body, 'discovery_depth') ? body.discovery_depth : current.discovery_depth,
        discovery_regex: Object.hasOwn(body, 'discovery_regex') ? body.discovery_regex : current.discovery_regex
      });

      if (discovery.discovery_enabled && !discovery.discovery_regex) {
        return reply.code(400).send({ error: 'discovery_regex_required' });
      }

      validateDiscoveryRegex(discovery.discovery_regex);
      body.discovery_enabled = discovery.discovery_enabled;
      body.discovery_depth = discovery.discovery_depth;
      body.discovery_regex = discovery.discovery_regex;
    }

    await patchTable('iso_sources', 'id', request.params.sourceId, [
      'name',
      'protocol',
      'url',
      'allow_insecure_tls',
      'ftp_passive',
      'match_regex',
      'version_regex',
      'checksum_regex',
      'discovery_enabled',
      'discovery_depth',
      'discovery_regex',
      'priority',
      'enabled'
    ], body);

    const source = await getSource(request.params.sourceId);
    if (!source) return reply.code(404).send({ error: 'source_not_found' });
    return source;
  });

  app.post('/api/v1/sources/:sourceId/test', async (request, reply) => {
    const source = await getSource(request.params.sourceId);
    if (!source) return reply.code(404).send({ error: 'source_not_found' });
    return testSource(source);
  });

  app.post('/api/v1/sources/:sourceId/scan', async (request) => {
    return startScanAsync({
      sourceId: request.params.sourceId,
      triggerType: 'manual',
      notify: request.body?.notify !== false,
      triggeredByUserId: request.body?.triggered_by_user_id || null
    });
  });

  app.post('/api/v1/sources/:sourceId/disable', async (request) => setSourceEnabled(request.params.sourceId, false));

  app.post('/api/v1/sources/:sourceId/enable', async (request) => setSourceEnabled(request.params.sourceId, true));

  app.delete('/api/v1/sources/:sourceId', async (request) => {
    await pool.query('DELETE FROM iso_sources WHERE id = ?', [request.params.sourceId]);
    return { deleted: true };
  });

  app.get('/api/v1/iso-items/:isoItemId/latest', async (request, reply) => {
    const release = await getOne(
      'SELECT * FROM iso_releases WHERE iso_item_id = ? AND is_latest = TRUE ORDER BY detected_at DESC LIMIT 1',
      [request.params.isoItemId]
    );

    if (!release) return reply.code(404).send({ error: 'release_not_found' });
    return release;
  });

  app.get('/api/v1/iso-items/:isoItemId/download', async (request, reply) => {
    const release = await getOne(
      `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition, i.version_track
       FROM iso_releases r
       JOIN iso_items i ON i.id = r.iso_item_id
       WHERE r.iso_item_id = ? AND r.is_latest = TRUE
       ORDER BY r.detected_at DESC
       LIMIT 1`,
      [request.params.isoItemId]
    );

    if (!release) {
      return reply.code(404).send({
        error: 'download_not_found'
      });
    }

    return {
      iso_item_id: release.iso_item_id,
      source_id: release.source_id,
      name: release.iso_name,
      distribution: release.distribution,
      edition: release.edition,
      version_track: release.version_track,
      architecture: release.architecture,
      version: release.version,
      filename: release.filename,
      download_url: release.url,
      checksum_url: release.checksum_url,
      checksum_sha256: release.checksum_sha256,
      file_size: release.file_size,
      published_at: release.published_at,
      detected_at: release.detected_at,
      is_latest: Boolean(release.is_latest)
    };
  });

  app.get('/api/v1/iso-items/:isoItemId/releases', async (request) => {
    const limit = clamp(Number(request.query.limit || 100), 1, 500);

    const [rows] = await pool.query(
      'SELECT * FROM iso_releases WHERE iso_item_id = ? ORDER BY detected_at DESC LIMIT ?',
      [request.params.isoItemId, limit]
    );

    return rows;
  });

  app.post('/api/v1/releases/:releaseId/download', async (request, reply) => {
    if (!config.storage.enabled) {
      return reply.code(503).send({ error: 'storage_disabled', message: 'STORAGE_ENABLED=false' });
    }

    const releaseId = Number(request.params.releaseId);

    if (!releaseId) {
      return reply.code(400).send({ error: 'invalid_release_id' });
    }

    try {
      const result = await storage.enqueueDownloadRelease(releaseId);

      if (!result.ok && result.error !== 'storage_disabled') {
        const code = result.error === 'release_not_found' ? 404 : 502;
        return reply.code(code).send(result);
      }

      if (!result.ok) {
        return reply.code(503).send(result);
      }

      return result;
    } catch (error) {
      request.log.error({ err: error, releaseId }, 'POST /releases/:id/download');

      return reply.code(502).send({
        error: 'download_failed',
        message: String(error.message || error)
      });
    }
  });

  app.get('/api/v1/releases/:releaseId/local-file', async (request, reply) => {
    const release = await getOne('SELECT * FROM iso_releases WHERE id = ?', [request.params.releaseId]);

    if (!release?.local_path) {
      return reply.code(404).send({ error: 'local_file_not_found' });
    }

    try {
      await fs.promises.access(release.local_path, fs.constants.R_OK);
    } catch {
      return reply.code(404).send({ error: 'local_file_missing' });
    }

    const stat = await fs.promises.stat(release.local_path);

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(release.filename)}"`)
      .header('Content-Length', stat.size)
      .send(fs.createReadStream(release.local_path));
  });

  app.get('/api/v1/releases/recent', async (request) => {
    const limit = clamp(Number(request.query.limit || 50), 1, 500);
    const filters = [];
    const params = [];

    addBoolFilter(filters, params, 'i.is_public', request.query.public);
    addBoolFilter(filters, params, 'i.enabled', request.query.enabled);
    addBoolFilter(filters, params, 'r.is_latest', request.query.latest);
    addFilter(filters, params, 'i.distribution', request.query.distribution);
    addFilter(filters, params, 'i.architecture', request.query.architecture);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition
       FROM iso_releases r
       JOIN iso_items i ON i.id = r.iso_item_id
       ${where}
       ORDER BY r.detected_at DESC
       LIMIT ?`,
      [...params, limit]
    );

    return rows;
  });

  app.post('/api/v1/admin/release-link-check', async (request, reply) => {
    const actorType = request.actor?.type;
    const canRun = actorType === 'admin'
      || (config.publicUi.allowActions && ['admin', 'internal'].includes(actorType));

    if (!canRun) {
      return reply.code(403).send({ error: 'admin_or_operator_required' });
    }

    if (releaseLinkCheckRunning) {
      return reply.code(409).send({ error: 'link_check_already_running' });
    }

    const result = await runReleaseLinkValidation({
      notifyChannels: Array.isArray(request.body?.notify_channels) ? request.body.notify_channels : undefined,
      sendAdminReport: request.body?.send_admin_report,
      reportHours: clamp(Number(request.body?.report_hours || config.linkCheck.reportHours), 1, 168)
    });

    return result;
  });

  app.post('/api/v1/scans/run', async (request, reply) => {
    if (!config.publicUi.allowActions && request.actor?.type !== 'admin') {
      return reply.code(403).send({ error: 'public_actions_disabled' });
    }

    return startScanAsync({
      triggerType: 'manual',
      notify: request.body?.notify !== false,
      triggeredByUserId: request.body?.triggered_by_user_id || null
    });
  });

  app.post('/api/v1/iso-items/:isoItemId/scan', async (request) => {
    return startScanAsync({
      isoItemId: request.params.isoItemId,
      triggerType: 'manual',
      notify: request.body?.notify !== false,
      triggeredByUserId: request.body?.triggered_by_user_id || null
    });
  });

  app.post('/api/v1/scans/test', async (request, reply) => {
    const source = request.body?.source_id ? await getSource(request.body.source_id) : null;
    if (!source) return reply.code(400).send({ error: 'source_id_required' });

    const testResult = await testSource(source);

    if (request.body?.send_test_notification && request.body?.destination_id) {
      const destination = await getDestination(request.body.destination_id);

      if (!destination) {
        return reply.code(404).send({
          error: 'destination_not_found',
          test_result: testResult
        });
      }

      await sendReleasesToDestination(destination, buildFakeReleaseRows(testResult.matches, source));
    }

    return testResult;
  });

  app.get('/api/v1/scans', async (request) => {
    const limit = clamp(Number(request.query.limit || 100), 1, 500);
    const [rows] = await pool.query('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?', [limit]);

    return rows.map((row) => {
      const total = Number(row.total_sources || 0);
      const completed = Number(row.completed_sources || 0);
      const isFinished = row.status !== 'running';

      return {
        ...row,
        is_finished: isFinished,
        progress_percent: total > 0
          ? Math.min(100, Math.round((completed / total) * 100))
          : (isFinished ? 100 : 0)
      };
    });
  });

  app.get('/api/v1/scans/:scanRunId', async (request, reply) => {
    const logLimit = resolveScanLogApiLimit(request.query.log_limit);
    const logSinceId = clamp(Number(request.query.log_since_id || 0), 0, Number.MAX_SAFE_INTEGER);
    const detail = await getScanRunDetail(request.params.scanRunId, { logLimit, logSinceId });

    if (!detail) return reply.code(404).send({ error: 'scan_not_found' });

    return detail;
  });

  app.get('/api/v1/scans/:scanRunId/logs', async (request, reply) => {
    const scanRunId = request.params.scanRunId;
    const exists = await getOne('SELECT id FROM scan_runs WHERE id = ?', [scanRunId]);

    if (!exists) return reply.code(404).send({ error: 'scan_not_found' });

    const logLimit = resolveScanLogApiLimit(request.query.limit);
    const logSinceId = clamp(Number(request.query.since_id || 0), 0, Number.MAX_SAFE_INTEGER);
    const detail = await getScanRunDetail(scanRunId, { logLimit, logSinceId });

    return {
      scan_run_id: Number(scanRunId),
      is_finished: detail.is_finished,
      status: detail.status,
      logs: detail.logs
    };
  });

  app.get('/api/v1/users/:userId/destinations', async (request, reply) => {
    if (!(await assertPublicOwnsUserId(request, reply, request.params.userId))) return;

    const [rows] = await pool.query(
      'SELECT * FROM destinations WHERE user_id = ? ORDER BY id DESC',
      [request.params.userId]
    );

    return rows;
  });

  app.post('/api/v1/users/:userId/destinations', async (request, reply) => {
    if (!(await assertPublicOwnsUserId(request, reply, request.params.userId))) return;

    const body = request.body;

    try {
      validateDestinationPayload(body.destination_type, body.target, body.config || {});
    } catch (error) {
      return reply.code(400).send({ error: 'invalid_destination', message: String(error.message || error) });
    }

    const [result] = await pool.query(
      `INSERT INTO destinations (user_id, destination_type, label, target, enabled, config)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        request.params.userId,
        body.destination_type,
        body.label || null,
        body.target,
        body.enabled !== false,
        JSON.stringify(body.config || {})
      ]
    );

    return getDestination(result.insertId);
  });

  app.patch('/api/v1/destinations/:destinationId', async (request, reply) => {
    if (!(await assertPublicOwnsDestination(request, reply, request.params.destinationId))) return;

    const body = { ...request.body };

    if (Object.hasOwn(body, 'config')) {
      body.config = JSON.stringify(body.config || {});
    }

    await patchTable('destinations', 'id', request.params.destinationId, [
      'destination_type',
      'label',
      'target',
      'enabled',
      'config'
    ], body);

    const destination = await getDestination(request.params.destinationId);
    if (!destination) return reply.code(404).send({ error: 'destination_not_found' });
    return destination;
  });

  app.post('/api/v1/destinations/:destinationId/test', async (request, reply) => {
    if (!(await assertPublicOwnsDestination(request, reply, request.params.destinationId))) return;

    const destination = await getDestination(request.params.destinationId);
    if (!destination) return reply.code(404).send({ error: 'destination_not_found' });

    const startedAt = Date.now();
    const testRelease = {
      id: 0,
      iso_name: 'ISO Watcher Test',
      distribution: 'test',
      architecture: 'amd64',
      version: '0.0.0-test',
      filename: 'iso-watcher-test.iso',
      url: 'https://example.local/iso-watcher-test.iso',
      detected_at: new Date().toISOString(),
      event_type: 'test',
      title: request.body?.message || 'Test ISO Watcher'
    };

    logNotificationEvent('destination_test_start', {
      destination_id: destination.id,
      destination_type: destination.destination_type,
      target: maskTargetForLog(destination)
    });

    try {
      const sendResult = await sendReleasesToDestination(destination, [testRelease], {
        notifyMode: 'immediate',
        isTest: true
      });

      logNotificationEvent('destination_test_success', {
        destination_id: destination.id,
        destination_type: destination.destination_type,
        target: maskTargetForLog(destination),
        duration_ms: Date.now() - startedAt,
        response_code: sendResult?.statusCode ?? null,
        release_count: 1
      });

      return { sent: true, channel: destination.destination_type };
    } catch (error) {
      logNotificationEvent('destination_test_failed', {
        destination_id: destination.id,
        destination_type: destination.destination_type,
        target: maskTargetForLog(destination),
        duration_ms: Date.now() - startedAt,
        error: String(error.message || error),
        response_code: error.statusCode ?? null,
        code: error.code ?? null
      });

      return reply.code(502).send(deliveryErrorPayload(error, {
        channel: destination.destination_type
      }));
    }
  });

  app.post('/api/v1/destinations/:destinationId/disable', async (request, reply) => {
    if (!(await assertPublicOwnsDestination(request, reply, request.params.destinationId))) return;
    return setDestinationEnabled(request.params.destinationId, false);
  });

  app.post('/api/v1/destinations/:destinationId/enable', async (request, reply) => {
    if (!(await assertPublicOwnsDestination(request, reply, request.params.destinationId))) return;
    return setDestinationEnabled(request.params.destinationId, true);
  });

  app.delete('/api/v1/destinations/:destinationId', async (request, reply) => {
    if (!(await assertPublicOwnsDestination(request, reply, request.params.destinationId))) return;
    await pool.query('DELETE FROM destinations WHERE id = ?', [request.params.destinationId]);
    return { deleted: true };
  });

  app.get('/api/v1/users/:userId/subscriptions', async (request) => {
    const [rows] = await pool.query(
      `SELECT s.*, i.name, i.distribution, i.architecture, i.edition, i.version_track
       FROM subscriptions s
       JOIN iso_items i ON i.id = s.iso_item_id
       WHERE s.user_id = ?
       ORDER BY i.distribution, i.name`,
      [request.params.userId]
    );

    return rows;
  });

  app.get('/api/v1/public/subscriptions', async (request, reply) => {
    const email = normalizeEmail(request.query.email);
    if (!email) return reply.code(400).send({ error: 'email_required' });

    const user = await getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', ['public', email]);
    if (!user) return [];

    const [rows] = await pool.query(
      `SELECT s.*, i.name, i.distribution, i.architecture, i.edition, i.version_track
       FROM subscriptions s
       JOIN iso_items i ON i.id = s.iso_item_id
       WHERE s.user_id = ?
       ORDER BY i.distribution, i.name`,
      [user.id]
    );

    return rows;
  });

  app.post('/api/v1/users/:userId/subscriptions', async (request) => {
    return upsertSubscription(
      request.params.userId,
      request.body.iso_item_id,
      request.body.notify_mode || 'immediate',
      request.body.enabled !== false
    );
  });

  app.post('/api/v1/public/subscriptions', async (request, reply) => {
    const email = normalizeEmail(request.body?.email);
    if (!email) return reply.code(400).send({ error: 'email_required' });

    const user = await upsertUser({
      user_type: 'public',
      email,
      username: null,
      external_ref: null,
      display_name: request.body?.display_name || email,
      created_by_username: request.actor.username
    });

    const isoIds = Array.isArray(request.body?.iso_item_ids) ? request.body.iso_item_ids : [];
    const subscriptions = [];

    for (const isoId of isoIds) {
      subscriptions.push(await upsertSubscription(
        user.id,
        isoId,
        request.body?.notify_mode || 'immediate',
        true
      ));
    }

    const destinations = [];
    const requestedDestinations = Array.isArray(request.body?.destinations) ? request.body.destinations : [];

    for (const destination of requestedDestinations) {
      const [result] = await pool.query(
        `INSERT INTO destinations (user_id, destination_type, label, target, enabled, config)
         VALUES (?, ?, ?, ?, TRUE, ?)`,
        [
          user.id,
          destination.destination_type,
          destination.label || null,
          destination.target,
          JSON.stringify(destination.config || {})
        ]
      );

      destinations.push(await getDestination(result.insertId));
    }

    return { user, subscriptions, destinations };
  });

  app.patch('/api/v1/subscriptions/:subscriptionId', async (request, reply) => {
    await patchTable('subscriptions', 'id', request.params.subscriptionId, ['enabled', 'notify_mode'], request.body);

    const row = await getOne('SELECT * FROM subscriptions WHERE id = ?', [request.params.subscriptionId]);
    if (!row) return reply.code(404).send({ error: 'subscription_not_found' });

    return row;
  });

  app.delete('/api/v1/subscriptions/:subscriptionId', async (request) => {
    await pool.query('DELETE FROM subscriptions WHERE id = ?', [request.params.subscriptionId]);
    return { deleted: true };
  });

  app.delete('/api/v1/public/subscriptions', async (request, reply) => {
    const email = normalizeEmail(request.body?.email);
    if (!email) return reply.code(400).send({ error: 'email_required' });

    const user = await getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', ['public', email]);
    if (!user) return { deleted: 0 };

    const isoIds = Array.isArray(request.body?.iso_item_ids) ? request.body.iso_item_ids : [];
    if (!isoIds.length) return reply.code(400).send({ error: 'iso_item_ids_required' });

    const placeholders = isoIds.map(() => '?').join(',');

    const [result] = await pool.query(
      `DELETE FROM subscriptions WHERE user_id = ? AND iso_item_id IN (${placeholders})`,
      [user.id, ...isoIds]
    );

    return { deleted: result.affectedRows };
  });

  app.get('/api/v1/notifications/events', async (request) => {
    const limit = clamp(Number(request.query.limit || 100), 1, 500);

    const [rows] = await pool.query(
      `SELECT e.*, r.version, r.filename, r.url, i.name AS iso_name
       FROM notification_events e
       JOIN iso_releases r ON r.id = e.iso_release_id
       JOIN iso_items i ON i.id = r.iso_item_id
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows;
  });

  app.get('/api/v1/notifications/events/:eventId', async (request, reply) => {
    const event = await getOne(
      `SELECT e.*, r.version, r.filename, r.url, i.name AS iso_name
       FROM notification_events e
       JOIN iso_releases r ON r.id = e.iso_release_id
       JOIN iso_items i ON i.id = r.iso_item_id
       WHERE e.id = ?`,
      [request.params.eventId]
    );

    if (!event) return reply.code(404).send({ error: 'event_not_found' });
    return event;
  });

  app.get('/api/v1/notifications/deliveries', async (request) => {
    const filters = [];
    const params = [];

    addFilter(filters, params, 'd.status', request.query.status);
    addFilter(filters, params, 'd.destination_id', request.query.destination_id);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT d.*, dest.destination_type, dest.label, dest.target
       FROM notification_deliveries d
       JOIN destinations dest ON dest.id = d.destination_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT 500`,
      params
    );

    return rows;
  });

  app.post('/api/v1/notifications/deliveries/:deliveryId/retry', async (request, reply) => {
    await pool.query(
      'UPDATE notification_deliveries SET status = ?, next_retry_at = NULL, error_message = NULL WHERE id = ?',
      ['pending', request.params.deliveryId]
    );

    await sendPendingDeliveries();

    const row = await getOne('SELECT * FROM notification_deliveries WHERE id = ?', [request.params.deliveryId]);
    if (!row) return reply.code(404).send({ error: 'delivery_not_found' });

    return row;
  });

  app.post('/api/v1/notifications/test', async (request, reply) => {
    const destination = await getDestination(request.body?.destination_id);
    if (!destination) return reply.code(404).send({ error: 'destination_not_found' });

    const iso = request.body?.iso_item_id ? await getIsoItem(request.body.iso_item_id) : null;

    try {
      await sendReleasesToDestination(destination, [
        {
          id: 0,
          iso_name: iso?.name || 'ISO Watcher Test',
          distribution: iso?.distribution || 'test',
          architecture: iso?.architecture || 'amd64',
          version: '0.0.0-test',
          filename: 'iso-watcher-test.iso',
          url: 'https://example.local/iso-watcher-test.iso',
          detected_at: new Date().toISOString(),
          title: 'Test ISO Watcher'
        }
      ], { notifyMode: 'immediate', isTest: true });

      return { sent: true, channel: destination.destination_type };
    } catch (error) {
      return reply.code(502).send(deliveryErrorPayload(error, {
        channel: destination.destination_type
      }));
    }
  });

  app.post('/api/v1/notifications/preview', async (request) => {
    const releaseIds = Array.isArray(request.body?.release_ids) ? request.body.release_ids : [];
    const releases = releaseIds.length ? await getReleaseRowsByIds(releaseIds) : buildFakeReleaseRows([], null);

    return buildPreview(request.body?.destination_type || 'email', releases, { locale: serverLocale });
  });
}

async function getOne(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function getIsoItem(id) {
  return getOne('SELECT * FROM iso_items WHERE id = ?', [id]);
}

async function getSource(id) {
  return getOne('SELECT * FROM iso_sources WHERE id = ?', [id]);
}

async function getDestination(id) {
  return getOne('SELECT * FROM destinations WHERE id = ?', [id]);
}

async function getPublicUserFromRequest(request) {
  if (request.actor?.type !== 'public') return null;
  const email = normalizeEmail(request.headers['x-public-email']);
  if (!email) return null;
  return getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', ['public', email]);
}

async function assertPublicOwnsUserId(request, reply, userId) {
  if (request.actor?.type !== 'public') return true;
  const user = await getPublicUserFromRequest(request);
  if (!user) {
    reply.code(403).send({ error: 'public_email_required' });
    return false;
  }
  if (Number(user.id) !== Number(userId)) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

async function assertPublicOwnsDestination(request, reply, destinationId) {
  if (request.actor?.type !== 'public') return true;
  const user = await getPublicUserFromRequest(request);
  if (!user) {
    reply.code(403).send({ error: 'public_email_required' });
    return false;
  }
  const destination = await getDestination(destinationId);
  if (!destination || Number(destination.user_id) !== Number(user.id)) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

async function patchTable(table, idColumn, id, allowedFields, body) {
  const fields = [];
  const params = [];

  for (const field of allowedFields) {
    if (Object.hasOwn(body, field)) {
      fields.push(`${field} = ?`);
      params.push(body[field]);
    }
  }

  if (!fields.length) return;

  params.push(id);
  await pool.query(`UPDATE ${table} SET ${fields.join(', ')} WHERE ${idColumn} = ?`, params);
}

async function upsertUser(body) {
  const userType = body.user_type || 'internal';
  const email = normalizeEmail(body.email);
  const username = body.username || null;
  const externalRef = body.external_ref || null;

  let existing = null;

  if (email) {
    existing = await getOne('SELECT * FROM users WHERE user_type = ? AND email = ?', [userType, email]);
  }

  if (!existing && externalRef) {
    existing = await getOne('SELECT * FROM users WHERE user_type = ? AND external_ref = ?', [userType, externalRef]);
  }

  if (!existing && username) {
    existing = await getOne('SELECT * FROM users WHERE user_type = ? AND username = ?', [userType, username]);
  }

  if (existing) {
    await pool.query(
      `UPDATE users SET username = ?, email = ?, external_ref = ?, display_name = ? WHERE id = ?`,
      [
        username,
        email,
        externalRef,
        body.display_name || existing.display_name || username || email,
        existing.id
      ]
    );

    return getOne('SELECT * FROM users WHERE id = ?', [existing.id]);
  }

  const [result] = await pool.query(
    `INSERT INTO users (user_type, username, email, external_ref, display_name, created_by_username)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userType,
      username,
      email,
      externalRef,
      body.display_name || username || email,
      body.created_by_username || null
    ]
  );

  return getOne('SELECT * FROM users WHERE id = ?', [result.insertId]);
}

async function upsertSubscription(userId, isoItemId, notifyMode = 'immediate', enabled = true) {
  const enabledVal = enabled ? 1 : 0;

  if (dbDriver === 'mysql') {
    await pool.query(
      `INSERT INTO subscriptions (user_id, iso_item_id, notify_mode, enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE notify_mode = VALUES(notify_mode), enabled = VALUES(enabled), updated_at = CURRENT_TIMESTAMP`,
      [userId, isoItemId, notifyMode, enabledVal]
    );
  } else {
    await pool.query(
      `INSERT INTO subscriptions (user_id, iso_item_id, notify_mode, enabled)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, iso_item_id) DO UPDATE SET
         notify_mode = excluded.notify_mode,
         enabled = excluded.enabled,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, isoItemId, notifyMode, enabledVal]
    );
  }

  return getOne(
    'SELECT * FROM subscriptions WHERE user_id = ? AND iso_item_id = ?',
    [userId, isoItemId]
  );
}

async function setIsoItemEnabled(id, enabled) {
  await pool.query('UPDATE iso_items SET enabled = ? WHERE id = ?', [enabled, id]);
  return getIsoItem(id);
}

async function setSourceEnabled(id, enabled) {
  await pool.query('UPDATE iso_sources SET enabled = ? WHERE id = ?', [enabled, id]);
  return getSource(id);
}

async function setDestinationEnabled(id, enabled) {
  await pool.query('UPDATE destinations SET enabled = ? WHERE id = ?', [enabled, id]);
  return getDestination(id);
}

function scanLogLevelRank(level) {
  return SCAN_LOG_LEVEL_RANK[level] ?? 20;
}

function shouldStoreScanLogLevel(level) {
  const minRank = scanLogLevelRank(config.limits.scanLogMinLevel);
  return scanLogLevelRank(level) >= minRank;
}

function formatSourceScanLabel(source) {
  if (!source) {
    return '';
  }

  const iso = source.iso_name || source.distribution || `ISO#${source.iso_item_id}`;
  const src = source.name || `source#${source.id}`;
  return `${iso} - ${src}`;
}

function formatScanLogMessage(source, message, ctx = {}) {
  const label = formatSourceScanLabel(source);
  const url = ctx.url || source?.url || null;
  let body = String(message || '').trim();

  if (url && !body.includes(url)) {
    const shortUrl = url.length > 160 ? `${url.slice(0, 157)}…` : url;
    body = body ? `${body} - ${shortUrl}` : shortUrl;
  }

  return label ? `[${label}] ${body}` : body;
}

function resolveScanLogApiLimit(requestedLimit) {
  const requested = Number(requestedLimit);
  const fallback = config.limits.scanLogApiDefaultLimit;
  const cap = config.limits.scanLogApiMaxLimit;
  const base = Number.isFinite(requested) && requested > 0 ? requested : fallback;

  if (cap <= 0) {
    return clamp(base, 1, 100000);
  }

  return clamp(base, 1, cap);
}

function trimScanExcerpt(text) {
  const max = config.limits.maxScanLogExcerpt;

  if (!text) {
    return '';
  }

  if (max <= 0) {
    return text;
  }

  return text.slice(-max);
}

async function appendScanLog(scanRunId, level, category, message, context = null) {
  const safeLevel = SCAN_LOG_LEVELS.has(level) ? level : 'info';

  if (!shouldStoreScanLogLevel(safeLevel)) {
    return;
  }

  const safeCategory = String(category || 'general').slice(0, 64);
  const safeMessage = String(message || '').slice(0, config.limits.maxScanLogMessage);
  const maxLines = config.limits.maxScanLogLines;

  if (maxLines > 0) {
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS c FROM scan_run_logs WHERE scan_run_id = ?',
      [scanRunId]
    );

    if (Number(countRows[0]?.c || 0) >= maxLines) {
      if (safeLevel === 'debug') {
        return;
      }

      await pool.query(
        `DELETE FROM scan_run_logs
         WHERE scan_run_id = ?
         ORDER BY id ASC
         LIMIT ?`,
        [scanRunId, config.limits.scanLogPruneBatch]
      );
    }
  }

  await pool.query(
    `INSERT INTO scan_run_logs (scan_run_id, level, category, message, context_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      scanRunId,
      safeLevel,
      safeCategory,
      safeMessage,
      context && Object.keys(context).length ? JSON.stringify(context) : null
    ]
  );
}

function logScan(scanRunId, level, category, message, context = {}) {
  const payload = {
    event: 'iso_watcher_scan',
    scan_run_id: scanRunId,
    category,
    ...context
  };

  if (level === 'error') app.log.error(payload, message);
  else if (level === 'warn') app.log.warn(payload, message);
  else if (level === 'debug') app.log.debug(payload, message);
  else app.log.info(payload, message);

  void appendScanLog(scanRunId, level, category, message, context).catch((err) => {
    app.log.warn({ err: err.message, scan_run_id: scanRunId }, 'Échec écriture scan_run_logs');
  });
}

function buildScanContext(options = {}) {
  return {
    iso_item_id: options.isoItemId || null,
    source_id: options.sourceId || null,
    test_only: Boolean(options.testOnly)
  };
}

async function createScanRunRecord({
  isoItemId = null,
  sourceId = null,
  triggerType = 'manual',
  notify = true,
  triggeredByUserId = null,
  testOnly = false
} = {}) {
  const [runResult] = await pool.query(
    `INSERT INTO scan_runs
     (trigger_type, triggered_by_user_id, status, notify_enabled, context_json)
     VALUES (?, ?, 'running', ?, ?)`,
    [
      triggerType,
      triggeredByUserId,
      notify !== false,
      JSON.stringify(buildScanContext({ isoItemId, sourceId, testOnly }))
    ]
  );

  const scanRunId = runResult.insertId;

  logScan(scanRunId, 'info', 'scan', 'Scan créé', {
    trigger_type: triggerType,
    triggered_by_user_id: triggeredByUserId,
    notify: notify !== false,
    iso_item_id: isoItemId,
    source_id: sourceId
  });

  return scanRunId;
}

async function loadScanSources({ isoItemId = null, sourceId = null } = {}) {
  const filters = ['s.enabled = TRUE', 'i.enabled = TRUE'];
  const params = [];

  if (isoItemId) {
    filters.push('s.iso_item_id = ?');
    params.push(isoItemId);
  }

  if (sourceId) {
    filters.push('s.id = ?');
    params.push(sourceId);
  }

  const [sources] = await pool.query(
    `SELECT s.*, i.name AS iso_name, i.distribution, i.architecture
     FROM iso_sources s
     JOIN iso_items i ON i.id = s.iso_item_id
     WHERE ${filters.join(' AND ')}
     ORDER BY s.priority ASC, s.id ASC`,
    params
  );

  return sources;
}

async function seedScanRunSources(scanRunId, sources) {
  const sourceRunIds = new Map();

  for (const source of sources) {
    const [result] = await pool.query(
      `INSERT INTO scan_run_sources
       (scan_run_id, source_id, iso_item_id, iso_name, source_name, source_url, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        scanRunId,
        source.id,
        source.iso_item_id,
        source.iso_name,
        source.name,
        source.url
      ]
    );

    sourceRunIds.set(source.id, result.insertId);
  }

  await pool.query(
    'UPDATE scan_runs SET total_sources = ?, completed_sources = 0 WHERE id = ?',
    [sources.length, scanRunId]
  );

  return sourceRunIds;
}

async function incrementScanProgress(scanRunId) {
  await pool.query(
    'UPDATE scan_runs SET completed_sources = completed_sources + 1 WHERE id = ?',
    [scanRunId]
  );
}

async function recoverOrphanedScansOnStartup() {
  const mode = config.scanStartupRecovery;

  if (mode === 'ignore' || mode === 'none') {
    return { mode, recovered: 0, scan_run_ids: [] };
  }

  const [runningScans] = await pool.query(
    `SELECT id, started_at, total_sources, completed_sources, checked_sources,
            found_releases, new_releases
     FROM scan_runs
     WHERE status = 'running'`
  );

  if (!runningScans.length) {
    return { mode, recovered: 0, scan_run_ids: [] };
  }

  const recoveredIds = [];

  for (const scan of runningScans) {
    const scanRunId = scan.id;
    const startedMs = scan.started_at ? new Date(scan.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - startedMs);

    await pool.query(
      `UPDATE scan_run_sources
       SET status = 'interrupted',
           finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
           error_message = COALESCE(NULLIF(error_message, ''), ?)
       WHERE scan_run_id = ? AND status IN ('running', 'pending')`,
      [SCAN_STARTUP_INTERRUPT_REASON, scanRunId]
    );

    const [progressRows] = await pool.query(
      `SELECT COUNT(*) AS completed
       FROM scan_run_sources
       WHERE scan_run_id = ? AND status IN ('success', 'error', 'interrupted')`,
      [scanRunId]
    );

    const completedSources = Number(progressRows[0]?.completed || 0);

    await pool.query(
      `UPDATE scan_runs
       SET status = 'interrupted',
           finished_at = CURRENT_TIMESTAMP,
           duration_ms = ?,
           error_message = ?,
           completed_sources = ?,
           checked_sources = ?
       WHERE id = ?`,
      [
        durationMs,
        SCAN_STARTUP_INTERRUPT_REASON,
        completedSources,
        completedSources,
        scanRunId
      ]
    );

    try {
      await appendScanLog(scanRunId, 'warn', 'scan', SCAN_STARTUP_INTERRUPT_REASON, {
        recovery: 'startup',
        completed_sources: completedSources,
        total_sources: Number(scan.total_sources || 0)
      });
    } catch (logError) {
      app.log.warn({ err: logError, scan_run_id: scanRunId }, 'Log scan recovery non écrit');
    }

    recoveredIds.push(scanRunId);
  }

  return {
    mode,
    recovered: recoveredIds.length,
    scan_run_ids: recoveredIds
  };
}

async function finalizeScanRun(scanRunId, {
  status,
  checkedSources,
  foundReleases,
  newReleases,
  errorMessage = null,
  startedAtMs = Date.now()
} = {}) {
  const durationMs = Math.max(0, Date.now() - startedAtMs);

  await pool.query(
    `UPDATE scan_runs
     SET status = ?, finished_at = CURRENT_TIMESTAMP, checked_sources = ?, found_releases = ?,
         new_releases = ?, error_message = ?, duration_ms = ?,
         completed_sources = total_sources
     WHERE id = ?`,
    [
      status,
      checkedSources,
      foundReleases,
      newReleases,
      errorMessage,
      durationMs,
      scanRunId
    ]
  );

  logScan(scanRunId, status === 'error' ? 'error' : 'info', 'scan', 'Scan terminé', {
    status,
    checked_sources: checkedSources,
    found_releases: foundReleases,
    new_releases: newReleases,
    duration_ms: durationMs,
    error_message: errorMessage
  });
}

async function processScanSourceRun(scanRunId, source, sourceRunId, options = {}) {
  const notify = options.notify !== false;
  const testOnly = Boolean(options.testOnly);
  const startedMs = Date.now();
  const logLines = [];

  const pushExcerpt = (line) => {
    logLines.push(line);
    const maxExcerpt = config.limits.maxScanLogExcerpt;

    if (maxExcerpt > 0) {
      while (logLines.join('\n').length > maxExcerpt) {
        logLines.shift();
      }
    }
  };

  await pool.query(
    `UPDATE scan_run_sources SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [sourceRunId]
  );

  const sourceLabel = formatSourceScanLabel(source);

  logScan(scanRunId, 'info', 'source', `Début scan - ${sourceLabel}`, {
    source_id: source.id,
    source_name: source.name,
    iso_item_id: source.iso_item_id,
    iso_name: source.iso_name,
    distribution: source.distribution,
    url: source.url,
    protocol: source.protocol
  });
  pushExcerpt(`[info] Début scan - ${sourceLabel} - ${source.url}`);

  try {
    const sourceResult = await testSource(source, {
      onLog: (level, message, ctx = {}) => {
        const fullMessage = formatScanLogMessage(source, message, ctx);
        pushExcerpt(`[${level}] ${fullMessage}`);
        logScan(scanRunId, level, 'source_fetch', fullMessage, {
          source_id: source.id,
          source_name: source.name,
          iso_item_id: source.iso_item_id,
          iso_name: source.iso_name,
          url: ctx.url || source.url,
          ...ctx
        });
      }
    });

    await pool.query(
      `UPDATE iso_sources SET last_status = 'ok', last_error = NULL, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [source.id]
    );

    let newReleases = 0;
    const newReleaseIds = [];
    const matches = sourceResult.matches || [];

    if (!testOnly) {
      const sortedMatches = [...matches].sort((a, b) => compareVersions(a.version, b.version));

      for (const match of sortedMatches) {
        const inserted = await insertReleaseIfNew(source, match);

        if (inserted?.isNew) {
          newReleases += 1;
          newReleaseIds.push(inserted.releaseId);
          pushExcerpt(`[info] Nouvelle release: ${match.filename} v${match.version || '?'} - ${match.url || source.url}`);

          if (notify) {
            await createNotificationEventAndDeliveries(inserted.releaseId);
          }

          storage.ingestNewRelease(inserted.releaseId, source).catch((error) => {
            app.log.warn({ err: error, release_id: inserted.releaseId }, 'Téléchargement local release échoué');
          });
        }
      }

      await refreshLatestRelease(source.iso_item_id);
    }

    const durationMs = Date.now() - startedMs;

    await pool.query(
      `UPDATE scan_run_sources
       SET status = 'success', finished_at = CURRENT_TIMESTAMP, duration_ms = ?,
           matches_found = ?, new_releases = ?, discovery_json = ?, log_excerpt = ?
       WHERE id = ?`,
      [
        durationMs,
        matches.length,
        newReleases,
        sourceResult.discovery ? JSON.stringify(sourceResult.discovery) : null,
        trimScanExcerpt(logLines.join('\n')),
        sourceRunId
      ]
    );

    logScan(scanRunId, 'info', 'source', `OK - ${sourceLabel} (${matches.length} correspondance(s))`, {
      source_id: source.id,
      source_name: source.name,
      iso_name: source.iso_name,
      url: source.url,
      matches_found: matches.length,
      new_releases: newReleases,
      duration_ms: durationMs,
      discovery: sourceResult.discovery
    });

    return {
      ok: true,
      matches,
      newReleases,
      durationMs
    };
  } catch (error) {
    const durationMs = Date.now() - startedMs;
    const errorMessage = String(error.message || error);

    await pool.query(
      `UPDATE iso_sources SET last_status = 'error', last_error = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorMessage, source.id]
    );

    await pool.query(
      `UPDATE scan_run_sources
       SET status = 'error', finished_at = CURRENT_TIMESTAMP, duration_ms = ?,
           error_message = ?, log_excerpt = ?
       WHERE id = ?`,
      [
        durationMs,
        errorMessage,
        trimScanExcerpt(logLines.concat(`[error] ${errorMessage}`).join('\n')),
        sourceRunId
      ]
    );

    logScan(scanRunId, 'error', 'source', `Erreur - ${sourceLabel}: ${errorMessage}`, {
      source_id: source.id,
      source_name: source.name,
      iso_name: source.iso_name,
      url: source.url,
      duration_ms: durationMs
    });

    return {
      ok: false,
      error,
      durationMs
    };
  }
}

async function processScanRun(scanRunId, options = {}) {
  const startedAtMs = Date.now();
  const notify = options.notify !== false;
  const testOnly = Boolean(options.testOnly);

  logScan(scanRunId, 'info', 'scan', 'Traitement du scan démarré', {
    notify,
    test_only: testOnly,
    max_parallel: config.limits.maxParallelSources
  });

  let checkedSources = 0;
  let foundReleases = 0;
  let newReleases = 0;
  const newReleaseIds = [];
  let hadError = false;
  let firstError = null;

  try {
    const sources = await loadScanSources(options);

    logScan(scanRunId, 'info', 'scan', `${sources.length} source(s) à traiter`, {
      source_ids: sources.map((s) => s.id)
    });

    if (!sources.length) {
      await finalizeScanRun(scanRunId, {
        status: 'success',
        checkedSources: 0,
        foundReleases: 0,
        newReleases: 0,
        startedAtMs
      });

      return {
        scan_run_id: scanRunId,
        status: 'success',
        checked_sources: 0,
        found_releases: 0,
        new_releases: 0
      };
    }

    const sourceRunIds = await seedScanRunSources(scanRunId, sources);

    const results = await runLimited(sources, config.limits.maxParallelSources, async (source) => {
      const sourceRunId = sourceRunIds.get(source.id);

      try {
        return await processScanSourceRun(scanRunId, source, sourceRunId, options);
      } finally {
        await incrementScanProgress(scanRunId);
      }
    });

    for (const result of results) {
      checkedSources += 1;

      if (!result?.ok) {
        hadError = true;
        firstError ||= String(result.error?.message || result.error);
        continue;
      }

      foundReleases += (result.matches || []).length;
      newReleases += result.newReleases || 0;

      if (Array.isArray(result.newReleaseIds)) {
        newReleaseIds.push(...result.newReleaseIds);
      }
    }

    const finalStatus = hadError ? 'partial_error' : 'success';

    await finalizeScanRun(scanRunId, {
      status: finalStatus,
      checkedSources,
      foundReleases,
      newReleases,
      errorMessage: firstError,
      startedAtMs
    });

    if (notify && !testOnly) {
      logScan(scanRunId, 'info', 'scan', 'Envoi des notifications en attente');
      await sendPendingDeliveries();

      if (newReleaseIds.length) {
        logScan(scanRunId, 'info', 'scan', `Notification admin instantanée (${newReleaseIds.length} release(s))`);

        try {
          const uniqueIds = [...new Set(newReleaseIds.map((id) => Number(id)).filter((id) => id > 0))];
          const releaseRows = await getReleaseRowsByIds(uniqueIds);

          if (releaseRows.length) {
            await adminNotify.notifyNewReleases({
              releases: releaseRows,
              scanRunId,
              channels: adminNotify.resolveChannels({ kind: 'instant' })
            });
          }
        } catch (error) {
          app.log.error(error, 'Échec notification admin instantanée');
          logScan(scanRunId, 'error', 'scan', `Échec notification admin : ${error.message}`);
        }
      }
    }

    return {
      scan_run_id: scanRunId,
      status: finalStatus,
      checked_sources: checkedSources,
      found_releases: foundReleases,
      new_releases: newReleases
    };
  } catch (error) {
    const errorMessage = String(error.message || error);

    await finalizeScanRun(scanRunId, {
      status: 'error',
      checkedSources,
      foundReleases,
      newReleases,
      errorMessage,
      startedAtMs
    });

    throw error;
  }
}

async function startScanAsync(options = {}) {
  const scanRunId = await createScanRunRecord(options);

  setImmediate(() => {
    processScanRun(scanRunId, options).catch((error) => {
      app.log.error({ err: error, scan_run_id: scanRunId }, 'Scan asynchrone en échec');
    });
  });

  return {
    scan_run_id: scanRunId,
    status: 'running',
    async: true,
    message: 'Scan accepté et exécuté en arrière-plan'
  };
}

async function runScan(options = {}) {
  const scanRunId = await createScanRunRecord(options);
  const result = await processScanRun(scanRunId, options);

  return {
    ...result,
    async: false
  };
}

async function getScanRunDetail(scanRunId, { logLimit = null, logSinceId = 0 } = {}) {
  const row = await getOne('SELECT * FROM scan_runs WHERE id = ?', [scanRunId]);

  if (!row) return null;

  const [sources] = await pool.query(
    `SELECT id, scan_run_id, source_id, iso_item_id, iso_name, source_name, source_url,
            status, started_at, finished_at, duration_ms, matches_found, new_releases,
            error_message, discovery_json, log_excerpt
     FROM scan_run_sources
     WHERE scan_run_id = ?
     ORDER BY id ASC`,
    [scanRunId]
  );

  const logParams = [scanRunId];
  let logSql = `SELECT id, level, category, message, context_json, created_at
                FROM scan_run_logs
                WHERE scan_run_id = ?`;

  if (logSinceId > 0) {
    logSql += ' AND id > ?';
    logParams.push(logSinceId);
  }

  logSql += ' ORDER BY id ASC LIMIT ?';
  logParams.push(resolveScanLogApiLimit(logLimit));

  const [logs] = await pool.query(logSql, logParams);

  const isFinished = row.status !== 'running';
  const progressPercent = row.total_sources > 0
    ? Math.min(100, Math.round((Number(row.completed_sources || 0) / Number(row.total_sources)) * 100))
    : (isFinished ? 100 : 0);

  return {
    ...row,
    is_finished: isFinished,
    progress_percent: progressPercent,
    sources: sources.map((s) => ({
      ...s,
      discovery: parseJsonColumn(s.discovery_json)
    })),
    logs: logs.map((entry) => ({
      ...entry,
      context: parseJsonColumn(entry.context_json)
    }))
  };
}

async function testSource(source, { onLog } = {}) {
  const log = typeof onLog === 'function'
    ? onLog
    : () => {};

  log('debug', 'Analyse de la source', {
    source_id: source.id,
    protocol: source.protocol,
    discovery_enabled: Boolean(source.discovery_enabled)
  });

  const { entries, discovery } = await collectSourceEntries(source, { onLog: log });

  log('debug', `${entries.length} entrée(s) listée(s)`, {
    scanned_urls: discovery?.scanned_urls,
    scanned_directories: discovery?.scanned_directories
  });

  const matches = await extractMatchesFromEntries(entries, source);
  const sampleNames = matches.slice(0, 12).map((m) => m.filename).filter(Boolean);
  const matchMessage = matches.length
    ? `${matches.length} correspondance(s) : ${sampleNames.join(', ')}${matches.length > sampleNames.length ? ` (+${matches.length - sampleNames.length})` : ''}`
    : '0 correspondance après filtrage regex';

  log('info', matchMessage, {
    match_regex: Boolean(source.match_regex),
    matches: matches.slice(0, 30).map((m) => ({
      filename: m.filename,
      url: m.url,
      version: m.version || null
    }))
  });

  return {
    ok: true,
    source_id: source.id,
    matches,
    discovery
  };
}

async function collectSourceEntries(source, { onLog } = {}) {
  const log = typeof onLog === 'function'
    ? onLog
    : () => {};

  if (!source.discovery_enabled) {
    log('debug', 'Liste directe (sans découverte)', { url: source.url });
    const entries = await listSourceEntriesAtUrl(source, source.url, { onLog: log });

    return {
      entries,
      discovery: {
        enabled: false,
        scanned_directories: 0,
        scanned_urls: 1
      }
    };
  }

  const discoveryRegex = compileDiscoveryRegex(source.discovery_regex);
  const maxDepth = clamp(Number(source.discovery_depth) || 1, 1, 6);
  const visited = new Set();
  const scannedDirectories = [];
  const fileEntries = [];
  const queue = [{
    url: normalizeDirectoryUrl(source.url),
    depth: 0
  }];

  log('info', 'Découverte récursive activée', {
    discovery_depth: maxDepth,
    discovery_regex: source.discovery_regex
  });

  while (queue.length) {
    const current = queue.shift();
    const normalizedUrl = normalizeDirectoryUrl(current.url);

    if (visited.has(normalizedUrl)) continue;

    visited.add(normalizedUrl);

    log('debug', `Exploration répertoire (profondeur ${current.depth})`, { url: normalizedUrl });

    const entries = await listSourceEntriesAtUrl(source, normalizedUrl, { onLog: log });
    let dirCount = 0;
    let dirMatched = 0;
    let dirSkipped = 0;
    const skippedSamples = [];

    for (const entry of entries) {
      if (entry.isDirectory) {
        dirCount++;
        const folderLabel = getDiscoveryFolderLabel(entry, normalizedUrl);

        if (current.depth < maxDepth && folderLabel && discoveryRegex.test(folderLabel)) {
          dirMatched++;
          scannedDirectories.push({
            url: normalizeDirectoryUrl(entry.url),
            folder: folderLabel,
            depth: current.depth + 1
          });

          queue.push({
            url: entry.url,
            depth: current.depth + 1
          });
        } else {
          dirSkipped++;

          if (skippedSamples.length < 5 && folderLabel) {
            skippedSamples.push(folderLabel);
          }
        }

        continue;
      }

      fileEntries.push({
        ...entry,
        discovered_from: current.depth > 0 ? normalizedUrl : null
      });
    }

    if (dirCount > 0) {
      log('debug', `${dirCount} sous-dossier(s) : ${dirMatched} exploré(s), ${dirSkipped} ignoré(s) (regex)`, {
        depth: current.depth,
        skipped_samples: skippedSamples,
        discovery_regex: source.discovery_regex?.trim() || DEFAULT_DISCOVERY_REGEX
      });

      if (dirMatched === 0 && dirSkipped > 0) {
        log('warn', 'Aucun sous-dossier ne correspond à discovery_regex - vérifiez le motif (ex. Arch : ^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}/$)', {
          discovery_regex: source.discovery_regex,
          skipped_samples: skippedSamples
        });
      }
    }
  }

  return {
    entries: fileEntries,
    discovery: {
      enabled: true,
      discovery_regex: source.discovery_regex,
      discovery_depth: maxDepth,
      scanned_urls: visited.size,
      scanned_directories: scannedDirectories.length,
      directories: scannedDirectories
    }
  };
}

async function listSourceEntriesAtUrl(source, targetUrl, { onLog } = {}) {
  const emptyAsNoEntries = Boolean(source.discovery_enabled);

  if (source.protocol === 'ftp') {
    return listFtpSource(source, targetUrl, { onLog });
  }

  return listHttpSource(source, targetUrl, { onLog, treatEmptyAsNoEntries: emptyAsNoEntries });
}

async function listHttpSource(source, targetUrl = null, { onLog, treatEmptyAsNoEntries = false } = {}) {
  const log = typeof onLog === 'function'
    ? onLog
    : () => {};
  const url = normalizeDirectoryUrl(targetUrl || source.url);

  log('debug', 'Requête HTTP', { url, allow_insecure_tls: Boolean(source.allow_insecure_tls) });

  const response = await httpGetText(
    url,
    Boolean(source.allow_insecure_tls),
    config.timeouts.httpMs
  );

  log('debug', 'Réponse HTTP reçue', {
    url,
    status: response.statusCode,
    bytes: response.body?.length || 0,
    content_encoding: response.contentEncoding || null
  });

  const links = extractLinksFromHtml(response.body, url);

  if (!links.length) {
    if (treatEmptyAsNoEntries) {
      log('warn', 'Listing vide ou non reconnu (découverte)', { url });
      return [];
    }

    return [
      {
        filename: filenameFromUrl(url),
        url,
        isDirectory: false,
        size: null,
        modifiedAt: null
      }
    ];
  }

  return links;
}

async function listFtpSource(source, targetUrl = null, { onLog } = {}) {
  const log = typeof onLog === 'function'
    ? onLog
    : () => {};
  const baseUrl = normalizeDirectoryUrl(targetUrl || source.url);
  const parsed = new URL(baseUrl);
  const client = new ftp.Client(config.timeouts.ftpMs);
  const includeDirectories = Boolean(source.discovery_enabled);

  client.ftp.verbose = false;

  log('debug', 'Connexion FTP', { host: parsed.hostname, path: parsed.pathname });

  try {
    await client.access({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 21,
      user: decodeURIComponent(parsed.username || 'anonymous'),
      password: decodeURIComponent(parsed.password || 'anonymous@'),
      secure: false
    });

    const directory = decodeURIComponent(parsed.pathname || '/');
    const list = await client.list(directory);
    const entries = [];

    for (const entry of list) {
      if (entry.name === '.' || entry.name === '..') continue;

      if (entry.isFile) {
        entries.push({
          filename: entry.name,
          url: joinFtpUrl(baseUrl, entry.name),
          isDirectory: false,
          size: entry.size || null,
          modifiedAt: entry.modifiedAt || null
        });
        continue;
      }

      if (includeDirectories && entry.isDirectory) {
        entries.push({
          filename: `${entry.name}/`,
          url: joinFtpPath(baseUrl, entry.name),
          isDirectory: true,
          size: null,
          modifiedAt: entry.modifiedAt || null
        });
      }
    }

    log('debug', `${entries.length} entrée(s) FTP`, { url: baseUrl });

    return entries;
  } finally {
    client.close();
  }
}

function parseJsonColumn(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function stripHtmlForLinkExtraction(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function pushParsedLink(results, seen, href, base, meta = {}) {
  if (!href || href === '../' || href === './' || href === '/') return;

  const absolute = new URL(href, base).toString();
  const parsed = new URL(absolute);
  const isDirectory = href.endsWith('/') || parsed.pathname.endsWith('/');
  const size = meta.size ?? null;
  const modifiedAt = meta.modifiedAt ?? null;

  if (seen.has(absolute)) {
    const existing = results.find((entry) => entry.url === absolute);

    if (existing) {
      if (!existing.size && size) {
        existing.size = size;
      }

      if (!existing.modifiedAt && modifiedAt) {
        existing.modifiedAt = modifiedAt;
      }
    }

    return;
  }

  seen.add(absolute);

  results.push({
    filename: isDirectory
      ? `${parsed.pathname.split('/').filter(Boolean).pop() || ''}/`
      : filenameFromUrl(absolute),
    url: isDirectory ? normalizeDirectoryUrl(absolute) : absolute,
    isDirectory,
    size,
    modifiedAt
  });
}

function parseHumanFileSize(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  const value = String(raw).trim().replace(/,/g, '');

  if (!value || value === '-') {
    return null;
  }

  const humanMatch = value.match(/^([\d.]+)\s*([KMGT])?i?B?$/i);

  if (humanMatch) {
    const amount = Number(humanMatch[1]);
    const unit = String(humanMatch[2] || '').toUpperCase();
    const multipliers = {
      '': 1,
      K: 1024,
      M: 1024 ** 2,
      G: 1024 ** 3,
      T: 1024 ** 4
    };

    if (!Number.isFinite(amount)) {
      return null;
    }

    return Math.round(amount * (multipliers[unit] || 1));
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

function parseApacheListingDate(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const month = months[match[2].toLowerCase()];

  if (month === undefined) {
    return null;
  }

  return new Date(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5])
  );
}

function parseApachePreLinks(preHtml, base, results, seen) {
  const lines = String(preHtml || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/);

  for (const line of lines) {
    if (!/<a\s/i.test(line)) {
      continue;
    }

    const hrefMatch = line.match(/href=["']([^"'#?]+)["']/i);

    if (!hrefMatch) {
      continue;
    }

    const tailMatch = line.match(/<\/a>\s*(.*)$/i);
    const tail = tailMatch ? tailMatch[1].trim() : '';
    let size = null;
    let modifiedAt = null;

    if (tail && tail !== '-') {
      const datedMatch = tail.match(/^(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2})\s+(.+)$/);

      if (datedMatch) {
        modifiedAt = parseApacheListingDate(datedMatch[1]);
        size = parseHumanFileSize(datedMatch[2]);
      } else {
        size = parseHumanFileSize(tail);
      }
    }

    pushParsedLink(results, seen, hrefMatch[1], base, { size, modifiedAt });
  }
}

function extractLinksFromHtml(html, baseUrl) {
  const cleaned = stripHtmlForLinkExtraction(html);
  const results = [];
  const seen = new Set();
  const base = normalizeDirectoryUrl(baseUrl);
  const preMatch = cleaned.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);

  if (preMatch) {
    parseApachePreLinks(preMatch[1], base, results, seen);
  }

  const hrefRegex = /href=["']([^"'#?]+(?:\?[^"'#]*)?)["']/gi;
  let match;

  while ((match = hrefRegex.exec(cleaned)) !== null) {
    pushParsedLink(results, seen, match[1], base);
  }

  return results;
}

function parseDiscoveryFields(body) {
  const discoveryEnabled = parseBool(body.discovery_enabled, false);

  return {
    discovery_enabled: discoveryEnabled,
    discovery_depth: discoveryEnabled
      ? clamp(Number(body.discovery_depth ?? 1), 1, 5)
      : clamp(Number(body.discovery_depth ?? 0), 0, 5),
    discovery_regex: body.discovery_regex
      ? String(body.discovery_regex).trim()
      : null
  };
}

function validateDiscoveryRegex(pattern) {
  if (!pattern) return;

  compileDiscoveryRegex(pattern);
}

function compileDiscoveryRegex(pattern) {
  const raw = String(pattern ?? '').trim();

  if (!raw) {
    return new RegExp(DEFAULT_DISCOVERY_REGEX, 'i');
  }

  try {
    return new RegExp(raw, 'i');
  } catch (error) {
    throw new Error(`discovery_regex invalide : ${error.message}`);
  }
}

function normalizeDirectoryUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  let path = parsed.pathname || '/';

  if (!path.endsWith('/')) {
    path += '/';
  }

  parsed.pathname = path;

  return parsed.toString();
}

function getDiscoveryFolderLabel(entry, parentUrl) {
  if (!entry?.isDirectory) return '';

  const folderName = String(entry.filename || '').replace(/\/+$/, '');

  if (folderName) {
    return `${folderName}/`;
  }

  try {
    const parent = new URL(normalizeDirectoryUrl(parentUrl));
    const child = new URL(normalizeDirectoryUrl(entry.url));
    const relative = child.pathname.slice(parent.pathname.length);
    const segment = relative.split('/').filter(Boolean)[0];

    return segment ? `${segment}/` : '';
  } catch {
    return '';
  }
}

async function extractMatchesFromEntries(entries, source) {
  const matchRegex = new RegExp(source.match_regex, 'i');
  const versionRegex = source.version_regex ? new RegExp(source.version_regex, 'i') : null;
  const checksumRegex = source.checksum_regex ? new RegExp(source.checksum_regex, 'i') : null;
  const matches = [];

  for (const entry of entries) {
    const subject = `${entry.filename} ${entry.url}`;
    const matched = subject.match(matchRegex);

    if (!matched) continue;

    const versionMatched = versionRegex ? subject.match(versionRegex) : matched;
    const version = versionMatched?.groups?.version || matched?.groups?.version || versionMatched?.[1] || matched?.[1] || null;
    const checksumMatched = checksumRegex ? subject.match(checksumRegex) : null;

    matches.push({
      version,
      filename: entry.filename,
      url: entry.url,
      checksum_url: checksumMatched ? entry.url : null,
      file_size: entry.size || null,
      published_at: entry.modifiedAt ? toMysqlDate(entry.modifiedAt) : null,
      raw_metadata: {
        source_id: source.id,
        matched_groups: matched.groups || null,
        discovered_from: entry.discovered_from || null
      }
    });
  }

  const deduped = dedupeMatches(matches);
  await enrichMatchesWithFileSizes(deduped, source);

  return deduped;
}

async function enrichMatchesWithFileSizes(matches, source) {
  const pending = matches.filter((match) => !match.file_size && match.url);

  if (!pending.length) {
    return;
  }

  await runLimited(pending, 4, async (match) => {
    const size = await fetchRemoteFileSize(match.url, source);

    if (size) {
      match.file_size = size;
    }
  });
}

async function fetchRemoteFileSize(targetUrl, source) {
  try {
    const parsed = new URL(targetUrl);

    if (parsed.protocol === 'ftp:') {
      return ftpFetchFileSize(targetUrl, config.timeouts.ftpMs);
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return httpFetchContentLength(
        targetUrl,
        Boolean(source.allow_insecure_tls),
        Math.min(config.timeouts.httpMs, 20000)
      );
    }
  } catch {
    return null;
  }

  return null;
}

async function insertReleaseIfNew(source, match) {
  const existing = await getOne(
    'SELECT id FROM iso_releases WHERE iso_item_id = ? AND filename = ?',
    [source.iso_item_id, match.filename]
  );

  if (existing) {
    if (match.file_size) {
      await pool.query(
        'UPDATE iso_releases SET file_size = ? WHERE id = ? AND (file_size IS NULL OR file_size = 0)',
        [match.file_size, existing.id]
      );
    }

    return {
      isNew: false,
      releaseId: existing.id
    };
  }

  const [result] = await pool.query(
    `INSERT INTO iso_releases
     (iso_item_id, source_id, version, filename, url, checksum_url, file_size, published_at, is_latest, raw_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?)`,
    [
      source.iso_item_id,
      source.id,
      match.version,
      match.filename,
      match.url,
      match.checksum_url || null,
      match.file_size || null,
      match.published_at || null,
      JSON.stringify(match.raw_metadata || {})
    ]
  );

  return {
    isNew: true,
    releaseId: result.insertId
  };
}

async function refreshLatestRelease(isoItemId) {
  const [rows] = await pool.query(
    'SELECT id, version, detected_at FROM iso_releases WHERE iso_item_id = ?',
    [isoItemId]
  );

  if (!rows.length) {
    await pool.query('UPDATE iso_releases SET is_latest = FALSE WHERE iso_item_id = ?', [isoItemId]);
    return;
  }

  const latest = rows.reduce((best, row) => {
    const cmp = compareVersions(row.version, best.version);

    if (cmp > 0) return row;
    if (cmp === 0 && new Date(row.detected_at) > new Date(best.detected_at)) return row;

    return best;
  }, rows[0]);

  await pool.query('UPDATE iso_releases SET is_latest = FALSE WHERE iso_item_id = ?', [isoItemId]);
  await pool.query('UPDATE iso_releases SET is_latest = TRUE WHERE id = ?', [latest.id]);
}

function logNotificationEvent(notificationEvent, fields = {}) {
  app.log.info({
    event: 'iso_watcher_notification',
    notification_event: notificationEvent,
    ...fields
  });
}

function maskTargetForLog(destination) {
  return maskDestinationTarget(destination);
}

function truncateResponseBody(body, maxLength = 2000) {
  const value = String(body ?? '');

  if (value.length <= maxLength) return value;

  return `${value.slice(0, maxLength)}…`;
}

function computeDigestSchedule(notifyMode, referenceDate = new Date()) {
  const mode = notifyMode || 'immediate';

  if (mode === 'hourly_digest') {
    const scheduledFor = new Date(referenceDate);
    scheduledFor.setMinutes(0, 0, 0);
    scheduledFor.setHours(scheduledFor.getHours() + 1);

    const digestBucket = `${scheduledFor.getFullYear()}-${String(scheduledFor.getMonth() + 1).padStart(2, '0')}-${String(scheduledFor.getDate()).padStart(2, '0')}T${String(scheduledFor.getHours()).padStart(2, '0')}`;

    return { scheduledFor, digestBucket };
  }

  if (mode === 'daily_digest') {
    const scheduledFor = new Date(referenceDate);
    scheduledFor.setHours(config.digest.dailyHour, 0, 0, 0);

    if (scheduledFor <= referenceDate) {
      scheduledFor.setDate(scheduledFor.getDate() + 1);
    }

    const digestBucket = [
      scheduledFor.getFullYear(),
      String(scheduledFor.getMonth() + 1).padStart(2, '0'),
      String(scheduledFor.getDate()).padStart(2, '0')
    ].join('-');

    return { scheduledFor, digestBucket };
  }

  return {
    scheduledFor: new Date(referenceDate),
    digestBucket: null
  };
}

function deliveryGroupKey(row) {
  return `${row.destination_id}:${row.digest_bucket || 'immediate'}`;
}

function buildDestinationFromRow(row) {
  return {
    id: row.destination_id,
    user_id: row.user_id,
    destination_type: row.destination_type,
    label: row.label,
    target: row.target,
    enabled: row.enabled,
    config: row.config
  };
}

async function createNotificationEventAndDeliveries(releaseId) {
  const release = await getReleaseRow(releaseId);

  if (!release) return;

  const title = t(serverLocale, 'notify.event.new_title', { name: release.iso_name || release.filename });
  const message = t(serverLocale, 'notify.event.new_message', {
    name: release.iso_name || release.filename,
    version: release.version || '',
    url: release.url || ''
  }).replace(/\s+/g, ' ').trim();

  const [eventResult] = await pool.query(
    `INSERT INTO notification_events (iso_release_id, event_type, title, message) VALUES (?, 'new_release', ?, ?)`,
    [releaseId, title, message]
  );

  const [destinations] = await pool.query(
    `SELECT DISTINCT d.id, d.user_id, d.destination_type, d.label, d.target, d.enabled, d.config, s.notify_mode
     FROM subscriptions s
     JOIN destinations d ON d.user_id = s.user_id
     WHERE s.iso_item_id = ?
       AND s.enabled = TRUE
       AND d.enabled = TRUE`,
    [release.iso_item_id]
  );

  const now = new Date();

  for (const destination of destinations) {
    const { scheduledFor, digestBucket } = computeDigestSchedule(destination.notify_mode, now);

    await pool.query(
      `INSERT INTO notification_deliveries
         (notification_event_id, destination_id, status, scheduled_for, digest_bucket)
       VALUES (?, ?, 'pending', ?, ?)`,
      [
        eventResult.insertId,
        destination.id,
        toMysqlDate(scheduledFor),
        digestBucket
      ]
    );
  }

  logNotificationEvent('release_notifications_queued', {
    release_id: releaseId,
    iso_item_id: release.iso_item_id,
    destination_count: destinations.length
  });
}

async function sendPendingDeliveries() {
  const maxAttempts = config.limits.maxDeliveryAttempts;

  const [rows] = await pool.query(
    `SELECT
       d.id AS delivery_id,
       d.attempt_count,
       d.scheduled_for,
       d.digest_bucket,
       dest.id AS destination_id,
       dest.user_id,
       dest.destination_type,
       dest.label,
       dest.target,
       dest.enabled,
       dest.config,
       e.id AS event_id,
       r.id AS release_id,
       s.notify_mode
     FROM notification_deliveries d
     JOIN destinations dest ON dest.id = d.destination_id
     JOIN notification_events e ON e.id = d.notification_event_id
     JOIN iso_releases r ON r.id = e.iso_release_id
     JOIN subscriptions s
       ON s.user_id = dest.user_id
      AND s.iso_item_id = r.iso_item_id
      AND s.enabled = TRUE
     WHERE dest.enabled = TRUE
       AND d.scheduled_for <= CURRENT_TIMESTAMP
       AND (
         d.status = 'pending'
         OR (
           d.status IN ('failed', 'rate_limited')
           AND d.attempt_count < ?
           AND d.next_retry_at IS NOT NULL
           AND d.next_retry_at <= CURRENT_TIMESTAMP
         )
       )
     ORDER BY d.scheduled_for ASC, d.created_at ASC
     LIMIT 500`,
    [maxAttempts]
  );

  const groups = new Map();

  for (const row of rows) {
    const key = deliveryGroupKey(row);

    if (!groups.has(key)) {
      groups.set(key, {
        destination: buildDestinationFromRow(row),
        notifyMode: row.notify_mode || 'immediate',
        digestBucket: row.digest_bucket,
        deliveries: []
      });
    }

    groups.get(key).deliveries.push(row);
  }

  let sentGroups = 0;
  let failedGroups = 0;

  for (const group of groups.values()) {
    const deliveryIds = group.deliveries.map((item) => item.delivery_id);
    const attemptCount = Math.max(...group.deliveries.map((item) => item.attempt_count || 0));
    const releaseIds = [...new Set(group.deliveries.map((item) => item.release_id))];

    logNotificationEvent('delivery_group_start', {
      destination_id: group.destination.id,
      destination_type: group.destination.destination_type,
      target: maskTargetForLog(group.destination),
      notify_mode: group.notifyMode,
      digest_bucket: group.digestBucket,
      delivery_count: deliveryIds.length,
      release_count: releaseIds.length,
      attempt_count: attemptCount
    });

    const startedAt = Date.now();

    try {
      const releaseRows = await getReleaseRowsByIds(releaseIds);

      const sendResult = await sendReleasesToDestination(group.destination, releaseRows, {
        notifyMode: group.notifyMode,
        isTest: false
      });

      await finalizeDeliveries(deliveryIds, {
        success: true,
        statusCode: sendResult?.statusCode ?? null,
        responseBody: sendResult?.body ?? null
      });

      sentGroups += 1;

      logNotificationEvent('delivery_group_success', {
        destination_id: group.destination.id,
        destination_type: group.destination.destination_type,
        notify_mode: group.notifyMode,
        digest_bucket: group.digestBucket,
        delivery_count: deliveryIds.length,
        release_count: releaseRows.length,
        duration_ms: Date.now() - startedAt,
        response_code: sendResult?.statusCode ?? null
      });
    } catch (error) {
      failedGroups += 1;

      await finalizeDeliveries(deliveryIds, {
        success: false,
        statusCode: error.statusCode ?? null,
        responseBody: error.responseBody ?? null,
        error,
        rateLimited: Boolean(error.rateLimited || error.statusCode === 429),
        attemptCount
      });

      logNotificationEvent('delivery_group_failed', {
        destination_id: group.destination.id,
        destination_type: group.destination.destination_type,
        notify_mode: group.notifyMode,
        digest_bucket: group.digestBucket,
        delivery_count: deliveryIds.length,
        duration_ms: Date.now() - startedAt,
        response_code: error.statusCode ?? null,
        rate_limited: Boolean(error.rateLimited || error.statusCode === 429),
        error: String(error.message || error),
        abandoned: attemptCount + 1 >= maxAttempts
      });
    }
  }

  return {
    processed_groups: groups.size,
    sent_groups: sentGroups,
    failed_groups: failedGroups
  };
}

async function finalizeDeliveries(deliveryIds, {
  success,
  statusCode = null,
  responseBody = null,
  error = null,
  rateLimited = false,
  attemptCount = 0
}) {
  if (!deliveryIds.length) return;

  const placeholders = deliveryIds.map(() => '?').join(',');
  const now = toMysqlDate(new Date());
  const body = truncateResponseBody(responseBody);
  const code = statusCode === null || statusCode === undefined ? null : Number(statusCode);

  if (success) {
    await pool.query(
      `UPDATE notification_deliveries
       SET status = 'sent',
           last_attempt_at = ?,
           attempt_count = attempt_count + 1,
           next_retry_at = NULL,
           error_message = NULL,
           response_code = ?,
           response_body = ?
       WHERE id IN (${placeholders})`,
      [now, code, body, ...deliveryIds]
    );

    return;
  }

  const nextAttempt = attemptCount + 1;
  const maxAttempts = config.limits.maxDeliveryAttempts;
  const abandoned = nextAttempt >= maxAttempts;
  const retryAfterMs = error?.retryAfterMs
    ? Number(error.retryAfterMs)
    : Math.min(
      60 * 60 * 1000,
      2 ** Math.min(6, attemptCount) * 60 * 1000
    );
  const nextRetryAt = abandoned ? null : toMysqlDate(new Date(Date.now() + retryAfterMs));
  const status = abandoned ? 'failed' : (rateLimited ? 'rate_limited' : 'failed');

  await pool.query(
    `UPDATE notification_deliveries
     SET status = ?,
         last_attempt_at = ?,
         attempt_count = attempt_count + 1,
         next_retry_at = ?,
         error_message = ?,
         response_code = ?,
         response_body = ?
     WHERE id IN (${placeholders})`,
    [
      status,
      now,
      nextRetryAt,
      truncate(String(error?.message || error), 1000),
      code,
      body,
      ...deliveryIds
    ]
  );
}

async function sendReleasesToDestination(destination, releases, options = {}) {
  if (!releases.length) return null;

  const locale = parseLocale(options.locale ?? serverLocale);
  const { notifyMode = 'immediate', isTest = false } = options;
  const sendOpts = { notifyMode, isTest, locale };

  if (destination.destination_type === 'email') {
    return sendEmailDestination(destination, releases, sendOpts);
  }

  if (destination.destination_type === 'discord_webhook') {
    return sendDiscordDestination(destination, releases, sendOpts);
  }

  if (destination.destination_type === 'teams_webhook') {
    return sendTeamsDestination(destination, releases, sendOpts);
  }

  if (destination.destination_type === 'generic_webhook') {
    return sendGenericWebhookDestination(destination, releases, sendOpts);
  }

  if (destination.destination_type === 'slack_webhook') {
    return sendDestinationPush(destination, releases, sendOpts);
  }

  throw new Error(`Destination inconnue : ${destination.destination_type}`);
}

function buildEmailSubject(releases, { notifyMode = 'immediate', isTest = false, locale = serverLocale } = {}) {
  const lang = parseLocale(locale);

  if (isTest) {
    return t(lang, 'notify.test_email_subject');
  }

  if (notifyMode === 'hourly_digest') {
    return t(lang, 'notify.hourly.subject', { count: releases.length });
  }

  if (notifyMode === 'daily_digest') {
    return t(lang, 'notify.daily.subject', { count: releases.length });
  }

  if (releases.length === 1) {
    return t(lang, 'notify.new_one', { name: releases[0].iso_name || releases[0].filename });
  }

  return t(lang, 'notify.new_many', { count: releases.length });
}

async function sendEmailDestination(destination, releases, options = {}) {
  const { notifyMode = 'immediate', isTest = false, locale = serverLocale } = options;
  const html = buildEmailHtml(releases, { notifyMode, isTest, locale });
  const subject = buildEmailSubject(releases, { notifyMode, isTest, locale });

  logNotificationEvent('email_send_start', {
    destination_id: destination.id,
    target: maskTargetForLog(destination),
    release_count: releases.length,
    notify_mode: notifyMode,
    is_test: isTest
  });

  const startedAt = Date.now();

  try {
    const info = await mailer.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromAddress}>`,
      to: destination.target,
      subject,
      html
    });

    logNotificationEvent('email_send_success', {
      destination_id: destination.id,
      target: maskTargetForLog(destination),
      release_count: releases.length,
      notify_mode: notifyMode,
      is_test: isTest,
      duration_ms: Date.now() - startedAt,
      response_code: 250,
      message_id: info.messageId || null
    });

    return {
      statusCode: 250,
      body: info.messageId || 'accepted'
    };
  } catch (error) {
    logNotificationEvent('email_send_failed', {
      destination_id: destination.id,
      target: maskTargetForLog(destination),
      release_count: releases.length,
      notify_mode: notifyMode,
      is_test: isTest,
      duration_ms: Date.now() - startedAt,
      error: String(error.message || error)
    });

    throw error;
  }
}

async function sendDiscordDestination(destination, releases, options = {}) {
  const chunks = chunkDiscordEmbeds(releases, {
    ...options,
    locale: parseLocale(options.locale ?? serverLocale)
  });
  let lastResponse = null;

  for (const chunk of chunks) {
    lastResponse = await postJsonWithRateLimit(destination.target, { embeds: chunk }, 'discord');
    await sleep(Math.ceil(60000 / config.limits.discordMaxMessagesPerMinute));
  }

  return lastResponse;
}

function resolveTeamsOutboundPayload(connectorPayload, destinationConfig = {}) {
  const mode = String(destinationConfig.teams_payload || '').trim().toLowerCase();

  if (mode === 'adaptive' || mode === 'adaptive_card') {
    const content = connectorPayload?.attachments?.[0]?.content;

    if (content) {
      return content;
    }
  }

  return connectorPayload;
}

async function sendTeamsDestination(destination, releases, options = {}) {
  const chunks = chunkTeamsCards(releases, {
    ...options,
    locale: parseLocale(options.locale ?? serverLocale)
  });
  const destinationConfig = parseJsonObject(destination.config);
  let lastResponse = null;

  for (const payload of chunks) {
    const outbound = resolveTeamsOutboundPayload(payload, destinationConfig);
    lastResponse = await postJsonWithRateLimit(destination.target, outbound, 'teams');
    await sleep(Math.ceil(1000 / config.limits.teamsMaxRequestsPerSecond));
  }

  return lastResponse;
}

async function sendGenericWebhookDestination(destination, releases, options = {}) {
  const { notifyMode = 'immediate', isTest = false } = options;
  const parsedConfig = parseJsonObject(destination.config);
  const headers = typeof parsedConfig.headers === 'object' && parsedConfig.headers !== null ? parsedConfig.headers : {};

  return postJsonWithRateLimit(
    destination.target,
    {
      event: isTest ? 'iso_watcher_test' : 'iso_releases_detected',
      notify_mode: notifyMode,
      count: releases.length,
      releases
    },
    'generic',
    headers
  );
}

function buildDigestIntro(notifyMode, releaseCount, isTest = false, locale = serverLocale) {
  const lang = parseLocale(locale);

  if (isTest) {
    return t(lang, 'notify.test_intro');
  }

  if (notifyMode === 'hourly_digest') {
    return t(lang, 'notify.hourly.intro', { count: releaseCount });
  }

  if (notifyMode === 'daily_digest') {
    return t(lang, 'notify.daily.intro', { count: releaseCount });
  }

  return t(lang, 'notify.detected_intro', { count: releaseCount });
}

function buildEmailHtml(releases, { notifyMode = 'immediate', isTest = false, locale = serverLocale } = {}) {
  const lang = parseLocale(locale);
  const intro = buildDigestIntro(notifyMode, releases.length, isTest, lang);

  const rows = releases.map((release) => `
    <tr>
      <td>${notifyEscapeHtml(release.distribution || '')}</td>
      <td>${notifyEscapeHtml(release.iso_name || release.filename)}</td>
      <td>${notifyEscapeHtml(release.version || '')}</td>
      <td>${notifyEscapeHtml(release.architecture || '')}</td>
      <td>${notifyEscapeHtml(notifyFormatFileSize(release.file_size))}</td>
      <td><a href="${notifyEscapeHtml(release.url)}">${notifyEscapeHtml(t(lang, 'notify.download'))}</a></td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="${localeBcp47(lang)}">
<head>
  <meta charset="utf-8">
  <title>ISO Watcher</title>
</head>
<body style="font-family: Arial, sans-serif; color: #111827;">
  <h2>${notifyEscapeHtml(isTest ? t(lang, 'notify.test_email_heading') : t(lang, 'notify.new_email_title'))}</h2>
  ${intro}
  <table border="1" cellspacing="0" cellpadding="8" style="border-collapse: collapse; width: 100%;">
    <thead>
      <tr>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.distribution'))}</th>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.name'))}</th>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.version'))}</th>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.architecture'))}</th>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.size'))}</th>
        <th align="left">${notifyEscapeHtml(t(lang, 'notify.col.link'))}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function chunkDiscordEmbeds(releases, { notifyMode = 'immediate', isTest = false, locale = serverLocale } = {}) {
  const lang = parseLocale(locale);
  const unspecified = t(lang, 'notify.discord.arch_unknown');
  const digestFooter = isTest
    ? t(lang, 'notify.test.title')
    : notifyMode === 'hourly_digest'
      ? t(lang, 'notify.hourly.footer')
      : notifyMode === 'daily_digest'
        ? t(lang, 'notify.daily.footer')
        : null;

  const embeds = releases.map((release) => {
    const description = [
      release.version ? t(lang, 'notify.discord.version', { version: release.version }) : '',
      t(lang, 'notify.discord.arch', { arch: release.architecture || unspecified }),
      t(lang, 'notify.discord.size', { size: notifyFormatFileSize(release.file_size) }),
      t(lang, 'notify.discord.file', { file: release.filename })
    ].filter(Boolean).join('\n');

    return {
      title: notifyTruncate(t(lang, 'notify.discord.new_iso', { name: release.iso_name || release.filename }), 256),
      url: release.url,
      description: notifyTruncate(description, 4096),
      fields: [
        {
          name: t(lang, 'notify.col.distribution'),
          value: notifyTruncate(release.distribution || unspecified, 1024),
          inline: true
        },
        {
          name: t(lang, 'notify.col.architecture'),
          value: notifyTruncate(release.architecture || unspecified, 1024),
          inline: true
        },
        {
          name: t(lang, 'notify.col.version'),
          value: notifyTruncate(release.version || unspecified, 1024),
          inline: true
        }
      ],
      timestamp: new Date(release.detected_at || Date.now()).toISOString(),
      footer: digestFooter ? { text: digestFooter } : undefined
    };
  });

  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const embed of embeds) {
    const chars = JSON.stringify(embed).length;

    if (
      current.length >= config.limits.discordMaxEmbedsPerMessage ||
      currentChars + chars > config.limits.discordMaxEmbedChars
    ) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(embed);
    currentChars += chars;
  }

  if (current.length) chunks.push(current);

  return chunks;
}

function chunkTeamsCards(releases, { notifyMode = 'immediate', isTest = false, locale = serverLocale } = {}) {
  const lang = parseLocale(locale);
  const cards = [];
  let currentFacts = [];

  for (const release of releases) {
    const fact = {
      title: `${release.iso_name || release.filename}`,
      value: `${release.version || t(lang, 'notify.teams.unknown_version')} | ${release.architecture || t(lang, 'notify.teams.unknown_arch')} | ${release.url}`
    };

    const nextFacts = [...currentFacts, fact];
    const candidate = buildTeamsPayload(nextFacts);

    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') > config.limits.teamsMaxPayloadBytes &&
      currentFacts.length
    ) {
      cards.push(buildTeamsPayload(currentFacts, { notifyMode, isTest, locale: lang }));
      currentFacts = [fact];
    } else {
      currentFacts = nextFacts;
    }
  }

  if (currentFacts.length) {
    cards.push(buildTeamsPayload(currentFacts, { notifyMode, isTest, locale: lang }));
  }

  return cards;
}

function buildTeamsPayload(facts, { notifyMode = 'immediate', isTest = false, locale = serverLocale } = {}) {
  const lang = parseLocale(locale);
  let title = t(lang, 'notify.new_email_title');

  if (isTest) {
    title = t(lang, 'notify.test.title');
  } else if (notifyMode === 'hourly_digest') {
    title = t(lang, 'notify.hourly.footer');
  } else if (notifyMode === 'daily_digest') {
    title = t(lang, 'notify.daily.footer');
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts
            }
          ]
        }
      }
    ]
  };
}

function buildPreview(destinationType, releases, { locale = serverLocale } = {}) {
  const lang = parseLocale(locale);

  if (destinationType === 'email') {
    return {
      type: 'email',
      html: buildEmailHtml(releases, { locale: lang })
    };
  }

  if (destinationType === 'discord_webhook') {
    return {
      type: 'discord_webhook',
      payloads: chunkDiscordEmbeds(releases, { locale: lang }).map((embeds) => ({ embeds }))
    };
  }

  if (destinationType === 'teams_webhook') {
    return {
      type: 'teams_webhook',
      payloads: chunkTeamsCards(releases, { locale: lang })
    };
  }

  if (destinationType === 'slack_webhook') {
    return {
      type: destinationType,
      title: buildReleaseNotificationTitle(releases, { locale: lang }),
      text: buildReleasePlainText(releases, { locale: lang })
    };
  }

  return {
    type: 'generic_webhook',
    payload: {
      event: 'iso_releases_detected',
      count: releases.length,
      releases
    }
  };
}

async function getReleaseRow(releaseId) {
  return getOne(
    `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition, i.version_track
     FROM iso_releases r
     JOIN iso_items i ON i.id = r.iso_item_id
     WHERE r.id = ?`,
    [releaseId]
  );
}

async function getReleaseRowsByIds(ids) {
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');

  const [rows] = await pool.query(
    `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition, i.version_track
     FROM iso_releases r
     JOIN iso_items i ON i.id = r.iso_item_id
     WHERE r.id IN (${placeholders})
     ORDER BY r.detected_at ASC`,
    ids
  );

  return rows;
}

async function getReleasesDetectedSince(hours) {
  const since = sqlDetectedSince('r.detected_at', hours, dbDriver);
  const [rows] = await pool.query(
    `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition
     FROM iso_releases r
     JOIN iso_items i ON i.id = r.iso_item_id
     WHERE ${since.clause}
     ORDER BY r.detected_at DESC`,
    since.params
  );

  return rows;
}

async function listReleasesForLinkCheck() {
  const [rows] = await pool.query(
    `SELECT r.*, i.name AS iso_name, i.distribution, i.architecture, i.edition,
            s.allow_insecure_tls
     FROM iso_releases r
     JOIN iso_items i ON i.id = r.iso_item_id
     LEFT JOIN iso_sources s ON s.id = r.source_id
     ORDER BY r.id ASC`
  );

  return rows;
}

function isHttpUrlReachableStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300 || statusCode === 206;
}

function shouldRemoveReleaseForProbe(probe) {
  if (probe.ok) {
    return false;
  }

  const status = probe.statusCode;

  if (status === 404 || status === 410) {
    return true;
  }

  if (status === 401 || status === 403) {
    return true;
  }

  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true;
  }

  if (status >= 500) {
    return false;
  }

  return Boolean(probe.permanentFailure);
}

async function verifyReleaseLink(release) {
  const url = String(release.url || '').trim();

  if (!url) {
    return {
      ok: false,
      statusCode: null,
      reason: 'url_vide',
      permanentFailure: true
    };
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      statusCode: null,
      reason: 'url_invalide',
      permanentFailure: true
    };
  }

  const allowInsecureTls = Boolean(release.allow_insecure_tls);
  const timeoutMs = Math.min(config.timeouts.httpMs, 20000);

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    let probe = await httpProbeUrl(url, allowInsecureTls, timeoutMs);

    if (!probe.ok && probe.retryable) {
      await sleep(1500);
      probe = await httpProbeUrl(url, allowInsecureTls, timeoutMs);
    }

    return {
      ok: probe.ok,
      statusCode: probe.statusCode,
      reason: probe.error || (probe.ok ? null : `HTTP ${probe.statusCode}`),
      permanentFailure: !probe.ok && !probe.retryable
    };
  }

  if (parsed.protocol === 'ftp:') {
    const probe = await ftpProbeUrl(url, config.timeouts.ftpMs);

    return {
      ok: probe.ok,
      statusCode: null,
      reason: probe.error || (probe.ok ? null : 'ftp_inaccessible'),
      permanentFailure: !probe.ok
    };
  }

  return {
    ok: false,
    statusCode: null,
    reason: 'protocole_non_pris_en_charge',
    permanentFailure: true
  };
}

async function runReleaseLinkValidation({
  notifyChannels,
  sendAdminReport = true,
  reportHours = config.linkCheck.reportHours
} = {}) {
  if (releaseLinkCheckRunning) {
    return { skipped: true, reason: 'already_running' };
  }

  releaseLinkCheckRunning = true;
  const startedAt = Date.now();

  try {
    const releases = await listReleasesForLinkCheck();
    const removedReleases = [];

    await runLimited(releases, config.linkCheck.concurrency, async (release) => {
      const probe = await verifyReleaseLink(release);

      if (!shouldRemoveReleaseForProbe(probe)) {
        if (!probe.ok) {
          app.log.warn({
            release_id: release.id,
            url: release.url,
            reason: probe.reason,
            status: probe.statusCode
          }, 'Lien release temporairement inaccessible (conservée)');
        }

        return;
      }

      const snapshot = {
        ...release,
        removal_reason: probe.reason || 'lien_invalide',
        http_status: probe.statusCode ?? null,
        removed_at: new Date().toISOString()
      };

      await storage.onReleaseRemoved(release);
      await pool.query('DELETE FROM iso_releases WHERE id = ?', [release.id]);
      await refreshLatestRelease(release.iso_item_id);
      removedReleases.push(snapshot);

      app.log.info({
        release_id: release.id,
        iso_item_id: release.iso_item_id,
        url: release.url,
        reason: probe.reason,
        status: probe.statusCode
      }, 'Release supprimée (lien invalide)');
    });

    const newReleases = await getReleasesDetectedSince(reportHours);
    const removedPayload = removedReleases.map((row) => ({
      id: row.id,
      iso_name: row.iso_name,
      filename: row.filename,
      version: row.version,
      url: row.url,
      distribution: row.distribution,
      file_size: row.file_size,
      removal_reason: row.removal_reason,
      reason: row.removal_reason,
      http_status: row.http_status
    }));

    const result = {
      skipped: false,
      checked: releases.length,
      valid: releases.length - removedReleases.length,
      removed: removedReleases.length,
      new_in_period: newReleases.length,
      report_hours: reportHours,
      duration_ms: Date.now() - startedAt,
      removed_releases: removedPayload,
      new_releases: newReleases.map((row) => ({
        id: row.id,
        iso_name: row.iso_name,
        filename: row.filename,
        version: row.version,
        url: row.url,
        distribution: row.distribution,
        file_size: row.file_size,
        detected_at: row.detected_at
      }))
    };

    const channels = adminNotify.resolveChannels({
      notifyChannels,
      sendAdminReport,
      kind: 'link_check'
    });

    if (channels.length) {
      try {
        const notifyOut = await adminNotify.notifyLinkCheckReport({
          newReleases,
          removedReleases: removedPayload,
          stats: result,
          channels
        });
        result.report_id = notifyOut.reportId;
        result.notify_results = notifyOut.results;
      } catch (error) {
        app.log.error(error, 'Échec notification / rapport admin');
        result.admin_report_error = String(error.message || error);
      }
    }

    return result;
  } finally {
    releaseLinkCheckRunning = false;
  }
}

function parseContentLengthHeader(headers) {
  const raw = headers['content-length'];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);

  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function parseTotalSizeFromContentRange(headers) {
  const raw = headers['content-range'];
  const value = String(Array.isArray(raw) ? raw[0] : raw || '');
  const match = value.match(/\/(\d+)$/);

  if (!match) {
    return null;
  }

  const total = Number(match[1]);

  return Number.isFinite(total) && total > 0 ? total : null;
}

async function httpFetchContentLength(targetUrl, allowInsecureTls, timeoutMs, redirectCount = 0, method = 'HEAD') {
  if (redirectCount > 5) {
    return null;
  }

  const probe = await new Promise((resolve) => {
    let parsed;

    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve(null);
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve(null);
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': `iso-watcher/${APP_VERSION}`
    };

    if (method === 'GET') {
      headers.Range = 'bytes=0-0';
    }

    const options = {
      method,
      timeout: timeoutMs,
      headers
    };

    if (parsed.protocol === 'https:') {
      options.agent = new https.Agent({
        rejectUnauthorized: !allowInsecureTls
      });
    }

    const req = transport.request(parsed, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const redirectedUrl = new URL(res.headers.location, targetUrl).toString();

        httpFetchContentLength(redirectedUrl, allowInsecureTls, timeoutMs, redirectCount + 1, method)
          .then(resolve);

        return;
      }

      res.resume();

      const fromLength = parseContentLengthHeader(res.headers);
      const fromRange = parseTotalSizeFromContentRange(res.headers);
      const statusCode = res.statusCode;
      const needsGetFallback = method === 'HEAD'
        && !fromLength
        && !fromRange
        && [405, 403, 501].includes(statusCode);

      resolve({
        size: fromLength || fromRange,
        needsGetFallback
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => resolve(null));
    req.end();
  });

  if (!probe) {
    return null;
  }

  if (probe.size) {
    return probe.size;
  }

  if (probe.needsGetFallback) {
    return httpFetchContentLength(targetUrl, allowInsecureTls, timeoutMs, redirectCount, 'GET');
  }

  return null;
}

async function ftpFetchFileSize(targetUrl, timeoutMs) {
  const client = new ftp.Client(timeoutMs);

  client.ftp.verbose = false;

  try {
    const parsed = new URL(targetUrl);
    await client.access({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 21,
      user: decodeURIComponent(parsed.username || 'anonymous'),
      password: decodeURIComponent(parsed.password || 'anonymous@'),
      secure: false
    });

    const filePath = decodeURIComponent(parsed.pathname || '/');
    const size = await client.size(filePath);

    return Number.isFinite(size) && size > 0 ? Math.round(size) : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

async function httpProbeUrl(targetUrl, allowInsecureTls, timeoutMs, redirectCount = 0, method = 'HEAD') {
  if (redirectCount > 5) {
    return {
      ok: false,
      statusCode: null,
      error: 'trop_de_redirections',
      retryable: false
    };
  }

  return new Promise((resolve) => {
    let parsed;

    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve({
        ok: false,
        statusCode: null,
        error: 'url_invalide',
        retryable: false
      });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': `iso-watcher/${APP_VERSION}`
    };

    if (method === 'GET') {
      headers.Range = 'bytes=0-0';
    }

    const options = {
      method,
      timeout: timeoutMs,
      headers
    };

    if (parsed.protocol === 'https:') {
      options.agent = new https.Agent({
        rejectUnauthorized: !allowInsecureTls
      });
    }

    const req = transport.request(parsed, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const redirectedUrl = new URL(res.headers.location, targetUrl).toString();

        httpProbeUrl(redirectedUrl, allowInsecureTls, timeoutMs, redirectCount + 1, method)
          .then(resolve);

        return;
      }

      res.resume();

      const statusCode = res.statusCode;

      if (isHttpUrlReachableStatus(statusCode)) {
        resolve({
          ok: true,
          statusCode,
          error: null,
          retryable: false
        });
        return;
      }

      if (method === 'HEAD' && [405, 403, 501].includes(statusCode)) {
        httpProbeUrl(targetUrl, allowInsecureTls, timeoutMs, redirectCount, 'GET')
          .then(resolve);
        return;
      }

      resolve({
        ok: false,
        statusCode,
        error: `HTTP ${statusCode}`,
        retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        statusCode: null,
        error: 'timeout',
        retryable: true
      });
    });

    req.on('error', (error) => {
      resolve({
        ok: false,
        statusCode: null,
        error: String(error.message || error),
        retryable: false
      });
    });

    req.end();
  });
}

async function ftpProbeUrl(targetUrl, timeoutMs) {
  const client = new ftp.Client(timeoutMs);

  client.ftp.verbose = false;

  try {
    const parsed = new URL(targetUrl);
    await client.access({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 21,
      user: decodeURIComponent(parsed.username || 'anonymous'),
      password: decodeURIComponent(parsed.password || 'anonymous@'),
      secure: false
    });

    const filePath = decodeURIComponent(parsed.pathname || '/');

    await client.size(filePath);

    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || error)
    };
  } finally {
    client.close();
  }
}

function buildFakeReleaseRows(matches, source) {
  if (matches.length) {
    return matches.map((match, index) => ({
      id: index,
      iso_name: source?.iso_name || 'ISO test',
      distribution: source?.distribution || 'test',
      architecture: source?.architecture || 'amd64',
      version: match.version || 'version inconnue',
      filename: match.filename,
      url: match.url,
      detected_at: new Date().toISOString()
    }));
  }

  return [
    {
      id: 0,
      iso_name: source?.iso_name || 'ISO Watcher Test',
      distribution: source?.distribution || 'test',
      architecture: source?.architecture || 'amd64',
      version: '0.0.0-test',
      filename: 'iso-watcher-test.iso',
      url: 'https://example.local/iso-watcher-test.iso',
      detected_at: new Date().toISOString()
    }
  ];
}

async function httpGetText(targetUrl, allowInsecureTls, timeoutMs, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error('Trop de redirections HTTP');
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const options = {
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': `iso-watcher/${APP_VERSION}`
      }
    };

    if (parsed.protocol === 'https:') {
      options.agent = new https.Agent({
        rejectUnauthorized: !allowInsecureTls
      });
    }

    const req = transport.request(parsed, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();

        const redirectedUrl = new URL(res.headers.location, targetUrl).toString();

        httpGetText(redirectedUrl, allowInsecureTls, timeoutMs, redirectCount + 1)
          .then(resolve)
          .catch(reject);

        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} sur ${targetUrl}`));
        return;
      }

      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          let buffer = Buffer.concat(chunks);
          const contentEncoding = String(res.headers['content-encoding'] || '').toLowerCase();

          if (contentEncoding.includes('gzip')) {
            buffer = zlib.gunzipSync(buffer);
          } else if (contentEncoding.includes('deflate')) {
            buffer = zlib.inflateSync(buffer);
          } else if (contentEncoding.includes('br')) {
            buffer = zlib.brotliDecompressSync(buffer);
          }

          resolve({
            statusCode: res.statusCode,
            contentEncoding: contentEncoding || null,
            body: buffer.toString('utf8')
          });
        } catch (error) {
          reject(new Error(`Échec décompression HTTP (${res.headers['content-encoding'] || 'binaire'}) : ${error.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout HTTP sur ${targetUrl}`));
    });

    req.on('error', reject);
    req.end();
  });
}

function createWebhookDeliveryError(type, response, { rateLimited = false, retryAfterMs = null } = {}) {
  const error = new Error(`${type} webhook HTTP ${response.statusCode}: ${truncateResponseBody(response.body, 500)}`);
  error.statusCode = response.statusCode;
  error.responseBody = truncateResponseBody(response.body);
  error.rateLimited = rateLimited;
  error.retryAfterMs = retryAfterMs;
  return error;
}

async function postJsonWithRateLimit(targetUrl, payload, type, extraHeaders = {}) {
  let lastRetryAfterMs = 5000;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await postJson(targetUrl, payload, extraHeaders);

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return {
        statusCode: response.statusCode,
        body: truncateResponseBody(response.body, 500) || 'ok'
      };
    }

    if (response.statusCode === 429) {
      lastRetryAfterMs = getRetryAfterMs(response);
      await sleep(lastRetryAfterMs);
      continue;
    }

    if (response.statusCode >= 500 && attempt < 5) {
      await sleep(attempt * 2000);
      continue;
    }

    throw createWebhookDeliveryError(type, response, {
      rateLimited: response.statusCode === 429,
      retryAfterMs: response.statusCode === 429 ? lastRetryAfterMs : null
    });
  }

  throw createWebhookDeliveryError(
    type,
    { statusCode: 429, body: 'rate limit persistant' },
    { rateLimited: true, retryAfterMs: lastRetryAfterMs }
  );
}

async function postJson(targetUrl, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': `iso-watcher/${APP_VERSION}`,
      ...extraHeaders
    };

    const req = transport.request(parsed, {
      method: 'POST',
      headers,
      timeout: config.timeouts.httpMs
    }, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout webhook sur ${targetUrl}`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getRetryAfterMs(response) {
  const header = response.headers['retry-after'];

  if (header) {
    const seconds = Number(Array.isArray(header) ? header[0] : header);

    if (Number.isFinite(seconds)) {
      return Math.max(1000, seconds * 1000);
    }
  }

  try {
    const parsed = JSON.parse(response.body || '{}');

    if (Number.isFinite(Number(parsed.retry_after))) {
      return Math.max(1000, Number(parsed.retry_after) * 1000);
    }
  } catch {
    return 5000;
  }

  return 5000;
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from({
    length: Math.min(limit, items.length)
  }, () => runner());

  await Promise.all(runners);

  return results;
}

function addFilter(filters, params, column, value) {
  if (value === undefined || value === null || value === '') return;

  filters.push(`${column} = ?`);
  params.push(value);
}

function addBoolFilter(filters, params, column, value) {
  if (value === undefined || value === null || value === '') return;

  filters.push(`${column} = ?`);
  params.push(parseBool(value, false) ? 1 : 0);
}

function normalizeEmail(email) {
  if (!email) return null;

  return String(email).trim().toLowerCase();
}

function detectProtocol(targetUrl) {
  const parsed = new URL(targetUrl);
  const protocol = parsed.protocol.replace(':', '');

  if (!['http', 'https', 'ftp'].includes(protocol)) {
    throw new Error(`Protocole non supporté : ${protocol}`);
  }

  return protocol;
}

function filenameFromUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  const pathname = decodeURIComponent(parsed.pathname || '');
  const filename = pathname.split('/').filter(Boolean).pop();

  return filename || targetUrl;
}

function joinFtpUrl(baseUrl, filename) {
  const parsed = new URL(baseUrl);

  let path = parsed.pathname || '/';

  if (!path.endsWith('/')) {
    path += '/';
  }

  parsed.pathname = `${path}${encodeURIComponent(filename)}`;
  parsed.username = '';
  parsed.password = '';

  return parsed.toString();
}

function joinFtpPath(baseUrl, segment) {
  const parsed = new URL(baseUrl);
  let path = parsed.pathname || '/';

  if (!path.endsWith('/')) {
    path += '/';
  }

  const clean = String(segment || '').replace(/^\/+/, '').replace(/\/+$/, '');

  parsed.pathname = `${path}${clean}/`;
  parsed.username = '';
  parsed.password = '';

  return parsed.toString();
}

function dedupeMatches(matches) {
  const seen = new Set();
  const result = [];

  for (const match of matches) {
    const key = `${match.filename}|${match.url}`;

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(match);
  }

  return result;
}

function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const pa = String(a).match(/\d+|[a-zA-Z]+/g) || [String(a)];
  const pb = String(b).match(/\d+|[a-zA-Z]+/g) || [String(b)];
  const max = Math.max(pa.length, pb.length);

  for (let i = 0; i < max; i += 1) {
    const va = pa[i] || '0';
    const vb = pb[i] || '0';
    const na = Number(va);
    const nb = Number(vb);

    if (
      Number.isFinite(na) &&
      Number.isFinite(nb) &&
      String(na) === va.replace(/^0+/, '') &&
      String(nb) === vb.replace(/^0+/, '')
    ) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else {
      const cmp = va.localeCompare(vb, undefined, {
        numeric: true,
        sensitivity: 'base'
      });

      if (cmp !== 0) return cmp > 0 ? 1 : -1;
    }
  }

  return 0;
}

function toMysqlDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function truncate(value, maxLength) {
  const str = String(value ?? '');

  if (str.length <= maxLength) return str;

  return `${str.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
