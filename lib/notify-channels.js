/**
 * Canaux de notification partagés (admin + destinations utilisateurs).
 * Configuration simple : URL webhook ou SMTP en .env / config JSON.
 */
import http from 'node:http';
import https from 'node:https';
import { APP_VERSION } from './config.js';
import { parseLocale, t as tLocale } from './locale.js';

export const ADMIN_NOTIFY_CHANNELS = new Set([
  'email', 'discord', 'teams', 'webhook', 'ui', 'slack'
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
    config_fields: [
      {
        key: 'teams_payload',
        label: 'Format POST (connector ou adaptive)',
        placeholder: 'connector',
        hint: 'connector = défaut ISO Watcher. adaptive = carte seule (champ Adaptive Card du flux PA : @{triggerBody()}).'
      }
    ],
    setup_hint: 'Recréer le flux depuis le canal Teams (modèle webhook). Post in=Channel, Team/Channel en listes (pas d’ID 19:…@thread.tacv2). Canal privé : Post as User. Canal public : Post as Flow bot + bots autorisés. Carte : @{items(\'Apply_to_each\')?[\'content\']}.'
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
    slackWebhook: String(admin.slackWebhook || '').trim()
  };
}

export function getAdminChannelAvailability(creds) {
  return {
    email: Boolean(creds.email),
    discord: Boolean(creds.discordWebhook),
    teams: Boolean(creds.teamsWebhook),
    webhook: Boolean(creds.genericWebhook),
    ui: true,
    slack: Boolean(creds.slackWebhook)
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

export function buildReleaseNotificationTitle(releases, { notifyMode = 'immediate', isTest = false, locale = 'fr' } = {}) {
  const lang = parseLocale(locale);

  if (isTest) {
    return tLocale(lang, 'notify.test.title');
  }

  if (notifyMode === 'hourly_digest') {
    return tLocale(lang, 'notify.hourly.title', { count: releases.length });
  }

  if (notifyMode === 'daily_digest') {
    return tLocale(lang, 'notify.daily.title', { count: releases.length });
  }

  if (releases.length === 1) {
    return tLocale(lang, 'notify.new_one', { name: releases[0].iso_name || releases[0].filename });
  }

  return tLocale(lang, 'notify.new_many', { count: releases.length });
}

export function buildReleasePlainText(releases, { notifyMode = 'immediate', isTest = false, locale = 'fr' } = {}) {
  const lang = parseLocale(locale);
  const lines = [buildReleaseNotificationTitle(releases, { notifyMode, isTest, locale: lang }), ''];

  if (isTest) {
    lines.push(tLocale(lang, 'notify.test.body'), '');
  } else if (notifyMode === 'hourly_digest') {
    lines.push(tLocale(lang, 'notify.hourly.summary', { count: releases.length }), '');
  } else if (notifyMode === 'daily_digest') {
    lines.push(tLocale(lang, 'notify.daily.summary', { count: releases.length }), '');
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
    lines.push(tLocale(lang, 'notify.more_releases', { count: releases.length - 20 }));
  }

  return lines.join('\n').trim();
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

export async function sendReleasesToPushChannel(channel, credentials, releases, options = {}) {
  if (channel === 'slack' || channel === 'slack_webhook') {
    return sendSlackWebhook(credentials.webhookUrl || credentials.slackWebhook, releases, options);
  }

  throw new Error(`Canal push inconnu : ${channel}`);
}

export async function sendDestinationPush(destination, releases, options = {}) {
  const opts = { ...options, locale: parseLocale(options.locale, 'fr') };
  if (destination.destination_type === 'slack_webhook') {
    return sendSlackWebhook(destination.target, releases, opts);
  }

  throw new Error(`Destination push non gérée : ${destination.destination_type}`);
}
