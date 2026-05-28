/**
 * ISO Watcher - Page publique (catalogue + actions optionnelles)
 */
const SESSION_KEY = 'iw_public_session';
const LAST_ACTION_KEY = 'iw_last_action';
const POLL_MS = 4000;

const RELEASES_PAGE_SIZE = 20;

const state = {
  config: null,
  session: null,
  pollTimer: null,
  healthBusy: false,
  releases: [],
  releasesPage: 1
};

const $ = (id) => document.getElementById(id);
const t = (key, vars) => window.IW_I18N?.t(key, vars) ?? key;
const localeTag = () => (window.IW_I18N?.getLocale() === 'en' ? 'en-GB' : 'fr-FR');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FETCH_CREDENTIALS = { credentials: 'include' };

function toast(msg, type = 'info') {
  const host = $('toast-host');
  if (!host || !msg) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function loadJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function loadSession() {
  return loadJson(SESSION_KEY);
}

function saveSession(session) {
  const safe = { actor: session?.actor || { username: 'operator', type: 'internal' } };

  if (session?.token) {
    safe.token = session.token;
  }

  saveJson(SESSION_KEY, safe);
  state.session = safe;
}

/** Token API ou session opérateur (auto-auth LAN) - pas le visiteur anonyme. */
function hasOperatorAuth() {
  if (state.session?.token || loadSession()?.token || $('token')?.value?.trim()) {
    return true;
  }

  return Boolean(
    state.config?.public_actions_enabled
    && state.config?.public_actions_auto_auth
    && state.session?.actor
  );
}

function apiHeaders() {
  const s = state.session;
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Actor-Username': s?.actor?.username || 'operator',
    'X-Actor-Type': s?.actor?.type || 'internal'
  };

  if (s?.token) {
    h['X-Intranet-Token'] = s.token;
  }

  return h;
}

async function api(method, path, body = null) {
  const opts = { method, headers: apiHeaders(), ...FETCH_CREDENTIALS };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(t('toast.invalid_response'));
    }
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchPublic(path) {
  const res = await fetch(`/api/v1${path}`, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function formatBytes(n) {
  const v = Number(n);
  if (!v || v < 1) return '-';
  const u = [t('bytes.B'), t('bytes.KB'), t('bytes.MB'), t('bytes.GB')];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function setOperatorActionsEnabled(enabled) {
  $('btn-scan').disabled = !enabled;
  $('btn-link-check').disabled = !enabled;
}

function showLastActionPanel() {
  const panel = $('panel-last-action');
  panel.hidden = false;
  panel.removeAttribute('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setLastAction(action) {
  saveJson(LAST_ACTION_KEY, action);

  if (action?.type === 'health' && !hasOperatorAuth()) {
    renderLastAction();
    return;
  }

  renderLastAction();
  showLastActionPanel();

  if (action?.pending && action.type === 'scan') {
    startPoll();
  }
}

function renderLastAction() {
  const action = loadJson(LAST_ACTION_KEY);
  const panel = $('panel-last-action');

  if (!action) {
    panel.hidden = true;
    return;
  }

  if (action.type === 'health' && !hasOperatorAuth()) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  panel.removeAttribute('hidden');

  const labels = {
    health: t('public.last_action.health'),
    scan: t('public.last_action.scan'),
    link_check: t('public.last_action.link_check')
  };

  $('last-action-summary').textContent = `${labels[action.type] || action.type} - ${action.startedAt || ''}`;
  const badge = $('last-action-badge');

  if (action.pending) {
    badge.textContent = t('public.badge.running');
    badge.className = 'badge badge-warn';
  } else if (action.ok) {
    badge.textContent = t('public.badge.done');
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = t('common.error');
    badge.className = 'badge badge-error';
  }

  $('last-action-result').textContent = action.resultText || '-';
}

function stopPoll() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPoll() {
  stopPoll();
  state.pollTimer = setInterval(() => pollLastAction(), POLL_MS);
  pollLastAction();
}

async function pollLastAction() {
  const action = loadJson(LAST_ACTION_KEY);

  if (!action?.pending || action.type !== 'scan') {
    stopPoll();
    return;
  }

  try {
    const scan = await api('GET', `/scans/${action.scanRunId}`);
    const text = JSON.stringify({
      id: scan.id,
      status: scan.status,
      progress: scan.progress_percent,
      new_releases: scan.new_releases,
      completed_sources: scan.completed_sources,
      total_sources: scan.total_sources
    }, null, 2);
    action.resultText = text;

    if (scan.status !== 'running') {
      action.pending = false;
      action.ok = scan.status === 'success' || scan.status === 'partial_error';
      stopPoll();
      toast(action.ok ? t('public.scan_done') : t('public.scan_done_errors'), action.ok ? 'success' : 'error');
      loadReleases().catch(() => {});
    }

    saveJson(LAST_ACTION_KEY, action);
    renderLastAction();
  } catch (e) {
    action.resultText = e.message;
    action.pending = false;
    action.ok = false;
    saveJson(LAST_ACTION_KEY, action);
    renderLastAction();
    stopPoll();
  }
}

async function ensureSession() {
  if (state.session?.actor || state.session?.token) {
    return true;
  }

  if (state.config?.public_actions_auto_auth) {
    const res = await fetch('/api/v1/public/ui-session', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}'
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.error === 'too_many_attempts'
        ? t('toast.too_many_attempts')
        : (data?.error || t('public.session_denied'));
      throw new Error(msg);
    }

    saveSession({ actor: data.actor });
    return true;
  }

  const saved = loadSession();

  if (saved?.actor) {
    state.session = saved;
    return true;
  }

  const token = $('token')?.value?.trim();

  if (token) {
    state.session = { token, actor: { username: 'operator', type: 'internal' } };
    return true;
  }

  toast(t('public.token_required'), 'error');
  $('operator-panel').hidden = false;
  $('operator-panel').open = true;
  return false;
}

function storageStatusLabel(storage) {
  if (!storage?.enabled) {
    return t('public.storage_disabled');
  }

  return t('public.storage_summary', {
    reachable: storage.reachable ? t('common.yes') : t('common.no'),
    readable: storage.readable ? t('common.yes') : t('common.no'),
    writable: storage.writable ? t('common.yes') : t('common.no')
  });
}

function formatHealthSummary(health, ready) {
  const lines = [];
  const serviceOk = Boolean(health?.ok && ready?.ok);
  const readyOk = ready?.ok !== false;

  lines.push(
    serviceOk
      ? t('public.health_ok_detail', { driver: health?.db_driver || '-', version: health?.version || '-' })
      : t('public.health_ko_detail')
  );

  if (!readyOk) {
    lines.push(t('public.health_db_unready'));
  }

  lines.push(storageStatusLabel(health?.storage));

  const storage = health?.storage;

  if (storage?.enabled && !storage.ok && storage.error) {
    const hints = {
      storage_unreachable: t('public.storage_unreachable'),
      storage_not_directory: t('public.storage_not_directory'),
      storage_not_readable: t('public.storage_not_readable'),
      storage_not_writable: t('public.storage_not_writable'),
      storage_check_failed: t('public.storage_check_failed')
    };
    const hint = hints[storage.error];

    if (hint) {
      lines.push(hint);
    }
  }

  return lines.join(' ');
}

/** Libellé court pour visiteurs sans auth (pas de détail technique). */
function healthStatusFrom(health, ready) {
  if (!health) {
    return { ok: false, label: t('common.offline'), phrase: t('public.health_service_ko') };
  }

  const serviceOk = Boolean(health.ok && ready?.ok !== false);
  const storageOk = !health.storage?.enabled || health.storage?.ok !== false;

  if (!serviceOk) {
    return { ok: false, label: t('common.offline'), phrase: t('public.health_service_ko') };
  }

  if (!storageOk) {
    return { ok: false, label: t('common.error'), phrase: t('public.health_service_ko') };
  }

  return { ok: true, label: t('common.ok'), phrase: t('public.health_service_ok') };
}

function updateHealthUi(health, ready) {
  const status = healthStatusFrom(health, ready);
  const detailed = hasOperatorAuth();
  const label = $('health-pill-label');
  const summary = $('health-summary');
  const headerBtn = $('btn-health-header');

  if (label) {
    if (!detailed || !health) {
      label.textContent = status.label;
    } else if (!status.ok && health.storage?.enabled && !health.storage?.ok) {
      label.textContent = t('public.storage_label', { driver: health.db_driver || '-' });
    } else if (!Boolean(health.ok && ready?.ok !== false)) {
      label.textContent = t('common.error');
    } else {
      label.textContent = `OK · ${health.db_driver || '-'}`;
    }
  }

  if (headerBtn) {
    headerBtn.classList.toggle('ok', status.ok);
    headerBtn.classList.toggle('err', !status.ok);
  }

  if (summary) {
    if (!health) {
      summary.textContent = t('public.health_unreachable');
    } else if (detailed) {
      summary.textContent = formatHealthSummary(health, ready);
    } else {
      summary.textContent = status.phrase;
    }
  }
}

async function loadHealth() {
  const [healthRes, readyRes] = await Promise.all([
    fetch('/health'),
    fetch('/ready')
  ]);

  const health = await healthRes.json().catch(() => ({}));
  const ready = await readyRes.json().catch(() => ({}));

  if (!healthRes.ok) {
    throw new Error(t('public.health_failed'));
  }

  updateHealthUi(health, ready);
  return { health, ready, readyOk: readyRes.ok && ready.ok !== false };
}

function renderReleasesPage() {
  const all = state.releases;
  const wrap = $('releases');
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / RELEASES_PAGE_SIZE) || 1);
  const page = Math.min(Math.max(1, state.releasesPage), totalPages);
  const start = (page - 1) * RELEASES_PAGE_SIZE;
  const rows = all.slice(start, start + RELEASES_PAGE_SIZE);

  if (!total) {
    wrap.innerHTML = `<p class="empty">${escapeHtml(t('public.releases_empty'))}</p>`;
    $('releases-stats').textContent = t('public.releases_count', { count: 0 });
    $('releases-pagination').innerHTML = '';
    return;
  }

  $('releases-stats').textContent = t('public.releases_count', { count: total });
  wrap.innerHTML = `<table class="data-table"><thead><tr>
    <th>${escapeHtml(t('releases.col.iso'))}</th><th>${escapeHtml(t('releases.col.version'))}</th><th>${escapeHtml(t('releases.col.file'))}</th><th>${escapeHtml(t('releases.col.size'))}</th><th>${escapeHtml(t('releases.col.detected'))}</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${escapeHtml(r.iso_name || r.distribution || '-')}</td>
    <td>${escapeHtml(r.version || '-')}</td>
    <td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.filename)}</a></td>
    <td>${formatBytes(r.file_size)}</td>
    <td>${escapeHtml(r.detected_at || '')}</td>
  </tr>`).join('')}</tbody></table>`;

  const pag = $('releases-pagination');

  if (totalPages <= 1) {
    pag.innerHTML = '';
    return;
  }

  pag.innerHTML = `
    <div class="pagination">
      <button type="button" class="btn btn-secondary btn-sm" id="releases-prev" ${page <= 1 ? 'disabled' : ''}>${escapeHtml(t('common.prev'))}</button>
      <span class="hint">${escapeHtml(t('common.page', { page, totalPages, total }))}</span>
      <button type="button" class="btn btn-secondary btn-sm" id="releases-next" ${page >= totalPages ? 'disabled' : ''}>${escapeHtml(t('common.next'))}</button>
    </div>`;

  $('releases-prev')?.addEventListener('click', () => {
    state.releasesPage = page - 1;
    renderReleasesPage();
  });

  $('releases-next')?.addEventListener('click', () => {
    state.releasesPage = page + 1;
    renderReleasesPage();
  });
}

async function loadReleases() {
  const q = new URLSearchParams({ limit: '500', enabled: 'true' });

  if ($('publicOnly')?.checked) q.set('public', 'true');
  if ($('latestOnly')?.checked) q.set('latest', 'true');

  const rows = await fetchPublic(`/releases/recent?${q}`);
  state.releases = Array.isArray(rows) ? rows : [];
  state.releasesPage = 1;
  renderReleasesPage();
}

async function runHealthAction() {
  if (state.healthBusy) return;

  const detailed = hasOperatorAuth();
  state.healthBusy = true;
  const startedAt = new Date().toLocaleString(localeTag());
  const buttons = [$('btn-health'), $('btn-health-header')];

  buttons.forEach((b) => {
    if (b) b.disabled = true;
  });

  if (detailed) {
    setLastAction({
      type: 'health',
      startedAt,
      pending: true,
      ok: false,
      resultText: t('public.health_checking')
    });
  }

  try {
    const data = await loadHealth();
    const status = healthStatusFrom(data.health, data.ready);

    if (detailed) {
      const text = JSON.stringify(
        {
          health: data.health,
          ready: data.ready,
          storage: data.health?.storage
        },
        null,
        2
      );

      setLastAction({
        type: 'health',
        startedAt,
        pending: false,
        ok: status.ok,
        resultText: text
      });
    }

    toast(status.phrase, status.ok ? 'success' : 'error');
  } catch (e) {
    updateHealthUi(null, null);

    if (detailed) {
      setLastAction({
        type: 'health',
        startedAt,
        pending: false,
        ok: false,
        resultText: e.message
      });
    }

    toast(detailed ? e.message : 'Service indisponible.', 'error');
  } finally {
    state.healthBusy = false;
    buttons.forEach((b) => {
      if (b) b.disabled = false;
    });
  }
}

async function runScanAction() {
  if (!(await ensureSession())) return;

  const startedAt = new Date().toLocaleString(localeTag());
  setLastAction({
    type: 'scan',
    startedAt,
    pending: true,
    ok: false,
    resultText: 'Lancement du scan…'
  });

  try {
    const data = await api('POST', '/scans/run', { notify: true });
    const action = {
      type: 'scan',
      startedAt,
      pending: true,
      ok: false,
      scanRunId: data.scan_run_id,
      resultText: JSON.stringify(data, null, 2)
    };
    saveJson(LAST_ACTION_KEY, action);
    renderLastAction();
    showLastActionPanel();
    startPoll();
    toast(t('public.scan_background'), 'info');
  } catch (e) {
    setLastAction({
      type: 'scan',
      startedAt,
      pending: false,
      ok: false,
      resultText: e.message
    });
    toast(e.message, 'error');
  }
}

async function runLinkCheckAction() {
  if (!(await ensureSession())) return;

  const startedAt = new Date().toLocaleString(localeTag());
  setLastAction({
    type: 'link_check',
    startedAt,
    pending: true,
    ok: false,
    resultText: t('public.link_check_running')
  });

  try {
    const data = await api('POST', '/admin/release-link-check', {
      notify_channels: ['ui'],
      send_admin_report: false
    });
    const text = JSON.stringify(data, null, 2);

    setLastAction({
      type: 'link_check',
      startedAt,
      pending: false,
      ok: true,
      resultText: text
    });

    toast(t('public.link_check_ok', { removed: data.removed ?? 0 }), 'success');
    loadReleases().catch(() => {});
  } catch (e) {
    setLastAction({
      type: 'link_check',
      startedAt,
      pending: false,
      ok: false,
      resultText: e.message
    });
    toast(e.message, 'error');
  }
}

function bindEvents() {
  const onHealth = () => runHealthAction().catch((e) => toast(e.message, 'error'));

  $('btn-health')?.addEventListener('click', onHealth);
  $('btn-health-header')?.addEventListener('click', onHealth);
  $('btn-scan')?.addEventListener('click', () => runScanAction().catch((e) => toast(e.message, 'error')));
  $('btn-link-check')?.addEventListener('click', () => runLinkCheckAction().catch((e) => toast(e.message, 'error')));
  $('btn-refresh-releases')?.addEventListener('click', () => loadReleases().catch((e) => toast(e.message, 'error')));
  $('publicOnly')?.addEventListener('change', () => loadReleases().catch((e) => toast(e.message, 'error')));
  $('latestOnly')?.addEventListener('change', () => loadReleases().catch((e) => toast(e.message, 'error')));
  $('btn-save-token')?.addEventListener('click', () => {
    const token = $('token')?.value?.trim();
    if (!token) return toast('Token vide', 'error');
    saveSession({ token, actor: { username: 'operator', type: 'internal' } });
    setOperatorActionsEnabled(true);
    toast(t('public.token_saved'), 'success');
    loadHealth().catch(() => {});
  });
}

async function init() {
  bindEvents();

  try {
    state.config = await fetchPublic('/public/ui-config');
  } catch (e) {
    toast(`Config : ${e.message}`, 'error');
    state.config = {};
  }

  if (state.config.admin_ui_enabled) {
    $('admin-link').hidden = false;
    $('admin-link').removeAttribute('hidden');
  }

  const actionsPanel = $('panel-actions');
  const actionsEnabled = Boolean(state.config.public_actions_enabled);

  if (actionsEnabled) {
    actionsPanel.hidden = false;
    actionsPanel.removeAttribute('hidden');
    setOperatorActionsEnabled(true);

    $('actions-hint').textContent = state.config.public_actions_auto_auth
      ? t('public.actions_auto')
      : t('public.actions_token');

    if (!state.config.public_actions_auto_auth) {
      $('operator-panel').hidden = false;
      $('operator-panel').removeAttribute('hidden');
      const saved = loadSession();

      if (saved?.token && $('token')) {
        $('token').value = saved.token;
      }

      if (saved?.ui_session || saved?.token) {
        state.session = saved;
      } else {
        setOperatorActionsEnabled(false);
      }
    } else {
      try {
        await ensureSession();
      } catch (e) {
        setOperatorActionsEnabled(false);
        toast(t('public.operator_error', { message: e.message }), 'error');
      }
    }
  } else {
    $('actions-hint').textContent = t('public.actions_disabled');
  }

  const last = loadJson(LAST_ACTION_KEY);

  if (last?.type === 'health' && !hasOperatorAuth()) {
    localStorage.removeItem(LAST_ACTION_KEY);
  }

  renderLastAction();

  if (last?.pending && last.type === 'scan') {
    startPoll();
  }

  try {
    await loadHealth();
  } catch {
    updateHealthUi(null, null);
    $('health-pill-label').textContent = t('common.offline');
  }

  loadReleases().catch((e) => toast(`Releases : ${e.message}`, 'error'));

  setInterval(() => {
    loadHealth().catch(() => {});
  }, 60000);
}

window.addEventListener('iw-locale-change', () => {
  window.IW_I18N?.applyDom?.();
  renderLastAction();
  renderReleasesPage();
  loadHealth().catch(() => updateHealthUi(null, null));
  if (state.config) {
    const actionsPanel = $('panel-actions');
    if (actionsPanel && !actionsPanel.hidden) {
      $('actions-hint').textContent = state.config.public_actions_auto_auth
        ? t('public.actions_auto')
        : t('public.actions_token');
    }
  }
});

init().catch((e) => {
  toast(e.message || t('common.error'), 'error');
});
