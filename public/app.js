/**
 * ISO Watcher — Page publique (catalogue + actions optionnelles)
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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  saveJson(SESSION_KEY, session);
  state.session = session;
}

function apiHeaders() {
  const s = state.session;
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };

  if (s?.ui_session) {
    h['X-UI-Session'] = s.ui_session;
  } else if (s?.token) {
    h['X-Intranet-Token'] = s.token;
  }

  if (s?.actor) {
    h['X-Actor-Username'] = s.actor.username || 'operator';
    h['X-Actor-Type'] = s.actor.type || 'internal';
  }

  return h;
}

async function api(method, path, body = null) {
  const opts = { method, headers: apiHeaders() };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Réponse invalide');
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
  if (!v || v < 1) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go'];
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

  panel.hidden = false;
  panel.removeAttribute('hidden');

  const labels = {
    health: 'Santé du service',
    scan: 'Scan complet',
    link_check: 'Vérification des liens'
  };

  $('last-action-summary').textContent = `${labels[action.type] || action.type} — ${action.startedAt || ''}`;
  const badge = $('last-action-badge');

  if (action.pending) {
    badge.textContent = 'En cours…';
    badge.className = 'badge badge-warn';
  } else if (action.ok) {
    badge.textContent = 'Terminé';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = 'Erreur';
    badge.className = 'badge badge-error';
  }

  $('last-action-result').textContent = action.resultText || '—';
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
      toast(action.ok ? 'Scan terminé' : 'Scan terminé avec erreurs', action.ok ? 'success' : 'error');
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
  if (state.session?.ui_session || state.session?.token) return true;

  if (state.config?.public_actions_auto_auth) {
    const res = await fetch('/api/v1/public/ui-session', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data?.error || 'Session opérateur refusée');
    }

    saveSession({ ui_session: data.ui_session, actor: data.actor });
    return true;
  }

  const saved = loadSession();

  if (saved?.ui_session || saved?.token) {
    state.session = saved;
    return true;
  }

  const token = $('token')?.value?.trim();

  if (token) {
    saveSession({ token, actor: { username: 'operator', type: 'internal' } });
    return true;
  }

  toast('Token API requis — ouvrez « Accès opérateur »', 'error');
  $('operator-panel').hidden = false;
  $('operator-panel').open = true;
  return false;
}

function storageStatusLabel(storage) {
  if (!storage?.enabled) {
    return 'Stockage local : désactivé.';
  }

  const parts = [
    `accessible : ${storage.reachable ? 'oui' : 'non'}`,
    `lecture : ${storage.readable ? 'oui' : 'non'}`,
    `écriture : ${storage.writable ? 'oui' : 'non'}`
  ];

  return `Répertoire ISO — ${parts.join(' · ')}.`;
}

function formatHealthSummary(health, ready) {
  const lines = [];
  const serviceOk = Boolean(health?.ok && ready?.ok);
  const readyOk = ready?.ok !== false;

  lines.push(
    serviceOk
      ? `Service opérationnel — base ${health?.db_driver || '—'}, version ${health?.version || '—'}.`
      : 'Le service signale un problème (vérifiez le détail ci-dessous).'
  );

  if (!readyOk) {
    lines.push('Base de données : indisponible ou non prête.');
  }

  lines.push(storageStatusLabel(health?.storage));

  const storage = health?.storage;

  if (storage?.enabled && !storage.ok && storage.error) {
    const hints = {
      storage_unreachable: 'Le répertoire configuré est introuvable ou le montage est indisponible.',
      storage_not_directory: 'La cible configurée n’est pas un dossier.',
      storage_not_readable: 'Le service ne peut pas lire le répertoire.',
      storage_not_writable: 'Le service ne peut pas écrire dans le répertoire (téléchargements impossibles).',
      storage_check_failed: 'La vérification du stockage a échoué.'
    };
    const hint = hints[storage.error];

    if (hint) {
      lines.push(hint);
    }
  }

  return lines.join(' ');
}

function updateHealthUi(health, ready) {
  const serviceOk = Boolean(health?.ok && ready?.ok !== false);
  const label = $('health-pill-label');
  const summary = $('health-summary');
  const headerBtn = $('btn-health-header');

  if (label) {
    if (!health) {
      label.textContent = 'Hors ligne';
    } else if (!serviceOk) {
      label.textContent = 'Erreur';
    } else if (health.storage?.enabled && !health.storage.ok) {
      label.textContent = `Stockage · ${health.db_driver || '—'}`;
    } else {
      label.textContent = `OK · ${health.db_driver || '—'}`;
    }
  }

  if (headerBtn) {
    headerBtn.classList.toggle('ok', serviceOk);
    headerBtn.classList.toggle('err', !serviceOk);
  }

  if (summary && health) {
    summary.textContent = formatHealthSummary(health, ready);
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
    throw new Error('Échec /health');
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
    wrap.innerHTML = '<p class="empty">Aucune release.</p>';
    $('releases-stats').textContent = '0 release';
    $('releases-pagination').innerHTML = '';
    return;
  }

  $('releases-stats').textContent = `${total} release(s)`;
  wrap.innerHTML = `<table class="data-table"><thead><tr>
    <th>ISO</th><th>Version</th><th>Fichier</th><th>Taille</th><th>Détectée</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${escapeHtml(r.iso_name || r.distribution || '—')}</td>
    <td>${escapeHtml(r.version || '—')}</td>
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
      <button type="button" class="btn btn-secondary btn-sm" id="releases-prev" ${page <= 1 ? 'disabled' : ''}>Précédent</button>
      <span class="hint">Page ${page} / ${totalPages}</span>
      <button type="button" class="btn btn-secondary btn-sm" id="releases-next" ${page >= totalPages ? 'disabled' : ''}>Suivant</button>
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

  state.healthBusy = true;
  const startedAt = new Date().toLocaleString('fr-FR');
  const buttons = [$('btn-health'), $('btn-health-header')];

  buttons.forEach((b) => {
    if (b) b.disabled = true;
  });

  setLastAction({
    type: 'health',
    startedAt,
    pending: true,
    ok: false,
    resultText: 'Vérification de /health et /ready…'
  });

  try {
    const data = await loadHealth();
    const ok = Boolean(data.health?.ok && data.readyOk);
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
      ok,
      resultText: text
    });

    toast(ok ? 'Santé vérifiée' : 'Problème détecté', ok ? 'success' : 'error');
  } catch (e) {
    updateHealthUi(null, null);
    $('health-pill-label').textContent = 'Hors ligne';
    $('btn-health-header')?.classList.add('err');

    setLastAction({
      type: 'health',
      startedAt,
      pending: false,
      ok: false,
      resultText: e.message
    });

    toast(e.message, 'error');
  } finally {
    state.healthBusy = false;
    buttons.forEach((b) => {
      if (b) b.disabled = false;
    });
  }
}

async function runScanAction() {
  if (!(await ensureSession())) return;

  const startedAt = new Date().toLocaleString('fr-FR');
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
    toast('Scan lancé en arrière-plan', 'info');
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

  const startedAt = new Date().toLocaleString('fr-FR');
  setLastAction({
    type: 'link_check',
    startedAt,
    pending: true,
    ok: false,
    resultText: 'Vérification en cours…'
  });

  try {
    const data = await api('POST', '/admin/release-link-check', { send_admin_report: false });
    const text = JSON.stringify(data, null, 2);

    setLastAction({
      type: 'link_check',
      startedAt,
      pending: false,
      ok: true,
      resultText: text
    });

    toast(`Vérification OK — ${data.removed ?? 0} supprimée(s)`, 'success');
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
    toast('Token enregistré', 'success');
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
      ? 'Scan et vérification des liens (session automatique).'
      : 'Scan et vérification des liens — token opérateur requis ci-dessous.';

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
        toast(`Actions opérateur : ${e.message}`, 'error');
      }
    }
  } else {
    $('actions-hint').textContent = 'Actions opérateur désactivées (PUBLIC_UI_ALLOW_ACTIONS=false).';
  }

  renderLastAction();
  const last = loadJson(LAST_ACTION_KEY);

  if (last?.pending && last.type === 'scan') {
    startPoll();
  }

  try {
    await loadHealth();
  } catch {
    updateHealthUi(null, null);
    $('health-pill-label').textContent = 'Hors ligne';
  }

  loadReleases().catch((e) => toast(`Releases : ${e.message}`, 'error'));

  setInterval(() => {
    loadHealth().catch(() => {});
  }, 60000);
}

init().catch((e) => {
  toast(e.message || 'Erreur de chargement', 'error');
});
