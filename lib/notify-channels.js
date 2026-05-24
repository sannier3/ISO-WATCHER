/**
 * Canaux de notification partagés (admin + destinations utilisateurs).
 * Configuration simple : URL webhook, topic ntfy, ou paires token + id en .env ou config JSON.
 */
import http from 'node:http';
import https from 'node:https';
import { APP_VERSION } from './config.js';

export const ADMIN_NOTIFY_CHANNELS = new Set([
  'email', 'discord', 'teams', 'webhook', 'ui',
  'slack', 'telegram', 'ntfy', 'pushover', 'matrix'
]);

export const DESTINATION_TYPES = [
  {
    type: 'email',
    name: 'E-mail HTML',
    supports_grouping: true,
    target_label: 'Adresse e-mail',
    config_fields: [],
    setup_hint: 'Adresse de réception des alertes ISO.'
  },
  {
    type: 'discord_webhook',
    name: 'Discord Webhook',
    supports_embeds: true,
    supports_grouping: true,
    target_label: 'URL du webhook Discord',
    config_fields: [],
    setup_hint: 'Paramètres du salon Discord → Intégrations → Webhooks.'
  },
  {
    type: 'teams_webhook',
    name: 'Microsoft Teams',
    supports_adaptive_cards: true,
    supports_grouping: true,
    target_label: 'URL Workflow / Incoming Webhook Teams',
    config_fields: [],
    setup_hint: 'Workflow Teams avec déclencheur « When a webhook request is received ».'
  },
  {
    type: 'slack_webhook',
    name: 'Slack',
    supports_grouping: true,
    target_label: 'URL Incoming Webhook Slack',
    config_fields: [],
    setup_hint: 'Slack → Applications → Incoming Webhooks → copier l’URL.'
  },
  {
    type: 'telegram',
    name: 'Telegram',
    supports_grouping: true,
    target_label: 'Chat ID (nombre ou @canal)',
    config_fields: [{ key: 'bot_token', label: 'Token du bot', secret: true, required: true }],
    setup_hint: 'Créer un bot via @BotFather ; obtenir le chat_id (ex. @userinfobot ou getUpdates).'
  },
  {
    type: 'ntfy',
    name: 'ntfy',
    supports_grouping: true,
    target_label: 'Nom du topic',
    config_fields: [
      { key: 'server', label: 'Serveur ntfy (optionnel)', placeholder: 'https://ntfy.sh' },
      { key: 'priority', label: 'Priorité (default|low|high|urgent)', placeholder: 'default' },
      { key: 'tags', label: 'Tags (virgules)', placeholder: 'iso,alert' }
    ],
    setup_hint: 'Souscrire au topic dans l’app ntfy (ex. topic « iso-watcher » sur ntfy.sh).'
  },
  {
    type: 'pushover',
    name: 'Pushover',
    supports_grouping: true,
    target_label: 'Clé utilisateur Pushover',
    config_fields: [{ key: 'app_token', label: 'Token application', secret: true, required: true }],
    setup_hint: 'Compte pushover.net → clé utilisateur + token d’application.'
  },
  {
    type: 'matrix',
    name: 'Matrix',
    supports_grouping: true,
    target_label: 'ID de salon (!xxx:serveur)',
    config_fields: [
      { key: 'homeserver', label: 'URL du serveur Matrix', required: true, placeholder: 'https://matrix.org' },
      { key: 'access_token', label: 'Access token', secret: true, required: true }
    ],
    setup_hint: 'Element → Paramètres → Aide → Access Token ; ID du salon dans les paramètres du salon.'
  },
  {
    type: 'generic_webhook',
    name: 'Webhook JSON générique',
    supports_grouping: true,
    target_label: 'URL du webhook',
    config_fields: [{ key: 'headers', label: 'En-têtes HTTP (objet JSON)', placeholder: '{}' }],
    setup_hint: 'URL recevant un POST JSON (n8n, scripts, etc.).'
  }
];

const DESTINATION_TYPE_SET = new Set(DESTINATION_TYPES.map((d) => d.type));

export function parseAdminChannelList(raw, fallback = ['email', 'ui']) {
  if (!raw || !String(raw).trim()) {
    return [...fallback];
  }

  const list = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => ADMIN_NOTIFY_CHANNELS.has(c));

  return list.length ? [...new Set(list)] : [...fallback];
}

export function loadAdminNotifyCredentials(config) {
  const admin = config?.admin || {};

  return {
    email: String(admin.email || process.env.ADMIN_EMAIL || '').trim(),
    discordWebhook: String(admin.discordWebhook || '').trim(),
    teamsWebhook: String(admin.teamsWebhook || '').trim(),
    genericWebhook: String(admin.genericWebhook || '').trim(),
    slackWebhook: String(admin.slackWebhook || '').trim(),
    telegramBotToken: String(admin.telegramBotToken || '').trim(),
    telegramChatId: String(admin.telegramChatId || '').trim(),
    ntfyServer: String(admin.ntfyServer || 'https://ntfy.sh').replace(/\/$/, ''),
    ntfyTopic: String(admin.ntfyTopic || '').trim(),
    ntfyPriority: String(admin.ntfyPriority || 'default').trim(),
    ntfyTags: String(admin.ntfyTags || 'iso-watcher').trim(),
    pushoverUserKey: String(admin.pushoverUserKey || '').trim(),
    pushoverAppToken: String(admin.pushoverAppToken || '').trim(),
    matrixHomeserver: String(admin.matrixHomeserver || '').replace(/\/$/, ''),
    matrixAccessToken: String(admin.matrixAccessToken || '').trim(),
    matrixRoomId: String(admin.matrixRoomId || '').trim()
  };
}

export function getAdminChannelAvailability(creds) {
  return {
    email: Boolean(creds.email),
    discord: Boolean(creds.discordWebhook),
    teams: Boolean(creds.teamsWebhook),
    webhook: Boolean(creds.genericWebhook),
    ui: true,
    slack: Boolean(creds.slackWebhook),
    telegram: Boolean(creds.telegramBotToken && creds.telegramChatId),
    ntfy: Boolean(creds.ntfyTopic),
    pushover: Boolean(creds.pushoverUserKey && creds.pushoverAppToken),
    matrix: Boolean(creds.matrixHomeserver && creds.matrixAccessToken && creds.matrixRoomId)
  };
}

export function parseDestinationConfig(value) {
  if (!value) return {};

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function validateDestinationPayload(destinationType, target, config = {}) {
  const type = String(destinationType || '').trim();

  if (!DESTINATION_TYPE_SET.has(type)) {
    throw new Error(`Type de destination inconnu : ${type}`);
  }

  const t = String(target || '').trim();

  if (!t) {
    throw new Error('target est obligatoire');
  }

  if (type === 'email' && !t.includes('@')) {
    throw new Error('Adresse e-mail invalide');
  }

  if (['discord_webhook', 'teams_webhook', 'slack_webhook', 'generic_webhook'].includes(type)) {
    try {
      const u = new URL(t);

      if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('URL invalide');
      }
    } catch {
      throw new Error('URL de webhook invalide');
    }
  }

  if (type === 'telegram' && !String(config.bot_token || '').trim()) {
    throw new Error('config.bot_token est obligatoire pour Telegram');
  }

  if (type === 'pushover' && !String(config.app_token || '').trim()) {
    throw new Error('config.app_token est obligatoire pour Pushover');
  }

  if (type === 'matrix') {
    if (!String(config.homeserver || '').trim()) {
      throw new Error('config.homeserver est obligatoire pour Matrix');
    }

    if (!String(config.access_token || '').trim()) {
      throw new Error('config.access_token est obligatoire pour Matrix');
    }
  }

  return true;
}

export function truncate(value, max = 256) {
  const s = String(value ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeTelegramHtml(value) {
  return escapeHtml(value);
}

export function formatFileSize(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 1) {
    return '-';
  }

  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function buildReleaseNotificationTitle(releases, { notifyMode = 'immediate', isTest = false } = {}) {
  if (isTest) {
    return 'Test ISO Watcher';
  }

  if (notifyMode === 'hourly_digest') {
    return `Résumé horaire — ${releases.length} ISO`;
  }

  if (notifyMode === 'daily_digest') {
    return `Résumé quotidien — ${releases.length} ISO`;
  }

  if (releases.length === 1) {
    return `Nouvelle ISO : ${releases[0].iso_name || releases[0].filename}`;
  }

  return `${releases.length} nouvelles ISO détectées`;
}

export function buildReleasePlainText(releases, { notifyMode = 'immediate', isTest = false } = {}) {
  const lines = [buildReleaseNotificationTitle(releases, { notifyMode, isTest }), ''];

  if (isTest) {
    lines.push('Message de test envoyé par ISO Watcher.', '');
  } else if (notifyMode === 'hourly_digest') {
    lines.push(`Résumé horaire — ${releases.length} version(s).`, '');
  } else if (notifyMode === 'daily_digest') {
    lines.push(`Résumé quotidien — ${releases.length} version(s).`, '');
  }

  for (const release of releases.slice(0, 20)) {
    lines.push(
      `• ${release.iso_name || release.filename}`,
      `  ${release.distribution || '-'} · ${release.version || '-'} · ${release.architecture || '-'}`,
      `  ${formatFileSize(release.file_size)} · ${release.url || '-'}`,
      ''
    );
  }

  if (releases.length > 20) {
    lines.push(`… et ${releases.length - 20} autre(s).`);
  }

  return lines.join('\n').trim();
}

export function buildReleaseTelegramHtml(releases, options = {}) {
  const title = escapeTelegramHtml(buildReleaseNotificationTitle(releases, options));
  const parts = [`<b>${title}</b>`];

  for (const release of releases.slice(0, 15)) {
    const name = escapeTelegramHtml(release.iso_name || release.filename);
    const url = release.url ? escapeTelegramHtml(release.url) : '';
    const meta = escapeTelegramHtml(
      `${release.distribution || '-'} · ${release.version || '-'} · ${formatFileSize(release.file_size)}`
    );

    parts.push(url ? `\n<b>${name}</b>\n${meta}\n<a href="${url}">Télécharger</a>` : `\n<b>${name}</b>\n${meta}`);
  }

  if (releases.length > 15) {
    parts.push(`\n<i>… ${releases.length - 15} autre(s)</i>`);
  }

  return parts.join('');
}

export function maskWebhookUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');

    if (parts.length > 2) {
      parts[parts.length - 1] = '***';
    }

    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return '***';
  }
}

export function maskDestinationTarget(destination) {
  const type = destination?.destination_type;
  const target = String(destination?.target || '');

  if (type === 'email') {
    const [local, domain] = target.split('@');

    if (!domain) return '***';

    return `${local.length <= 2 ? '***' : `${local.slice(0, 2)}***`}@${domain}`;
  }

  if (['discord_webhook', 'teams_webhook', 'slack_webhook', 'generic_webhook'].includes(type)) {
    return maskWebhookUrl(target);
  }

  if (type === 'telegram' || type === 'pushover' || type === 'ntfy') {
    return target.length <= 4 ? '***' : `${target.slice(0, 2)}***${target.slice(-2)}`;
  }

  if (type === 'matrix') {
    return target.length <= 6 ? '***' : `${target.slice(0, 4)}***`;
  }

  return truncate(target, 48);
}

export async function postJson(targetUrl, payload, { timeoutMs = 30000, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': `iso-watcher/${APP_VERSION}`,
        ...extraHeaders
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('timeout', () => req.destroy(new Error(`Timeout sur ${targetUrl}`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function postForm(targetUrl, fields, { timeoutMs = 30000 } = {}) {
  const body = new URLSearchParams(fields).toString();

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': `iso-watcher/${APP_VERSION}`
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('timeout', () => req.destroy(new Error(`Timeout sur ${targetUrl}`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function assertOkResponse(response, label) {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response;
  }

  throw new Error(`${label} HTTP ${response.statusCode}: ${truncate(response.body, 200)}`);
}

export async function postWebhook(url, payload, label = 'Webhook') {
  return assertOkResponse(await postJson(url, payload), label);
}

export async function sendSlackWebhook(webhookUrl, releases, options = {}) {
  const text = buildReleasePlainText(releases, options);

  return postWebhook(webhookUrl, { text }, 'Slack');
}

export async function sendTelegram({ botToken, chatId }, releases, options = {}) {
  if (!botToken || !chatId) {
    throw new Error('Telegram : bot_token et chat_id requis');
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return assertOkResponse(await postJson(url, {
    chat_id: chatId,
    text: buildReleaseTelegramHtml(releases, options),
    parse_mode: 'HTML',
    disable_web_page_preview: false
  }), 'Telegram');
}

export async function sendNtfy({ server, topic, priority, tags }, releases, options = {}) {
  if (!topic) {
    throw new Error('ntfy : topic requis');
  }

  const base = String(server || 'https://ntfy.sh').replace(/\/$/, '');
  const url = `${base}/${encodeURIComponent(topic)}`;
  const title = buildReleaseNotificationTitle(releases, options);
  const message = buildReleasePlainText(releases, options);
  const tagList = String(tags || 'iso-watcher')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(',');

  const headers = {
    Title: truncate(title, 250),
    Tags: tagList,
    Priority: priority || 'default'
  };

  if (releases.length === 1 && releases[0].url) {
    headers.Click = releases[0].url;
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = message;

    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'User-Agent': `iso-watcher/${APP_VERSION}`,
        ...headers
      },
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const response = { statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') };

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response);
        } else {
          reject(new Error(`ntfy HTTP ${response.statusCode}: ${truncate(response.body, 200)}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Timeout ntfy sur ${url}`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function sendPushover({ userKey, appToken }, releases, options = {}) {
  if (!userKey || !appToken) {
    throw new Error('Pushover : user key et app token requis');
  }

  const fields = {
    token: appToken,
    user: userKey,
    title: truncate(buildReleaseNotificationTitle(releases, options), 250),
    message: truncate(buildReleasePlainText(releases, options), 1024),
    priority: '0'
  };

  if (releases.length === 1 && releases[0].url) {
    fields.url = releases[0].url;
    fields.url_title = 'Télécharger';
  }

  return assertOkResponse(await postForm('https://api.pushover.net/1/messages.json', fields), 'Pushover');
}

export async function sendMatrix({ homeserver, accessToken, roomId }, releases, options = {}) {
  if (!homeserver || !accessToken || !roomId) {
    throw new Error('Matrix : homeserver, access_token et room_id requis');
  }

  const txnId = `iw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;

  return assertOkResponse(await postJson(url, {
    msgtype: 'm.text',
    body: buildReleasePlainText(releases, options)
  }, {
    extraHeaders: { Authorization: `Bearer ${accessToken}` }
  }), 'Matrix');
}

export async function sendReleasesToPushChannel(channel, credentials, releases, options = {}) {
  switch (channel) {
    case 'slack':
    case 'slack_webhook':
      return sendSlackWebhook(credentials.webhookUrl || credentials.slackWebhook, releases, options);
    case 'telegram':
      return sendTelegram({
        botToken: credentials.botToken || credentials.telegramBotToken,
        chatId: credentials.chatId || credentials.telegramChatId
      }, releases, options);
    case 'ntfy':
      return sendNtfy({
        server: credentials.server || credentials.ntfyServer,
        topic: credentials.topic || credentials.ntfyTopic,
        priority: credentials.priority || credentials.ntfyPriority,
        tags: credentials.tags || credentials.ntfyTags
      }, releases, options);
    case 'pushover':
      return sendPushover({
        userKey: credentials.userKey || credentials.pushoverUserKey,
        appToken: credentials.appToken || credentials.pushoverAppToken
      }, releases, options);
    case 'matrix':
      return sendMatrix({
        homeserver: credentials.homeserver || credentials.matrixHomeserver,
        accessToken: credentials.accessToken || credentials.matrixAccessToken,
        roomId: credentials.roomId || credentials.matrixRoomId
      }, releases, options);
    default:
      throw new Error(`Canal push inconnu : ${channel}`);
  }
}

export async function sendDestinationPush(destination, releases, options = {}) {
  const config = parseDestinationConfig(destination.config);
  const type = destination.destination_type;

  if (type === 'slack_webhook') {
    return sendSlackWebhook(destination.target, releases, options);
  }

  if (type === 'telegram') {
    return sendTelegram({ botToken: config.bot_token, chatId: destination.target }, releases, options);
  }

  if (type === 'ntfy') {
    return sendNtfy({
      server: config.server,
      topic: destination.target,
      priority: config.priority,
      tags: config.tags
    }, releases, options);
  }

  if (type === 'pushover') {
    return sendPushover({ userKey: destination.target, appToken: config.app_token }, releases, options);
  }

  if (type === 'matrix') {
    return sendMatrix({
      homeserver: config.homeserver,
      accessToken: config.access_token,
      roomId: destination.target
    }, releases, options);
  }

  throw new Error(`Destination push non gérée : ${type}`);
}
