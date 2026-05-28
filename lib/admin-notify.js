/**
 * Notifications administrateur : e-mail, messageries, webhooks, stockage UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_NOTIFY_CHANNELS,
  parseAdminChannelList,
  loadAdminNotifyCredentials,
  getAdminChannelAvailability,
  maskWebhookUrl,
  postWebhook,
  sendSlackWebhook,
  truncate,
  formatFileSize,
  buildReleaseNotificationTitle
} from './notify-channels.js';
import { parseLocale, t, formatLocaleDate, formatLocaleDateTime, localeBcp47 } from './locale.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adminReportTableRow(release, locale, { showReason = false, reason = '', httpStatus = null } = {}) {
  const lang = parseLocale(locale);
  const detectedLabel = release.detected_at
    ? formatLocaleDateTime(lang, release.detected_at)
    : '-';
  const reasonCell = showReason
    ? escapeHtml([reason, httpStatus ? `HTTP ${httpStatus}` : ''].filter(Boolean).join(' · '))
    : escapeHtml(detectedLabel);
  const lastCell = showReason
    ? escapeHtml(release.url || '')
    : `<a href="${escapeHtml(release.url || '#')}">${escapeHtml(t(lang, 'notify.download'))}</a>`;

  return `<tr>
    <td>${escapeHtml(release.distribution || '')}</td>
    <td>${escapeHtml(release.iso_name || release.filename || '')}</td>
    <td>${escapeHtml(release.version || '')}</td>
    <td>${escapeHtml(release.filename || '')}</td>
    <td>${escapeHtml(formatFileSize(release.file_size))}</td>
    <td>${reasonCell}</td>
    <td>${lastCell}</td>
  </tr>`;
}

function buildLinkCheckReportHtml({ newReleases, removedReleases, stats, locale }) {
  const lang = parseLocale(locale);
  const periodLabel = t(lang, 'report.link.period', { hours: stats.report_hours });

  const newRows = newReleases.length
    ? newReleases.map((release) => adminReportTableRow(release, lang, { showReason: false })).join('')
    : `<tr><td colspan="7"><em>${escapeHtml(t(lang, 'report.link.none_new', { period: periodLabel }))}</em></td></tr>`;

  const removedRows = removedReleases.length
    ? removedReleases.map((release) => adminReportTableRow(release, lang, {
      showReason: true,
      reason: release.removal_reason || release.reason,
      httpStatus: release.http_status
    })).join('')
    : `<tr><td colspan="7"><em>${escapeHtml(t(lang, 'report.link.none_removed'))}</em></td></tr>`;

  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><title>${escapeHtml(t(lang, 'report.link.page_title'))}</title></head>
<body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.45;">
  <h2>${escapeHtml(t(lang, 'report.link.title'))}</h2>
  <p>${t(lang, 'report.link.summary', { period: escapeHtml(periodLabel) })}</p>
  <ul>
    <li>${escapeHtml(t(lang, 'report.link.checked'))} : <strong>${stats.checked}</strong></li>
    <li>${escapeHtml(t(lang, 'report.link.valid'))} : <strong>${stats.valid}</strong></li>
    <li>${escapeHtml(t(lang, 'report.link.removed'))} : <strong>${stats.removed}</strong></li>
    <li>${escapeHtml(t(lang, 'report.link.new_in_period'))} : <strong>${stats.new_in_period}</strong></li>
  </ul>
  <h3>${escapeHtml(t(lang, 'report.link.section_new'))}</h3>
  <table border="1" cellspacing="0" cellpadding="8" style="border-collapse: collapse; width: 100%; margin-bottom: 24px;">
    <thead>
      <tr>
        <th align="left">${escapeHtml(t(lang, 'notify.col.distribution'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.iso'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.version'))}</th>
        <th align="left">${escapeHtml(t(lang, 'notify.col.file'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.size'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.detected'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.link'))}</th>
      </tr>
    </thead>
    <tbody>${newRows}</tbody>
  </table>
  <h3>${escapeHtml(t(lang, 'report.link.section_removed'))}</h3>
  <table border="1" cellspacing="0" cellpadding="8" style="border-collapse: collapse; width: 100%;">
    <thead>
      <tr>
        <th align="left">${escapeHtml(t(lang, 'notify.col.distribution'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.iso'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.version'))}</th>
        <th align="left">${escapeHtml(t(lang, 'notify.col.file'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.size'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.reason'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.old_link'))}</th>
      </tr>
    </thead>
    <tbody>${removedRows}</tbody>
  </table>
</body>
</html>`;
}

function buildNewReleasesEmailHtml(releases, locale) {
  const lang = parseLocale(locale);
  const rows = releases.map((release) => `<tr>
      <td>${escapeHtml(release.distribution || '')}</td>
      <td>${escapeHtml(release.iso_name || release.filename)}</td>
      <td>${escapeHtml(release.version || '')}</td>
      <td>${escapeHtml(release.architecture || '')}</td>
      <td>${escapeHtml(formatFileSize(release.file_size))}</td>
      <td><a href="${escapeHtml(release.url)}">${escapeHtml(t(lang, 'notify.download'))}</a></td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><title>ISO Watcher</title></head>
<body style="font-family: Arial, sans-serif; color: #111827;">
  <h2>${escapeHtml(t(lang, 'notify.new_admin_title'))}</h2>
  <table border="1" cellspacing="0" cellpadding="8" style="border-collapse: collapse; width: 100%;">
    <thead>
      <tr>
        <th align="left">${escapeHtml(t(lang, 'notify.col.distribution'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.name'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.version'))}</th>
        <th align="left">${escapeHtml(t(lang, 'notify.col.architecture'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.size'))}</th><th align="left">${escapeHtml(t(lang, 'notify.col.link'))}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function buildDiscordEmbedsForReleases(releases, { titlePrefix, locale = 'fr' } = {}) {
  const lang = parseLocale(locale);
  const prefix = titlePrefix || t(lang, 'notify.discord.new_release');

  return releases.map((release) => ({
    title: truncate(`${prefix}: ${release.iso_name || release.filename}`, 256),
    url: release.url || undefined,
    description: truncate(
      [
        release.version ? t(lang, 'notify.discord.version', { version: release.version }) : '',
        t(lang, 'notify.discord.arch', { arch: release.architecture || t(lang, 'notify.discord.arch_unknown') }),
        t(lang, 'notify.discord.size', { size: formatFileSize(release.file_size) }),
        t(lang, 'notify.discord.file', { file: release.filename })
      ].filter(Boolean).join('\n'),
      4096
    ),
    fields: [
      { name: t(lang, 'notify.col.distribution'), value: truncate(release.distribution || '-', 1024), inline: true },
      { name: t(lang, 'notify.col.version'), value: truncate(release.version || '-', 1024), inline: true }
    ],
    timestamp: new Date(release.detected_at || Date.now()).toISOString()
  }));
}

function chunkEmbeds(embeds, maxEmbeds = 10, maxChars = 6000) {
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const embed of embeds) {
    const chars = JSON.stringify(embed).length;

    if (current.length >= maxEmbeds || currentChars + chars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(embed);
    currentChars += chars;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

async function postWebhookLogged(url, payload, log, label) {
  await postWebhook(url, payload, label);
  return { ok: true };
}

export function createAdminNotify({ config, mailer, log, dataDir }) {
  const defaultLocale = parseLocale(config.defaultLanguage, 'fr');
  const statePath = path.join(dataDir, 'admin-reports.json');
  const defaultChannels = parseAdminChannelList(process.env.ADMIN_NOTIFY_CHANNELS, ['email', 'ui']);
  const instantChannels = parseAdminChannelList(
    process.env.ADMIN_INSTANT_NOTIFY_CHANNELS || process.env.ADMIN_NOTIFY_CHANNELS,
    defaultChannels
  );

  const pushCreds = loadAdminNotifyCredentials(config);

  const adminCfg = {
    ...pushCreds,
    instantNotify: config.admin?.instantNotify !== false,
    notifyChannels: config.admin?.notifyChannels?.length
      ? config.admin.notifyChannels
      : defaultChannels,
    instantNotifyChannels: config.admin?.instantNotifyChannels?.length
      ? config.admin.instantNotifyChannels
      : instantChannels,
    smtp: config.smtp,
    limits: config.limits
  };

  function loadState() {
    try {
      if (fs.existsSync(statePath)) {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (Array.isArray(raw?.reports)) {
          return raw;
        }
      }
    } catch (err) {
      log?.warn?.({ err }, 'Lecture admin-reports.json impossible');
    }

    return { reports: [] };
  }

  function saveState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  function persistReport(report) {
    const state = loadState();
    state.reports.unshift(report);
    state.reports = state.reports.slice(0, 50);
    saveState(state);
    return report;
  }

  function getPublicConfig() {
    const channels = getAdminChannelAvailability(adminCfg);

    return {
      channels,
      default_channels: adminCfg.notifyChannels,
      instant_notify: adminCfg.instantNotify,
      instant_channels: adminCfg.instantNotifyChannels,
      admin_email: adminCfg.email || null,
      discord_webhook: maskWebhookUrl(adminCfg.discordWebhook),
      teams_webhook: maskWebhookUrl(adminCfg.teamsWebhook),
      generic_webhook: maskWebhookUrl(adminCfg.genericWebhook),
      slack_webhook: maskWebhookUrl(adminCfg.slackWebhook)
    };
  }

  /**
   * @param {object} options
   * @param {string[]|undefined} options.notifyChannels
   * @param {boolean|undefined} options.sendAdminReport legacy
   * @param {'link_check'|'instant'} options.kind
   */
  function resolveChannels({ notifyChannels, sendAdminReport, kind = 'link_check' } = {}) {
    if (Array.isArray(notifyChannels) && notifyChannels.length) {
      return notifyChannels
        .map((c) => String(c).trim().toLowerCase())
        .filter((c) => ADMIN_NOTIFY_CHANNELS.has(c));
    }

    if (sendAdminReport === false) {
      return ['ui'];
    }

    return kind === 'instant' ? [...adminCfg.instantNotifyChannels] : [...adminCfg.notifyChannels];
  }

  async function sendEmail(to, subject, html) {
    if (!to) {
      throw new Error('ADMIN_EMAIL non configuré');
    }

    await mailer.sendMail({
      from: `"${adminCfg.smtp.fromName}" <${adminCfg.smtp.fromAddress}>`,
      to,
      subject,
      html
    });
  }

  async function sendDiscordEmbeds(embeds) {
    if (!adminCfg.discordWebhook) {
      throw new Error('ADMIN_DISCORD_WEBHOOK_URL non configuré');
    }

    const chunks = chunkEmbeds(
      embeds,
      adminCfg.limits?.discordMaxEmbedsPerMessage || 10,
      adminCfg.limits?.discordMaxEmbedTotalChars || adminCfg.limits?.discordMaxEmbedChars || 6000
    );

    for (const chunk of chunks) {
      await postWebhookLogged(adminCfg.discordWebhook, { embeds: chunk }, log, 'Discord');
    }
  }

  async function sendTeamsAdaptiveCard(title, text, facts = []) {
    if (!adminCfg.teamsWebhook) {
      throw new Error('ADMIN_TEAMS_WEBHOOK_URL non configuré');
    }

    const payload = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium' },
            { type: 'TextBlock', text, wrap: true },
            ...(facts.length ? [{
              type: 'FactSet',
              facts: facts.map((f) => ({ title: f.name, value: f.value }))
            }] : [])
          ]
        }
      }]
    };

    await postWebhookLogged(adminCfg.teamsWebhook, payload, log, 'Teams');
  }

  async function sendGenericWebhook(event, data) {
    if (!adminCfg.genericWebhook) {
      throw new Error('ADMIN_WEBHOOK_URL non configuré');
    }

    await postWebhookLogged(adminCfg.genericWebhook, { event, ...data }, log, 'Webhook');
  }

  function buildPushHandlers(releases, options, extra = {}) {
    const textOpts = { ...options, ...extra };

    return {
      slack: () => sendSlackWebhook(adminCfg.slackWebhook, releases, textOpts)
    };
  }

  async function dispatchChannels(channels, handlers) {
    const results = {};

    for (const channel of channels) {
      if (channel === 'ui') {
        results.ui = { ok: true, skipped: false };
        continue;
      }

      const handler = handlers[channel];

      if (!handler) {
        results[channel] = { ok: false, error: 'canal_non_pris_en_charge' };
        continue;
      }

      try {
        await handler();
        results[channel] = { ok: true };
      } catch (err) {
        const msg = String(err?.message || err);
        log?.warn?.({ channel, err: msg }, 'Échec notification admin');
        results[channel] = { ok: false, error: msg };
      }
    }

    return results;
  }

  function serializeRelease(row) {
    return {
      id: row.id,
      iso_item_id: row.iso_item_id,
      iso_name: row.iso_name,
      distribution: row.distribution,
      architecture: row.architecture,
      edition: row.edition,
      version: row.version,
      filename: row.filename,
      file_size: row.file_size,
      url: row.url,
      detected_at: row.detected_at
    };
  }

  async function notifyLinkCheckReport({ newReleases, removedReleases, stats, channels }) {
    const html = buildLinkCheckReportHtml({ newReleases, removedReleases, stats, locale: defaultLocale });
    const reportId = `link_check_${Date.now()}`;
    const dateLabel = formatLocaleDate(defaultLocale, new Date(), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const subject = t(defaultLocale, 'report.link.subject', { date: dateLabel });

    const summaryEmbed = {
      title: t(defaultLocale, 'report.link.embed_title'),
      description: truncate(
        t(defaultLocale, 'report.link.embed_desc', {
          hours: stats.report_hours,
          checked: stats.checked,
          removed: stats.removed,
          new: stats.new_in_period
        }),
        4096
      ),
      color: stats.removed > 0 ? 0xef4444 : 0x22c55e,
      timestamp: new Date().toISOString()
    };

    const activeChannels = channels.includes('ui') ? channels : [...channels, 'ui'];

    const summaryReleases = [{
      iso_name: t(defaultLocale, 'report.link.summary_name'),
      distribution: 'admin',
      version: `${stats.checked} / ${stats.removed}`,
      architecture: String(stats.new_in_period),
      filename: '-',
      file_size: 0,
      url: '',
      detected_at: new Date().toISOString()
    }];

    const notifyResults = await dispatchChannels(activeChannels, {
      email: () => sendEmail(adminCfg.email, subject, html),
      discord: async () => {
        const embeds = [summaryEmbed, ...buildDiscordEmbedsForReleases(newReleases.slice(0, 8), {
          titlePrefix: t(defaultLocale, 'notify.discord.new_release'),
          locale: defaultLocale
        })];
        await sendDiscordEmbeds(embeds.slice(0, 10));
      },
      teams: () => sendTeamsAdaptiveCard(
        t(defaultLocale, 'report.link.teams_title'),
        t(defaultLocale, 'report.link.teams_body', {
          checked: stats.checked,
          removed: stats.removed,
          new: stats.new_in_period
        }),
        [
          { name: t(defaultLocale, 'report.link.teams_period'), value: String(stats.report_hours) },
          { name: t(defaultLocale, 'report.link.teams_removed'), value: String(stats.removed) }
        ]
      ),
      webhook: () => sendGenericWebhook('admin_link_check_report', {
        report_id: reportId,
        stats,
        new_releases: newReleases.map(serializeRelease),
        removed_releases: removedReleases
      }),
      ...buildPushHandlers(summaryReleases, { notifyMode: 'immediate', locale: defaultLocale })
    });

    const report = persistReport({
      id: reportId,
      type: 'link_check',
      created_at: new Date().toISOString(),
      stats,
      new_releases: newReleases.map(serializeRelease),
      removed_releases: removedReleases,
      html,
      channels: activeChannels,
      notify_results: notifyResults
    });

    return { reportId: report.id, results: notifyResults, report };
  }

  async function notifyNewReleases({ releases, scanRunId = null, channels }) {
    if (!releases?.length) {
      return { reportId: null, results: {}, report: null };
    }

    if (!adminCfg.instantNotify && !channels?.length) {
      return { reportId: null, results: {}, report: null };
    }

    const html = buildNewReleasesEmailHtml(releases, defaultLocale);
    const reportId = `new_releases_${Date.now()}`;
    const subject = releases.length === 1
      ? t(defaultLocale, 'report.admin_new_one', { name: releases[0].iso_name || releases[0].filename })
      : t(defaultLocale, 'report.admin_new_many', { count: releases.length });

    const activeChannels = (channels && channels.length ? channels : adminCfg.instantNotifyChannels);
    const withUi = activeChannels.includes('ui') ? activeChannels : [...activeChannels, 'ui'];

    const notifyResults = await dispatchChannels(withUi, {
      email: () => sendEmail(adminCfg.email, subject, html),
      discord: () => sendDiscordEmbeds(buildDiscordEmbedsForReleases(releases, { locale: defaultLocale })),
      teams: () => sendTeamsAdaptiveCard(
        buildReleaseNotificationTitle(releases, { locale: defaultLocale }),
        t(defaultLocale, 'report.teams_new_body', { count: releases.length }),
        releases.slice(0, 6).map((r) => ({
          name: r.iso_name || r.filename,
          value: r.version || '-'
        }))
      ),
      webhook: () => sendGenericWebhook('admin_new_releases', {
        report_id: reportId,
        scan_run_id: scanRunId,
        releases: releases.map(serializeRelease)
      }),
      ...buildPushHandlers(releases, { notifyMode: 'immediate', locale: defaultLocale })
    });

    const report = persistReport({
      id: reportId,
      type: 'new_releases',
      created_at: new Date().toISOString(),
      scan_run_id: scanRunId,
      releases: releases.map(serializeRelease),
      html,
      channels: withUi,
      notify_results: notifyResults
    });

    log?.info?.({
      report_id: reportId,
      release_count: releases.length,
      scan_run_id: scanRunId,
      channels: withUi
    }, 'Notification admin nouvelles releases');

    return { reportId: report.id, results: notifyResults, report };
  }

  function listReports({ limit = 20, type } = {}) {
    const state = loadState();
    let reports = state.reports;

    if (type) {
      reports = reports.filter((r) => r.type === type);
    }

    return reports.slice(0, clampLimit(limit)).map((r) => ({
      id: r.id,
      type: r.type,
      created_at: r.created_at,
      stats: r.stats || null,
      release_count: r.releases?.length ?? r.new_releases?.length ?? null,
      channels: r.channels || [],
      notify_results: r.notify_results || {}
    }));
  }

  function getReport(reportId) {
    const state = loadState();
    return state.reports.find((r) => r.id === reportId) || null;
  }

  function getLatestReport(type) {
    const list = listReports({ limit: 1, type });
    if (!list.length) {
      return null;
    }

    return getReport(list[0].id);
  }

  return {
    getPublicConfig,
    resolveChannels,
    notifyLinkCheckReport,
    notifyNewReleases,
    listReports,
    getReport,
    getLatestReport,
    buildLinkCheckReportHtml
  };
}

function clampLimit(n) {
  const v = Number(n) || 20;
  return Math.min(50, Math.max(1, v));
}
