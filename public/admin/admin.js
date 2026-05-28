/**
 * ISO Watcher - Console d'administration
 */
const SESSION_KEY = 'iw_admin_session';

const PAGE_SIZE = 15;
const PAGE_SIZE_ISO = 10;

const state = {
  session: null,
  uiConfig: null,
  activeTab: 'dashboard',
  isoItems: [],
  expandedIsoId: null,
  editingSourceId: null,
  pagination: { iso: 1, releases: 1, scans: 1, users: 1, events: 1, deliveries: 1, storage: 1 },
  lists: {
    releases: [],
    scans: [],
    users: [],
    events: [],
    deliveries: [],
    storageTracked: []
  },
  presetsList: [],
  presetsSelectedIds: new Set()
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const t = (key, vars) => window.IW_I18N?.t(key, vars) ?? key;
const localeTag = () => (window.IW_I18N?.getLocale() === 'en' ? 'en-GB' : 'fr-FR');

function tabTitles() {
  return {
    dashboard: [t('tab.dashboard'), t('tab.dashboard_sub')],
    iso: [t('tab.iso'), t('tab.iso_sub')],
    releases: [t('tab.releases'), t('tab.releases_sub')],
    scans: [t('tab.scans'), t('tab.scans_sub')],
    storage: [t('tab.storage'), t('tab.storage_sub')],
    notifications: [t('tab.notifications'), t('tab.notifications_sub')],
    reports: [t('tab.reports'), t('tab.reports_sub')],
    users: [t('tab.users'), t('tab.users_sub')],
    system: [t('tab.system'), t('tab.system_sub')]
  };
}

function reportTypeLabel(type) {
  const key = `report.type.${type}`;
  const label = t(key);
  return label === key ? type : label;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FETCH_CREDENTIALS = { credentials: 'include' };

function formatBytes(n) {
  const v = Number(n);
  if (!v || v < 1) return '-';
  const u = [t('bytes.B'), t('bytes.KB'), t('bytes.MB'), t('bytes.GB'), t('bytes.TB')];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function paginateSlice(items, page, pageSize = PAGE_SIZE) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total,
    pageSize
  };
}

function renderPaginationBar(container, meta, onPageChange) {
  if (!container) return;

  if (!meta.total) {
    container.innerHTML = '';
    return;
  }

  const prevDisabled = meta.page <= 1;
  const nextDisabled = meta.page >= meta.totalPages;

  container.innerHTML = `
    <div class="pagination">
      <button type="button" class="btn btn-secondary btn-sm" data-page="prev" ${prevDisabled ? 'disabled' : ''}>${escapeHtml(t('common.prev'))}</button>
      <span class="pagination-info">${escapeHtml(t('common.page', { page: meta.page, totalPages: meta.totalPages, total: meta.total }))}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-page="next" ${nextDisabled ? 'disabled' : ''}>${escapeHtml(t('common.next'))}</button>
    </div>`;

  container.querySelector('[data-page="prev"]')?.addEventListener('click', () => {
    if (!prevDisabled) onPageChange(meta.page - 1);
  });

  container.querySelector('[data-page="next"]')?.addEventListener('click', () => {
    if (!nextDisabled) onPageChange(meta.page + 1);
  });
}

function boolBadge(value, onLabel = t('common.yes'), offLabel = t('common.no')) {
  return value
    ? `<span class="badge badge-ok">${onLabel}</span>`
    : `<span class="badge badge-muted">${offLabel}</span>`;
}

function renderSourceFormHtml(source, { formId, isoId, submitLabel }) {
  const s = source || {};

  return `
    <form id="${formId}" class="form-grid source-edit-form" data-iso-id="${isoId}" ${source?.id ? `data-source-id="${source.id}"` : ''}>
      <label class="field"><span>${escapeHtml(t('source.name'))}</span><input name="name" required value="${escapeHtml(s.name || '')}"></label>
      <label class="field field-span"><span>${escapeHtml(t('source.url'))}</span><input name="url" type="url" required value="${escapeHtml(s.url || '')}"></label>
      <label class="field"><span>${escapeHtml(t('source.protocol'))}</span>
        <select name="protocol">
          ${['https', 'http', 'ftp'].map((p) => `<option value="${p}" ${(s.protocol || 'https') === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>${escapeHtml(t('source.priority'))}</span><input type="number" name="priority" min="1" max="9999" value="${escapeHtml(s.priority ?? 100)}"></label>
      <label class="field field-span"><span>${escapeHtml(t('source.match_regex'))}</span><input name="match_regex" required value="${escapeHtml(s.match_regex || '')}"></label>
      <label class="field field-span"><span>${escapeHtml(t('source.version_regex'))}</span><input name="version_regex" value="${escapeHtml(s.version_regex || '')}"></label>
      <label class="field field-span"><span>${escapeHtml(t('source.checksum_regex'))}</span><input name="checksum_regex" value="${escapeHtml(s.checksum_regex || '')}"></label>
      <label class="field field-check"><input type="checkbox" name="discovery_enabled" value="1" ${s.discovery_enabled ? 'checked' : ''}> ${escapeHtml(t('source.discovery_auto'))}</label>
      <label class="field"><span>${escapeHtml(t('source.discovery_depth'))}</span><input type="number" name="discovery_depth" min="1" max="6" value="${escapeHtml(s.discovery_depth ?? 1)}"></label>
      <label class="field field-span"><span>${escapeHtml(t('source.discovery_regex'))}</span><input name="discovery_regex" value="${escapeHtml(s.discovery_regex || '')}" placeholder="^[^./][^/]+/$"></label>
      <label class="field field-check"><input type="checkbox" name="allow_insecure_tls" value="1" ${s.allow_insecure_tls ? 'checked' : ''}> ${escapeHtml(t('source.tls_insecure'))}</label>
      <label class="field field-check"><input type="checkbox" name="ftp_passive" value="1" ${s.ftp_passive !== false && s.ftp_passive !== 0 ? 'checked' : ''}> ${escapeHtml(t('source.ftp_passive'))}</label>
      <label class="field field-check"><input type="checkbox" name="enabled" value="1" ${s.enabled !== false && s.enabled !== 0 ? 'checked' : ''}> ${escapeHtml(t('source.enabled'))}</label>
      <div class="field-span form-actions">
        <button type="submit" class="btn btn-primary btn-sm">${escapeHtml(submitLabel)}</button>
        ${source?.id ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel-edit="${source.id}">${escapeHtml(t('source.cancel'))}</button>` : ''}
      </div>
    </form>`;
}

function renderSourceReadonlyHtml(s) {
  return `
    <dl class="source-detail-grid">
      <div><dt>${escapeHtml(t('source.id'))}</dt><dd>#${s.id}</dd></div>
      <div><dt>${escapeHtml(t('source.protocol'))}</dt><dd>${escapeHtml(s.protocol || '-')}</dd></div>
      <div><dt>${escapeHtml(t('source.priority'))}</dt><dd>${escapeHtml(s.priority ?? '-')}</dd></div>
      <div><dt>${escapeHtml(t('source.active'))}</dt><dd>${boolBadge(s.enabled, t('common.on'), t('common.off'))}</dd></div>
      <div class="source-detail-wide"><dt>${escapeHtml(t('source.url').replace(' *', ''))}</dt><dd><code class="break-all">${escapeHtml(s.url || '')}</code></dd></div>
      <div class="source-detail-wide"><dt>${escapeHtml(t('source.match_regex').replace(' *', ''))}</dt><dd><code class="break-all">${escapeHtml(s.match_regex || '')}</code></dd></div>
      <div class="source-detail-wide"><dt>${escapeHtml(t('source.version_regex'))}</dt><dd><code class="break-all">${escapeHtml(s.version_regex || '-')}</code></dd></div>
      <div class="source-detail-wide"><dt>${escapeHtml(t('source.checksum_regex'))}</dt><dd><code class="break-all">${escapeHtml(s.checksum_regex || '-')}</code></dd></div>
      <div><dt>${escapeHtml(t('source.discovery'))}</dt><dd>${boolBadge(s.discovery_enabled)}</dd></div>
      <div><dt>${escapeHtml(t('source.depth'))}</dt><dd>${escapeHtml(s.discovery_depth ?? '-')}</dd></div>
      <div class="source-detail-wide"><dt>${escapeHtml(t('source.folder_regex'))}</dt><dd><code class="break-all">${escapeHtml(s.discovery_regex || '-')}</code></dd></div>
      <div><dt>TLS insecure</dt><dd>${boolBadge(s.allow_insecure_tls)}</dd></div>
      <div><dt>${escapeHtml(t('source.ftp_passive'))}</dt><dd>${boolBadge(s.ftp_passive !== false && s.ftp_passive !== 0)}</dd></div>
      <div><dt>${escapeHtml(t('source.last_check'))}</dt><dd>${escapeHtml(s.last_checked_at || '-')}</dd></div>
      <div><dt>${escapeHtml(t('source.last_scan'))}</dt><dd>${escapeHtml(s.last_scan_at || '-')}</dd></div>
      <div><dt>${escapeHtml(t('source.origin'))}</dt><dd>${escapeHtml(s.catalog_source || t('common.manual'))}${s.catalog_preset_id ? ` · ${escapeHtml(s.catalog_preset_id)}` : ''}${s.catalog_source_key ? ` / ${escapeHtml(s.catalog_source_key)}` : ''}</dd></div>
    </dl>`;
}

function parseSourceFormData(form) {
  const fd = new FormData(form);

  return {
    name: fd.get('name'),
    url: fd.get('url'),
    protocol: fd.get('protocol'),
    priority: Number(fd.get('priority') || 100),
    match_regex: fd.get('match_regex'),
    version_regex: fd.get('version_regex') || null,
    checksum_regex: fd.get('checksum_regex') || null,
    discovery_enabled: fd.has('discovery_enabled'),
    discovery_depth: Number(fd.get('discovery_depth') || 1),
    discovery_regex: fd.get('discovery_regex') || null,
    allow_insecure_tls: fd.has('allow_insecure_tls'),
    ftp_passive: fd.has('ftp_passive'),
    enabled: fd.has('enabled')
  };
}

function bindSourceForm(form, isoId, { onSuccess } = {}) {
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = parseSourceFormData(form);
    const sourceId = form.dataset.sourceId;

    try {
      if (sourceId) {
        await api('PATCH', `/sources/${sourceId}`, payload);
        toast(t('toast.source_updated'), 'success');
        state.editingSourceId = null;
      } else {
        await api('POST', `/iso-items/${isoId}/sources`, payload);
        toast(t('toast.source_added'), 'success');
        form.reset();
        form.hidden = true;
      }

      if (onSuccess) await onSuccess();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  form.querySelector('[data-cancel-edit]')?.addEventListener('click', () => {
    state.editingSourceId = null;
    if (onSuccess) onSuccess();
    else loadIsoDetail(isoId);
  });
}

function dlStatusBadge(status) {
  const s = String(status || 'none');
  const map = {
    none: ['badge-muted', 'dl.none'],
    downloading: ['badge-warn', 'dl.downloading'],
    completed: ['badge-ok', 'dl.completed'],
    failed: ['badge-error', 'dl.failed'],
    replaced: ['badge-muted', 'dl.replaced']
  };
  const [cls, key] = map[s] || ['badge-muted', null];
  const label = key ? t(key) : s;
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function scanStatusBadge(status) {
  const map = {
    running: ['badge-warn', 'scan.running'],
    success: ['badge-ok', 'scan.success'],
    error: ['badge-error', 'scan.error'],
    partial_error: ['badge-warn', 'scan.partial_error'],
    interrupted: ['badge-muted', 'scan.interrupted']
  };
  const [cls, key] = map[status] || ['badge-muted', null];
  const label = key ? t(key) : (status || '-');
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function toast(msg, type = 'info') {
  const host = $('#toast-host');
  if (!host || !msg) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  const safe = { actor: session?.actor || { username: 'admin', type: 'admin' } };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(safe));
  state.session = safe;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  state.session = null;
}

function apiHeaders() {
  const s = state.session;
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Actor-Username': s?.actor?.username || 'admin',
    'X-Actor-Type': s?.actor?.type || 'admin'
  };
}

function showAuthLoading() {
  document.body.classList.remove('admin-ready');
  $('#auth-loading').hidden = false;
  $('#login-screen').hidden = true;
  $('#app').hidden = true;
}

function showLoginScreen() {
  document.body.classList.remove('admin-ready');
  $('#auth-loading').hidden = true;
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}

async function api(method, path, body = null) {
  const opts = { method, headers: apiHeaders(), ...FETCH_CREDENTIALS };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}`, opts);
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(t('toast.invalid_json'));
    }
  }
  if (!res.ok) {
    throw new Error(extractApiError(data, res.status));
  }
  return data;
}

function extractApiError(data, status) {
  if (!data || typeof data !== 'object') {
    return `HTTP ${status}`;
  }

  const code = data.error || '';
  const message = data.message || '';

  if (message && ['delivery_failed', 'download_failed', 'api_error', 'storage_disabled'].includes(code)) {
    return message;
  }

  if (code === 'too_many_attempts' || code === 'rate_limit_exceeded') {
    return t('toast.too_many_attempts');
  }

  return code || message || `HTTP ${status}`;
}

async function apiPublic(method, path, body = null) {
  const opts = {
    method: method || 'GET',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...FETCH_CREDENTIALS
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error || '';
    if (code === 'too_many_attempts') {
      throw new Error('too_many_attempts');
    }
    throw new Error(code || data?.message || `HTTP ${res.status}`);
  }
  return data;
}

/* --- Auth --- */
async function initAuth() {
  const cfg = await apiPublic('GET', '/admin/ui-config');
  state.uiConfig = cfg;

  if (!cfg.admin_ui_enabled) {
    $('#login-hint').textContent = t('admin.ui_disabled');
    showLoginScreen();
    return;
  }

  const saved = loadSession();
  if (saved?.actor) {
    state.session = saved;
  }

  showAuthLoading();

  try {
    await api('GET', '/admin/overview');
    showApp();
    return;
  } catch {
    clearSession();
  }

  const pwWrap = $('#login-password-wrap');
  const hint = $('#login-hint');
  const authRequired = cfg.auth_required === true;

  if (!authRequired) {
    showAuthLoading();
    await doLogin('');
    return;
  }

  showLoginScreen();
  pwWrap.hidden = false;
  $('#login-password').required = true;
  hint.textContent = t('admin.password_required');
}

async function doLogin(password) {
  const errEl = $('#login-error');
  errEl.hidden = true;

  try {
    const res = await apiPublic('POST', '/admin/ui-login', { password });
    saveSession({ actor: res.actor });
    showApp();
  } catch (e) {
    showLoginScreen();
    const msg = e.message === 'too_many_attempts'
      ? t('toast.too_many_attempts')
      : (e.message || t('admin.login_denied'));
    errEl.textContent = msg;
    errEl.hidden = false;
  }
}

async function doLogout() {
  try {
    await apiPublic('POST', '/admin/ui-logout', {});
  } catch {
    /* ignore */
  }
  clearSession();
  showLoginScreen();
}

function showApp() {
  document.body.classList.add('admin-ready');
  $('#auth-loading').hidden = true;
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#sidebar-version').textContent = `v${state.uiConfig?.version || '-'}`;
  switchTab('dashboard');
}

/* --- Navigation --- */
function switchTab(tab) {
  state.activeTab = tab;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
  const [title, sub] = tabTitles()[tab] || ['', ''];
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = sub;
  refreshTab(tab);
}

async function refreshTab(tab) {
  try {
    if (tab === 'dashboard') await loadDashboard();
    else if (tab === 'iso') await loadIsoTab();
    else if (tab === 'releases') await loadReleases();
    else if (tab === 'scans') await loadScans();
    else if (tab === 'storage') await loadStorage();
    else if (tab === 'notifications') await loadNotifications();
    else if (tab === 'reports') await loadReportsTab();
    else if (tab === 'users') await loadUsers();
    else if (tab === 'system') await loadSystem();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function refreshAll() {
  await refreshTab(state.activeTab);
  try {
    const h = await fetch('/health').then((r) => r.json());
    const pill = $('#health-pill');
    pill.textContent = h.ok ? `OK · ${h.db_driver}` : t('common.error');
    pill.className = 'pill ' + (h.ok ? 'ok' : 'err');
  } catch {
    $('#health-pill').textContent = t('common.offline');
    $('#health-pill').className = 'pill err';
  }
}

/* --- Dashboard --- */
async function loadDashboard() {
  const data = await api('GET', '/admin/overview');
  const c = data.counts || {};
  $('#dashboard-stats').innerHTML = `
    <div class="stat-card"><span>ISO</span><strong>${c.iso_items ?? 0}</strong></div>
    <div class="stat-card"><span>Releases</span><strong>${c.releases ?? 0}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('dashboard.users'))}</span><strong>${c.users ?? 0}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('dashboard.db'))}</span><strong>${escapeHtml(data.db_driver)}</strong></div>
  `;

  const scans = data.recent_scans || [];
  $('#dashboard-scans').innerHTML = scans.length
    ? `<table class="data-table"><thead><tr><th>${escapeHtml(t('dashboard.col.id'))}</th><th>${escapeHtml(t('dashboard.col.status'))}</th><th>${escapeHtml(t('dashboard.col.new'))}</th><th>${escapeHtml(t('dashboard.col.start'))}</th></tr></thead><tbody>
      ${scans.map((s) => `<tr><td>#${s.id}</td><td>${scanStatusBadge(s.status)}</td><td>${s.new_releases ?? 0}</td><td>${escapeHtml(s.started_at)}</td></tr>`).join('')}
    </tbody></table>`
    : `<p class="empty">${escapeHtml(t('dashboard.no_scans'))}</p>`;

  const st = data.storage || {};
  const counts = st.counts || {};
  $('#dashboard-storage').innerHTML = `
    <p>${st.enabled ? `<span class="badge badge-ok">${escapeHtml(t('badge.active'))}</span>` : `<span class="badge badge-muted">${escapeHtml(t('badge.disabled'))}</span>`}</p>
    <p class="hint" style="margin-top:0.75rem">
      ${escapeHtml(t('dashboard.storage_counts', { downloading: counts.downloading ?? 0, completed: counts.completed ?? 0, failed: counts.failed ?? 0 }))}
    </p>
    <p class="hint">${escapeHtml(t('dashboard.scheduler', { enabled: data.config?.scheduler_enabled ? t('common.yes') : t('common.no'), cron: data.config?.scheduler_cron || '' }))}</p>
  `;
}

/* --- Rapports admin --- */
function collectNotifyChannelsFromForm(form) {
  const channels = [];
  if (form.querySelector('[name="ch_ui"]')?.checked) channels.push('ui');
  if (form.querySelector('[name="ch_email"]')?.checked) channels.push('email');
  if (form.querySelector('[name="ch_discord"]')?.checked) channels.push('discord');
  if (form.querySelector('[name="ch_teams"]')?.checked) channels.push('teams');
  if (form.querySelector('[name="ch_slack"]')?.checked) channels.push('slack');
  if (form.querySelector('[name="ch_webhook"]')?.checked) channels.push('webhook');
  return channels.length ? channels : ['ui'];
}

function applyNotifyConfigToForm(cfg) {
  const form = $('#link-check-form');
  if (!form || !cfg) return;

  const availability = cfg.channels || {};
  const defaults = new Set(cfg.default_channels || ['ui', 'email']);

  const mapping = [
    ['ch_ui', 'ui'],
    ['ch_email', 'email'],
    ['ch_discord', 'discord'],
    ['ch_teams', 'teams'],
    ['ch_slack', 'slack'],
    ['ch_webhook', 'webhook']
  ];

  for (const [name, key] of mapping) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    const available = key === 'ui' ? true : Boolean(availability[key]);
    input.disabled = !available;
    input.checked = available && defaults.has(key);
  }
}

function formatNotifyResults(results) {
  if (!results || typeof results !== 'object') return '-';
  return Object.entries(results)
    .map(([ch, r]) => `${ch}: ${r?.ok ? t('common.ok') : (r?.error || t('report.notify_failed'))}`)
    .join(' · ');
}

async function loadNotifyConfigPanel() {
  const pre = $('#admin-notify-config');
  try {
    const cfg = await api('GET', '/admin/notify-config');
    if (pre) {
      pre.textContent = JSON.stringify(cfg, null, 2);
    }
    applyNotifyConfigToForm(cfg);
    return cfg;
  } catch (e) {
    if (pre) pre.textContent = e.message;
    return null;
  }
}

async function loadReportsList(selectId) {
  const host = $('#reports-list');
  if (!host) return;

  host.innerHTML = `<p class="empty">${escapeHtml(t('common.loading'))}</p>`;

  try {
    const data = await api('GET', '/admin/reports?limit=25');
    const reports = data.reports || [];

    if (!reports.length) {
      host.innerHTML = `<p class="empty">${escapeHtml(t('report.empty'))}</p>`;
      return;
    }

    host.innerHTML = `<table class="data-table">
      <thead><tr><th>${escapeHtml(t('report.col.date'))}</th><th>${escapeHtml(t('report.col.type'))}</th><th>${escapeHtml(t('report.col.summary'))}</th><th>${escapeHtml(t('report.col.channels'))}</th><th></th></tr></thead>
      <tbody>${reports.map((r) => {
        const summary = r.type === 'link_check' && r.stats
          ? t('report.summary.link_check', { checked: r.stats.checked, removed: r.stats.removed })
          : (r.release_count != null ? t('report.summary.releases', { count: r.release_count }) : '-');
        const date = r.created_at
          ? new Date(r.created_at).toLocaleString(localeTag(), { timeZone: 'Europe/Paris' })
          : '-';
        return `<tr>
          <td>${escapeHtml(date)}</td>
          <td>${escapeHtml(reportTypeLabel(r.type))}</td>
          <td>${escapeHtml(summary)}</td>
          <td class="hint">${escapeHtml((r.channels || []).join(', '))}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-report-view="${escapeHtml(r.id)}">${escapeHtml(t('report.view'))}</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;

    host.querySelectorAll('[data-report-view]').forEach((btn) => {
      btn.addEventListener('click', () => showReportPreview(btn.getAttribute('data-report-view')));
    });

    if (selectId) {
      showReportPreview(selectId);
    }
  } catch (e) {
    host.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

async function showReportPreview(reportId) {
  const frame = $('#report-preview-frame');
  const empty = $('#report-preview-empty');
  const meta = $('#report-preview-meta');
  const closeBtn = $('#btn-report-close');

  if (!reportId || !frame) return;

  try {
    const report = await api('GET', `/admin/reports/${encodeURIComponent(reportId)}`);
    meta.innerHTML = `<strong>${escapeHtml(reportTypeLabel(report.type))}</strong>
      · ${escapeHtml(report.created_at || '')}
      · ${escapeHtml(formatNotifyResults(report.notify_results))}`;

    frame.srcdoc = report.html || `<p>${escapeHtml(t('report.no_html'))}</p>`;
    frame.hidden = false;
    frame.removeAttribute('hidden');
    if (empty) {
      empty.hidden = true;
      empty.setAttribute('hidden', '');
    }
    if (closeBtn) {
      closeBtn.hidden = false;
      closeBtn.removeAttribute('hidden');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function closeReportPreview() {
  const frame = $('#report-preview-frame');
  const empty = $('#report-preview-empty');
  const meta = $('#report-preview-meta');
  const closeBtn = $('#btn-report-close');
  if (frame) {
    frame.hidden = true;
    frame.setAttribute('hidden', '');
    frame.srcdoc = '';
  }
  if (empty) {
    empty.hidden = false;
    empty.removeAttribute('hidden');
  }
  if (meta) meta.textContent = '';
  if (closeBtn) {
    closeBtn.hidden = true;
    closeBtn.setAttribute('hidden', '');
  }
}

async function loadReportsTab() {
  await loadNotifyConfigPanel();
  await loadReportsList();
}

async function runLinkCheckFromForm(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const statusEl = $('#link-check-status');
  const channels = collectNotifyChannelsFromForm(form);

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.removeAttribute('hidden');
    statusEl.textContent = t('report.link_check_running');
  }

  try {
    const r = await api('POST', '/admin/release-link-check', {
      report_hours: Number(fd.get('report_hours')) || 24,
      notify_channels: channels,
      send_admin_report: true
    });

    if (r.skipped) {
      toast(t('report.link_check_skipped'), 'warn');
      return;
    }

    const msg = t('report.link_check_done', {
      checked: r.checked ?? 0,
      removed: r.removed ?? 0,
      newInPeriod: r.new_in_period ?? 0
    });
    toast(msg, 'success');

    if (statusEl) {
      statusEl.textContent = `${msg} ${formatNotifyResults(r.notify_results)}`;
    }

    await loadReportsList(r.report_id || null);

    if (r.report_id) {
      await showReportPreview(r.report_id);
    }
  } catch (err) {
    toast(err.message, 'error');
    if (statusEl) statusEl.textContent = err.message;
  }
}

/* --- Presets catalogue --- */
async function loadPresetsMeta() {
  const el = $('#presets-meta');

  try {
    const meta = await api('GET', '/presets/catalog/meta');
    const parts = [
      t('preset.models', { count: meta.preset_count ?? 0 }),
      t('preset.source', { value: meta.source || '-' }),
      meta.updated_at ? t('preset.catalog_at', { date: meta.updated_at }) : null,
      meta.refreshed_at ? t('preset.github_at', { date: meta.refreshed_at }) : t('preset.no_github_sync')
    ].filter(Boolean);

    if (el) el.textContent = parts.join(' · ');
    return meta;
  } catch (e) {
    if (el) el.textContent = t('preset.unavailable', { message: e.message });
    return null;
  }
}

async function loadPresetsList() {
  const listEl = $('#presets-list');
  if (!listEl) return;

  listEl.innerHTML = `<p class="empty">${escapeHtml(t('common.loading'))}</p>`;

  const q = $('#presets-search')?.value?.trim() || '';
  const tag = $('#presets-tag')?.value?.trim() || '';
  const params = new URLSearchParams();

  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);

  try {
    const rows = await api('GET', `/presets?${params}`);
    state.presetsList = Array.isArray(rows) ? rows : [];
    renderPresetsList();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">${escapeHtml(t('preset.error', { message: e.message }))}</p>`;
  }
}

function getVisiblePresetIds() {
  return (state.presetsList || []).map((p) => String(p.id));
}

function getSelectedPresetIds() {
  const visible = new Set(getVisiblePresetIds());
  return [...state.presetsSelectedIds].filter((id) => visible.has(id));
}

function syncPresetSelectionWithList() {
  const visible = new Set(getVisiblePresetIds());

  for (const id of [...state.presetsSelectedIds]) {
    if (!visible.has(id)) {
      state.presetsSelectedIds.delete(id);
    }
  }
}

function updatePresetsBulkUi() {
  const selectedIds = getSelectedPresetIds();
  const visibleIds = getVisiblePresetIds();
  const selectedVisibleCount = selectedIds.length;
  const countEl = $('#presets-selection-count');
  const applyBtn = $('#btn-presets-bulk-apply');
  const selectAll = $('#presets-select-all');

  if (countEl) {
    countEl.textContent = selectedVisibleCount > 1
      ? t('admin.presets_selected_plural', { count: selectedVisibleCount })
      : t('admin.presets_selected', { count: selectedVisibleCount });
  }

  if (applyBtn) {
    applyBtn.disabled = selectedVisibleCount === 0;
  }

  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
    selectAll.disabled = visibleIds.length === 0;
  }
}

function renderPresetsList() {
  const listEl = $('#presets-list');
  const rows = state.presetsList || [];
  syncPresetSelectionWithList();

  if (!rows.length) {
    listEl.innerHTML = `<p class="empty">${escapeHtml(t('preset.none'))}</p>`;
    updatePresetsBulkUi();
    return;
  }

  listEl.innerHTML = rows.map((p) => {
    const presetId = String(p.id);
    const update = Boolean(p.update_available);
    const rowClass = update ? 'preset-row preset-row--update' : 'preset-row';
    const selected = state.presetsSelectedIds.has(presetId);
    const statusBadge = update
      ? `<span class="badge badge-update" title="${escapeHtml(p.drift_summary || '')}">${escapeHtml(t('badge.update_available'))}</span>`
      : (p.import_status === 'up_to_date'
        ? `<span class="badge badge-ok">${escapeHtml(t('badge.up_to_date'))}</span>`
        : (p.imported ? `<span class="badge badge-ok">${escapeHtml(t('badge.imported'))}</span>` : `<span class="badge badge-muted">${escapeHtml(t('badge.not_imported'))}</span>`));

    return `
    <div class="${rowClass}" data-preset-id="${escapeHtml(p.id)}">
      <label class="preset-select" title="${escapeHtml(t('source.select_preset'))}">
        <input type="checkbox" data-preset-select="${escapeHtml(p.id)}" ${selected ? 'checked' : ''}>
      </label>
      <div class="preset-row-main">
        <strong>${escapeHtml(p.label)}</strong>
        <span class="badge badge-muted">${escapeHtml(p.distribution || '')}</span>
        <span class="badge badge-muted">${escapeHtml(p.architecture || '')}</span>
        ${statusBadge}
        <span class="badge badge-muted">${escapeHtml(p.catalog_kind || 'catalogue')}</span>
        <span class="hint">${escapeHtml(t('preset.sources_count', { count: p.source_count ?? 0 }))}${p.linked_iso_item_id ? ` · ISO #${p.linked_iso_item_id}` : ''}</span>
        ${update ? `<span class="hint preset-drift-hint">${escapeHtml(p.drift_summary || '')}</span>` : ''}
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-sm" data-preset-import="${escapeHtml(p.id)}"${p.imported ? ' hidden' : ''}>${escapeHtml(t('preset.import'))}</button>
        <button type="button" class="btn btn-secondary btn-sm${update ? ' btn-warn' : ''}" data-preset-sync="${escapeHtml(p.id)}"${p.imported ? '' : ' hidden'}>${escapeHtml(t('preset.sync'))}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-preset-scan="${escapeHtml(p.id)}">${escapeHtml(t('preset.import_scan'))}</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('[data-preset-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const presetId = String(input.dataset.presetSelect);

      if (input.checked) {
        state.presetsSelectedIds.add(presetId);
      } else {
        state.presetsSelectedIds.delete(presetId);
      }

      updatePresetsBulkUi();
    });
  });

  listEl.querySelectorAll('[data-preset-import]').forEach((btn) => {
    btn.addEventListener('click', () => applyPresetAction(btn.dataset.presetImport, 'import'));
  });

  listEl.querySelectorAll('[data-preset-sync]').forEach((btn) => {
    btn.addEventListener('click', () => applyPresetAction(btn.dataset.presetSync, 'sync'));
  });

  listEl.querySelectorAll('[data-preset-scan]').forEach((btn) => {
    btn.addEventListener('click', () => applyPresetAction(btn.dataset.presetScan, 'import', true));
  });

  updatePresetsBulkUi();
}

async function applyPresetRequest(presetId, mode, runScan = false) {
  return api('POST', `/presets/${presetId}/apply`, {
    mode,
    run_scan: runScan,
    notify: true
  });
}

function formatPresetActionMessage(result, mode, runScan = false) {
  const msg = result.created
    ? t('preset.iso_created', { id: result.iso_item_id })
    : (mode === 'sync'
      ? t('preset.iso_updated', { id: result.iso_item_id })
      : t('preset.iso_exists', { id: result.iso_item_id }));

  return runScan && result.scan ? t('preset.scan_started', { message: msg }) : msg;
}

async function applyPresetAction(presetId, mode, runScan = false) {
  try {
    const result = await applyPresetRequest(presetId, mode, runScan);
    toast(formatPresetActionMessage(result, mode, runScan), 'success');
    await Promise.all([loadIsoTab(), loadPresetsList()]);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function applyPresetsBulkAction() {
  const selectedIds = getSelectedPresetIds();
  const action = $('#presets-bulk-action')?.value || 'import';
  const runScan = action === 'import_scan';
  const mode = action === 'sync' ? 'sync' : 'import';
  const btn = $('#btn-presets-bulk-apply');

  if (!selectedIds.length) {
    toast(t('preset.none_selected'), 'warn');
    return;
  }

  if (btn) btn.disabled = true;

  const previousLabel = btn?.textContent;
  if (btn) btn.textContent = t('preset.processing');

  let ok = 0;
  const errors = [];

  try {
    for (const presetId of selectedIds) {
      try {
        await applyPresetRequest(presetId, mode, runScan);
        ok += 1;
      } catch (e) {
        errors.push(`${presetId}: ${e.message}`);
      }
    }

    state.presetsSelectedIds.clear();
    await loadIsoTab();

    if (errors.length) {
      toast(t('preset.bulk_partial', { ok, total: selectedIds.length, failed: errors.length }), ok ? 'warn' : 'error');
      toast(errors.slice(0, 3).join(' · '), 'error');
    } else {
      toast(t('preset.bulk_done', { count: ok }), 'success');
    }
  } finally {
    if (btn) {
      btn.textContent = previousLabel || t('admin.presets_bulk_apply');
      updatePresetsBulkUi();
    }

    if (!state.presetsSelectedIds.size) {
      updatePresetsBulkUi();
    }
  }
}

async function refreshPresetsCatalog() {
  const btn = $('#btn-presets-refresh');

  if (btn) btn.disabled = true;

  try {
    const result = await api('POST', '/presets/catalog/refresh', {});
    toast(t('preset.github_refreshed', { count: result.preset_count }), 'success');
    await loadPresetsMeta();
    await loadPresetsList();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindPresetsEvents() {
  $('#btn-presets-refresh')?.addEventListener('click', () => refreshPresetsCatalog().catch((e) => toast(e.message, 'error')));
  $('#presets-search')?.addEventListener('input', () => loadPresetsList().catch(() => {}));
  $('#presets-tag')?.addEventListener('change', () => loadPresetsList().catch(() => {}));
  $('#presets-select-all')?.addEventListener('change', (e) => {
    const visibleIds = getVisiblePresetIds();

    if (e.target.checked) {
      visibleIds.forEach((id) => state.presetsSelectedIds.add(id));
    } else {
      visibleIds.forEach((id) => state.presetsSelectedIds.delete(id));
    }

    renderPresetsList();
  });
  $('#btn-presets-bulk-apply')?.addEventListener('click', () => applyPresetsBulkAction().catch((e) => toast(e.message, 'error')));
}

/* --- ISO --- */
async function loadIsoTab() {
  state.isoItems = await api('GET', '/iso-items?include_catalog_drift=true');
  renderIsoList();
  await loadPresetsMeta();
  await loadPresetsList();
}

function renderIsoList() {
  const q = ($('#iso-search')?.value || '').toLowerCase();
  const list = $('#iso-list');
  const filtered = state.isoItems.filter((i) => {
    const hay = `${i.name} ${i.distribution} ${i.architecture}`.toLowerCase();
    return !q || hay.includes(q);
  });

  if (!filtered.length) {
    list.innerHTML = `<p class="empty">${escapeHtml(t('iso.none'))}</p>`;
    renderPaginationBar($('#iso-list-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  const meta = paginateSlice(filtered, state.pagination.iso, PAGE_SIZE_ISO);
  const items = meta.items;

  list.innerHTML = items.map((iso) => {
    const id = iso.id;
    const open = state.expandedIsoId === id;
    const catalogUpdate = Boolean(iso.catalog_update_available);
    const cardClass = catalogUpdate ? 'iso-card iso-card--catalog-drift' : 'iso-card';

    return `
      <div class="${cardClass}" data-iso-id="${id}">
        <div class="iso-card-head" data-action="toggle-iso">
          <div>
            <strong>${escapeHtml(iso.name)}</strong>
            <div class="iso-meta">
              <span class="badge badge-muted">#${id}</span>
              <span class="badge badge-muted">${escapeHtml(iso.distribution || '')}</span>
              <span class="badge badge-muted">${escapeHtml(iso.architecture || '')}</span>
              ${iso.enabled ? '<span class="badge badge-ok">on</span>' : '<span class="badge badge-muted">off</span>'}
              ${iso.is_public ? `<span class="badge badge-ok">${escapeHtml(t('common.public'))}</span>` : ''}
              ${iso.catalog_source ? `<span class="badge badge-muted" title="${escapeHtml(t('iso.origin_title'))}">${escapeHtml(iso.catalog_source)}${iso.catalog_preset_id ? ' · ' + escapeHtml(iso.catalog_preset_id) : ''}</span>` : `<span class="badge badge-muted">${escapeHtml(t('common.manual'))}</span>`}
              ${catalogUpdate ? `<span class="badge badge-update" title="${escapeHtml(iso.catalog_drift_summary || '')}">${escapeHtml(t('badge.catalog_update'))}</span>` : ''}
            </div>
          </div>
          <span>${open ? '▼' : '▶'}</span>
        </div>
        <div class="iso-card-body" ${open ? '' : 'hidden'} data-iso-body="${id}">
          ${open ? `<p class="empty">${escapeHtml(t('common.loading'))}</p>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-action="toggle-iso"]').forEach((head) => {
    head.addEventListener('click', () => {
      const card = head.closest('.iso-card');
      const id = Number(card.dataset.isoId);
      state.expandedIsoId = state.expandedIsoId === id ? null : id;
      renderIsoList();
      if (state.expandedIsoId === id) loadIsoDetail(id);
    });
  });

  renderPaginationBar($('#iso-list-pagination'), meta, (page) => {
    state.pagination.iso = page;
    renderIsoList();
  });

  if (state.expandedIsoId) {
    if (items.some((i) => i.id === state.expandedIsoId)) {
      loadIsoDetail(state.expandedIsoId);
    } else {
      state.expandedIsoId = null;
      state.editingSourceId = null;
    }
  }
}

async function loadIsoDetail(isoId) {
  const body = $(`[data-iso-body="${isoId}"]`);
  if (!body) return;

  const [sources, releases] = await Promise.all([
    api('GET', `/iso-items/${isoId}/sources`),
    api('GET', `/iso-items/${isoId}/releases?limit=20`)
  ]);

  const sourcesHtml = sources.length
    ? sources.map((s) => {
      const editing = state.editingSourceId === s.id;

      return `
        <article class="source-block" data-source-block="${s.id}">
          <div class="source-block-head">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              <span class="badge badge-muted">#${s.id}</span>
              ${s.enabled ? '<span class="badge badge-ok">on</span>' : '<span class="badge badge-muted">off</span>'}
              <span class="badge badge-muted">${escapeHtml(s.protocol || '')}</span>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-secondary btn-sm" data-action="edit-source" data-id="${s.id}">${editing ? escapeHtml(t('source.close')) : escapeHtml(t('source.edit'))}</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="test-source" data-id="${s.id}">${escapeHtml(t('source.test'))}</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="scan-source" data-id="${s.id}">${escapeHtml(t('source.scan'))}</button>
              <button type="button" class="btn btn-danger btn-sm" data-action="delete-source" data-id="${s.id}">${escapeHtml(t('source.delete'))}</button>
            </div>
          </div>
          ${editing
            ? renderSourceFormHtml(s, { formId: `source-edit-${s.id}`, isoId, submitLabel: t('source.save') })
            : renderSourceReadonlyHtml(s)}
        </article>`;
    }).join('')
    : `<p class="empty">${escapeHtml(t('source.none'))}</p>`;

  body.innerHTML = `
    <div class="btn-row iso-detail-actions">
      <button type="button" class="btn btn-primary btn-sm" data-action="scan-iso" data-id="${isoId}">${escapeHtml(t('iso.scan'))}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-create-source">${escapeHtml(t('iso.add_source'))}</button>
      <button type="button" class="btn btn-danger btn-sm" data-action="delete-iso" data-id="${isoId}">${escapeHtml(t('iso.delete'))}</button>
    </div>
    <div id="source-create-wrap-${isoId}" class="source-create-wrap" hidden>
      <h4 class="section-title">${escapeHtml(t('source.new_title'))}</h4>
      ${renderSourceFormHtml(null, { formId: `source-create-${isoId}`, isoId, submitLabel: t('source.add') })}
    </div>
    <h4 class="section-title">${escapeHtml(t('source.configured', { count: sources.length }))}</h4>
    <div class="sources-list">${sourcesHtml}</div>
    <h4 class="section-title">${escapeHtml(t('iso.recent_releases', { count: releases.length }))}</h4>
    ${releases.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>${escapeHtml(t('iso.col.version'))}</th><th>${escapeHtml(t('iso.col.file'))}</th><th>${escapeHtml(t('iso.col.url'))}</th><th>${escapeHtml(t('iso.col.storage'))}</th></tr></thead><tbody>
      ${releases.map((r) => `<tr>
        <td>${escapeHtml(r.version || '-')}</td>
        <td class="break-all">${escapeHtml(r.filename)}</td>
        <td class="break-all"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(t('iso.link'))}</a></td>
        <td>${dlStatusBadge(r.download_status)}</td>
      </tr>`).join('')}
    </tbody></table></div>` : `<p class="empty">${escapeHtml(t('iso.no_releases'))}</p>`}
  `;

  body.querySelector('[data-action="toggle-create-source"]')?.addEventListener('click', () => {
    const wrap = $(`#source-create-wrap-${isoId}`);
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  bindSourceForm($(`#source-create-${isoId}`), isoId, { onSuccess: () => loadIsoDetail(isoId) });

  sources.forEach((s) => {
    if (state.editingSourceId === s.id) {
      bindSourceForm($(`#source-edit-${s.id}`), isoId, { onSuccess: () => loadIsoDetail(isoId) });
    }

    body.querySelector(`[data-action="edit-source"][data-id="${s.id}"]`)?.addEventListener('click', () => {
      state.editingSourceId = state.editingSourceId === s.id ? null : s.id;
      loadIsoDetail(isoId);
    });
  });

  bindIsoDetailActions(body, isoId);
}

function bindIsoDetailActions(body, isoId) {
  body.querySelector('[data-action="scan-iso"]')?.addEventListener('click', async () => {
    try {
      await api('POST', `/iso-items/${isoId}/scan`, { notify: true });
      toast(t('toast.scan_started'), 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  body.querySelector('[data-action="delete-iso"]')?.addEventListener('click', async () => {
    if (!confirm(t('iso.confirm_delete'))) return;
    try {
      await api('DELETE', `/iso-items/${isoId}`);
      toast(t('toast.iso_deleted'), 'success');
      state.expandedIsoId = null;
      loadIsoTab();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  body.querySelectorAll('[data-action="test-source"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api('POST', `/sources/${btn.dataset.id}/test`);
        toast(t('toast.test_ok', { count: r.matches?.length ?? 0 }), 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-action="scan-source"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/sources/${btn.dataset.id}/scan`, { notify: true });
        toast(t('toast.source_scan_started'), 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  body.querySelectorAll('[data-action="delete-source"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('iso.confirm_delete_source'))) return;
      try {
        await api('DELETE', `/sources/${btn.dataset.id}`);
        toast(t('toast.source_deleted'), 'success');
        loadIsoDetail(isoId);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}

function renderReleasesTable() {
  const rows = state.lists.releases;
  const el = $('#releases-table');
  const meta = paginateSlice(rows, state.pagination.releases);

  if (!rows.length) {
    el.innerHTML = `<p class="empty">${escapeHtml(t('releases.none'))}</p>`;
    renderPaginationBar($('#releases-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  el.innerHTML = `<table class="data-table"><thead><tr>
    <th>${escapeHtml(t('releases.col.iso'))}</th><th>${escapeHtml(t('releases.col.version'))}</th><th>${escapeHtml(t('releases.col.file'))}</th><th>${escapeHtml(t('releases.col.size'))}</th><th>${escapeHtml(t('releases.col.storage'))}</th><th>${escapeHtml(t('releases.col.detected'))}</th><th></th>
  </tr></thead><tbody>${meta.items.map((r) => `<tr>
    <td>${escapeHtml(r.iso_name || r.distribution || '-')}</td>
    <td>${escapeHtml(r.version || '-')}</td>
    <td title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</td>
    <td>${formatBytes(r.file_size)}</td>
    <td>${dlStatusBadge(r.download_status)}</td>
    <td>${escapeHtml(r.detected_at || '')}</td>
    <td class="btn-row">
      <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">URL</a>
      ${state.uiConfig?.storage_enabled ? `<button class="btn btn-secondary btn-sm" data-dl-release="${r.id}">${escapeHtml(t('releases.dl_local'))}</button>` : ''}
    </td>
  </tr>`).join('')}</tbody></table>`;

  el.querySelectorAll('[data-dl-release]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const releaseId = btn.dataset.dlRelease;
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = '…';

      try {
        const r = await api('POST', `/releases/${releaseId}/download`);

        if (r.linked || r.skipped_download) {
          toast(t('toast.dl_already_local'), 'success');
        } else if (r.accepted || r.status === 'downloading') {
          toast(r.message || t('toast.dl_started'), 'info');
        } else if (r.ok) {
          toast(t('toast.dl_done'), 'success');
        } else {
          toast(r.message || r.error || t('toast.dl_failed'), 'error');
        }

        loadReleases();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });
  });

  renderPaginationBar($('#releases-pagination'), meta, (page) => {
    state.pagination.releases = page;
    renderReleasesTable();
  });
}

/* --- Releases --- */
async function loadReleases() {
  const latest = $('#releases-latest-only')?.checked;
  let path = '/releases/recent?limit=500';
  if (latest) path += '&latest=true';
  state.lists.releases = await api('GET', path);
  state.pagination.releases = 1;
  renderReleasesTable();
}

/* --- Scans --- */
function renderScansTable() {
  const rows = state.lists.scans;
  const el = $('#scans-table');
  const meta = paginateSlice(rows, state.pagination.scans);

  if (!rows.length) {
    el.innerHTML = `<p class="empty">${escapeHtml(t('scans.none'))}</p>`;
    renderPaginationBar($('#scans-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  el.innerHTML = `<table class="data-table"><thead><tr>
    <th>${escapeHtml(t('scans.col.id'))}</th><th>${escapeHtml(t('scans.col.status'))}</th><th>${escapeHtml(t('scans.col.type'))}</th><th>${escapeHtml(t('scans.col.sources'))}</th><th>${escapeHtml(t('scans.col.new'))}</th><th>${escapeHtml(t('scans.col.start'))}</th><th></th>
  </tr></thead><tbody>${meta.items.map((s) => `<tr>
    <td>#${s.id}</td><td>${scanStatusBadge(s.status)}</td><td>${escapeHtml(s.trigger_type)}</td>
    <td>${s.completed_sources ?? 0}/${s.total_sources ?? s.checked_sources ?? '-'}</td>
    <td>${s.new_releases ?? 0}</td><td>${escapeHtml(s.started_at)}</td>
    <td><button class="btn btn-secondary btn-sm" data-scan-detail="${s.id}">${escapeHtml(t('scans.detail'))}</button></td>
  </tr>`).join('')}</tbody></table>`;

  el.querySelectorAll('[data-scan-detail]').forEach((btn) => {
    btn.addEventListener('click', () => showScanDetail(btn.dataset.scanDetail));
  });

  renderPaginationBar($('#scans-pagination'), meta, (page) => {
    state.pagination.scans = page;
    renderScansTable();
  });
}

async function loadScans() {
  state.lists.scans = await api('GET', '/scans?limit=200');
  state.pagination.scans = 1;
  renderScansTable();
}

async function showScanDetail(id) {
  const card = $('#scan-detail-card');

  try {
    card.hidden = false;
    card.removeAttribute('hidden');
    $('#scan-detail-body').innerHTML = `<p class="empty">${escapeHtml(t('scans.detail_loading'))}</p>`;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const scan = await api('GET', `/scans/${id}?log_limit=5000`);
    const logsRes = await api('GET', `/scans/${id}/logs?limit=5000`);
    const logEntries = Array.isArray(logsRes?.logs) ? logsRes.logs : (Array.isArray(logsRes) ? logsRes : []);

    $('#scan-detail-title').textContent = t('scans.detail_title', { id, status: scan.status });
    const sources = scan.sources || [];

    $('#scan-detail-body').innerHTML = `
      <div class="scan-detail-meta">
        <p>${escapeHtml(t('scans.col.status'))} : ${scanStatusBadge(scan.status)} · ${escapeHtml(t('scans.detail_progress', { percent: scan.progress_percent ?? 0 }))}</p>
        <p>${escapeHtml(t('scans.detail_meta', { newReleases: scan.new_releases ?? 0, completed: scan.completed_sources ?? 0, total: scan.total_sources ?? '-', duration: scan.duration_ms ?? '-' }))}</p>
        <p class="hint">${escapeHtml(t('scans.detail_times', { start: scan.started_at || '-', end: scan.finished_at || '-' }))}</p>
      </div>
      ${sources.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>${escapeHtml(t('scans.col.iso'))}</th><th>${escapeHtml(t('scans.col.source'))}</th><th>${escapeHtml(t('scans.col.url'))}</th><th>${escapeHtml(t('scans.col.status'))}</th><th>${escapeHtml(t('scans.col.match'))}</th><th>${escapeHtml(t('scans.col.new'))}</th><th>${escapeHtml(t('scans.col.error'))}</th></tr></thead><tbody>
        ${sources.map((r) => `<tr>
          <td>${escapeHtml(r.iso_name)}</td>
          <td>${escapeHtml(r.source_name)}</td>
          <td class="break-all"><a href="${escapeHtml(r.source_url)}" target="_blank" rel="noopener">${escapeHtml(t('iso.link'))}</a></td>
          <td>${scanStatusBadge(r.status)}</td>
          <td>${r.matches_found ?? 0}</td>
          <td>${r.new_releases ?? 0}</td>
          <td class="break-all">${escapeHtml(r.error_message || '-')}</td>
        </tr>`).join('')}
      </tbody></table></div>` : `<p class="empty">${escapeHtml(t('scans.no_sources'))}</p>`}
      <h4 class="section-title">${escapeHtml(t('scans.logs', { count: logEntries.length }))}</h4>
      <pre class="code-block code-block-tall">${escapeHtml(logEntries.map((l) => `[${l.level}] ${l.message}`).join('\n') || '-')}</pre>
    `;
  } catch (e) {
    $('#scan-detail-body').innerHTML = `<p class="empty">${escapeHtml(t('preset.error', { message: e.message }))}</p>`;
    toast(e.message, 'error');
  }
}

/* --- Storage --- */
function renderStorageTable() {
  const tracked = state.lists.storageTracked;
  const meta = paginateSlice(tracked, state.pagination.storage);
  const tableHost = $('#storage-tracked-table');

  if (!tracked.length) {
    tableHost.innerHTML = `<p class="empty">${escapeHtml(t('storage.none'))}</p>`;
    renderPaginationBar($('#storage-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  tableHost.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(t('storage.col.iso'))}</th><th>${escapeHtml(t('storage.col.file'))}</th><th>${escapeHtml(t('storage.col.status'))}</th><th>${escapeHtml(t('storage.col.size'))}</th></tr></thead><tbody>
    ${meta.items.map((r) => `<tr><td>${escapeHtml(r.iso_name)}</td><td class="break-all">${escapeHtml(r.filename)}</td><td>${dlStatusBadge(r.download_status)}</td><td>${formatBytes(r.file_size)}</td></tr>`).join('')}
  </tbody></table>`;

  renderPaginationBar($('#storage-pagination'), meta, (page) => {
    state.pagination.storage = page;
    renderStorageTable();
  });
}

async function loadStorage() {
  const st = await api('GET', '/storage/status');
  const counts = st.counts || {};
  state.lists.storageTracked = st.tracked_releases || [];
  state.pagination.storage = 1;

  $('#storage-panel').innerHTML = `
    <div class="btn-row" style="margin-bottom:1rem">
      ${st.enabled ? `<span class="badge badge-ok">${escapeHtml(t('badge.storage_active'))}</span>` : `<span class="badge badge-muted">${escapeHtml(t('badge.storage_disabled'))}</span>`}
      <span class="badge badge-warn">${counts.downloading ?? 0} · ${escapeHtml(t('dl.downloading'))}</span>
      <span class="badge badge-ok">${counts.completed ?? 0} · ${escapeHtml(t('dl.completed'))}</span>
      <span class="badge badge-error">${escapeHtml(t('storage.failed_count', { count: counts.failed ?? 0 }))}</span>
    </div>
    <p class="hint">${escapeHtml(t('storage.queue', { active: st.queue?.active ?? 0, queued: st.queue?.queued ?? 0, max: st.queue?.max_parallel ?? 2 }))}</p>
    <div id="storage-tracked-table" class="table-scroll"></div>
    <div id="storage-pagination" class="pagination-bar"></div>
  `;

  renderStorageTable();
}

/* --- Notifications --- */
function renderEventsTable() {
  const events = state.lists.events;
  const meta = paginateSlice(events, state.pagination.events);
  const host = $('#events-table');

  if (!events.length) {
    host.innerHTML = `<p class="empty">${escapeHtml(t('notifications.no_events'))}</p>`;
    renderPaginationBar($('#events-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  host.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(t('notifications.col.id'))}</th><th>${escapeHtml(t('notifications.col.title'))}</th><th>${escapeHtml(t('notifications.col.type'))}</th><th>${escapeHtml(t('notifications.col.date'))}</th></tr></thead><tbody>
    ${meta.items.map((e) => `<tr><td>#${e.id}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(e.event_type)}</td><td>${escapeHtml(e.created_at)}</td></tr>`).join('')}
  </tbody></table>`;

  renderPaginationBar($('#events-pagination'), meta, (page) => {
    state.pagination.events = page;
    renderEventsTable();
  });
}

function renderDeliveriesTable() {
  const deliveries = state.lists.deliveries;
  const meta = paginateSlice(deliveries, state.pagination.deliveries);
  const host = $('#deliveries-table');

  if (!deliveries.length) {
    host.innerHTML = `<p class="empty">${escapeHtml(t('notifications.no_deliveries'))}</p>`;
    renderPaginationBar($('#deliveries-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  host.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(t('notifications.col.id'))}</th><th>${escapeHtml(t('notifications.col.status'))}</th><th>${escapeHtml(t('notifications.col.attempts'))}</th><th></th></tr></thead><tbody>
    ${meta.items.map((d) => `<tr>
      <td>#${d.id}</td><td>${escapeHtml(d.status)}</td><td>${d.attempt_count ?? 0}</td>
      <td>${d.status === 'failed' ? `<button class="btn btn-secondary btn-sm" data-retry="${d.id}">Retry</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;

  host.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/notifications/deliveries/${btn.dataset.retry}/retry`);
        toast(t('toast.retry_sent'), 'success');
        loadNotifications();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  renderPaginationBar($('#deliveries-pagination'), meta, (page) => {
    state.pagination.deliveries = page;
    renderDeliveriesTable();
  });
}

async function loadNotifications() {
  const status = $('#delivery-status-filter')?.value || '';
  let dPath = '/notifications/deliveries?limit=500';
  if (status) dPath += `&status=${encodeURIComponent(status)}`;

  const [events, deliveries] = await Promise.all([
    api('GET', '/notifications/events?limit=500'),
    api('GET', dPath)
  ]);

  state.lists.events = events;
  state.lists.deliveries = deliveries;
  state.pagination.events = 1;
  state.pagination.deliveries = 1;

  renderEventsTable();
  renderDeliveriesTable();
}

/* --- Users --- */
function renderUsersTable() {
  const users = state.lists.users;
  const meta = paginateSlice(users, state.pagination.users);
  const host = $('#users-table');

  if (!users.length) {
    host.innerHTML = `<p class="empty">${escapeHtml(t('users.none'))}</p>`;
    renderPaginationBar($('#users-pagination'), { page: 1, totalPages: 1, total: 0 }, () => {});
    return;
  }

  host.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(t('users.col.id'))}</th><th>${escapeHtml(t('users.col.type'))}</th><th>${escapeHtml(t('users.col.name'))}</th><th>${escapeHtml(t('users.col.email'))}</th><th></th></tr></thead><tbody>
    ${meta.items.map((u) => `<tr>
      <td>#${u.id}</td><td>${escapeHtml(u.user_type)}</td>
      <td>${escapeHtml(u.display_name || u.username || '-')}</td>
      <td>${escapeHtml(u.email || '-')}</td>
      <td><button class="btn btn-secondary btn-sm" data-user-id="${u.id}">${escapeHtml(t('users.details'))}</button></td>
    </tr>`).join('')}
  </tbody></table>`;

  host.querySelectorAll('[data-user-id]').forEach((btn) => {
    btn.addEventListener('click', () => loadUserDetail(btn.dataset.userId));
  });

  renderPaginationBar($('#users-pagination'), meta, (page) => {
    state.pagination.users = page;
    renderUsersTable();
  });
}

async function loadUsers() {
  state.lists.users = await api('GET', '/admin/users?limit=500');
  state.pagination.users = 1;
  renderUsersTable();
}

async function loadUserDetail(userId) {
  const [user, dests, subs] = await Promise.all([
    api('GET', `/users/${userId}`),
    api('GET', `/users/${userId}/destinations`),
    api('GET', `/users/${userId}/subscriptions`)
  ]);
  $('#user-detail').innerHTML = `
    <h4 style="margin-top:1rem">${escapeHtml(user.display_name || user.username || t('users.profile', { id: userId }))}</h4>
    <p class="hint">${escapeHtml(t('users.profile_meta', { type: user.user_type, email: user.email || '-' }))}</p>
    <h5>${escapeHtml(t('users.destinations', { count: dests.length }))}</h5>
    ${dests.length ? `<ul>${dests.map((d) => `<li>#${d.id} ${escapeHtml(d.destination_type)} - ${escapeHtml(d.label || d.target)}</li>`).join('')}</ul>` : '<p class="empty">-</p>'}
    <h5>${escapeHtml(t('users.subscriptions', { count: subs.length }))}</h5>
    ${subs.length ? `<ul>${subs.map((s) => `<li>ISO #${s.iso_item_id} - ${escapeHtml(s.notify_mode)}</li>`).join('')}</ul>` : '<p class="empty">-</p>'}
  `;
}

/* --- System --- */
async function loadSystem() {
  const [health, ready, overview] = await Promise.all([
    fetch('/health').then((r) => r.json()),
    fetch('/ready').then((r) => r.json()),
    api('GET', '/admin/overview')
  ]);
  $('#system-health').textContent = JSON.stringify(health, null, 2);
  $('#system-ready').textContent = JSON.stringify(ready, null, 2);
  $('#system-config').textContent = JSON.stringify(overview.config || {}, null, 2);
}

/* --- Events --- */
function bindEvents() {
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await doLogin($('#login-password')?.value || '');
  });

  $('#btn-logout')?.addEventListener('click', async () => {
    await doLogout();
  });

  $('#btn-refresh')?.addEventListener('click', () => refreshAll());

  $$('#sidebar-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('[data-toggle="iso-create-form"]')?.addEventListener('click', () => {
    const f = $('#iso-create-form');
    f.hidden = !f.hidden;
  });

  $('#iso-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.enabled = fd.has('enabled');
    payload.is_public = fd.has('is_public');
    try {
      await api('POST', '/iso-items', payload);
      toast(t('toast.iso_created'), 'success');
      e.target.reset();
      e.target.hidden = true;
      loadIsoTab();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#iso-search')?.addEventListener('input', () => {
    state.pagination.iso = 1;
    renderIsoList();
  });

  bindPresetsEvents();
  $('#btn-load-releases')?.addEventListener('click', () => loadReleases());
  $('#releases-latest-only')?.addEventListener('change', () => loadReleases());

  $('#btn-scan-global')?.addEventListener('click', async () => {
    try {
      await api('POST', '/scans/run', { notify: true });
      toast(t('toast.scan_global'), 'success');
      loadScans();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#link-check-form')?.addEventListener('submit', runLinkCheckFromForm);
  $('#btn-reports-refresh')?.addEventListener('click', () => loadReportsList());
  $('#btn-report-close')?.addEventListener('click', closeReportPreview);

  $('#scan-detail-close')?.addEventListener('click', () => {
    const card = $('#scan-detail-card');
    card.hidden = true;
    card.setAttribute('hidden', '');
  });

  $('#btn-refresh-storage')?.addEventListener('click', () => loadStorage());
  $('#delivery-status-filter')?.addEventListener('change', () => loadNotifications());

  $('#user-lookup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = new FormData(e.target).get('user_id');
    loadUserDetail(id);
  });

  $('#notif-test-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/notifications/test', {
        destination_id: Number(fd.get('destination_id')),
        include_fake_release: fd.has('include_fake_release')
      });
      toast(t('toast.notif_test'), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function refreshAdminStaticUi() {
  IW_I18N?.applyDom();
  const tab = state.activeTab;
  const titles = tabTitles();
  if (titles[tab]) {
    $('#page-title').textContent = titles[tab][0];
    $('#page-subtitle').textContent = titles[tab][1];
  }
  $$('#sidebar-nav .nav-item').forEach((btn) => {
    const key = btn.dataset.tab;
    if (titles[key]) btn.textContent = titles[key][0];
  });
  updatePresetsBulkUi();

  if (!state.session) return;

  try {
    if (tab === 'dashboard') await loadDashboard();
    else if (tab === 'iso') {
      renderIsoList();
      if (state.expandedIsoId) await loadIsoDetail(state.expandedIsoId);
      await loadPresetsMeta();
      renderPresetsList();
    } else if (tab === 'releases') renderReleasesTable();
    else if (tab === 'scans') renderScansTable();
    else if (tab === 'storage') await loadStorage();
    else if (tab === 'notifications') {
      renderEventsTable();
      renderDeliveriesTable();
    } else if (tab === 'reports') await loadReportsList();
    else if (tab === 'users') renderUsersTable();
  } catch {
    /* ignore refresh errors on locale switch */
  }
}

bindEvents();
window.addEventListener('iw-locale-change', () => {
  window.IW_I18N?.applyDom?.();
  refreshAdminStaticUi();
});

initAuth().catch((e) => {
  showLoginScreen();
  $('#login-error').textContent = e.message;
  $('#login-error').hidden = false;
});
