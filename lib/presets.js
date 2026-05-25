/**
 * Catalogue de configurations ISO (presets) - local, cache GitHub, import / sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCatalogDocument,
  buildPresetFromDbRow,
  slugifyPresetId,
  sourceKeyFromRow
} from './preset-catalog.js';

const SCHEMA_VERSION = 1;

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.presets)) {
    throw new Error('invalid_catalog_format');
  }

  if (Number(raw.schema_version) !== SCHEMA_VERSION) {
    throw new Error('unsupported_catalog_schema');
  }

  const seen = new Set();

  for (const preset of raw.presets) {
    if (!preset?.id || seen.has(preset.id)) {
      throw new Error(`invalid_preset_id:${preset?.id || '?'}`);
    }

    seen.add(preset.id);

    if (!preset.iso_item?.name || !Array.isArray(preset.sources) || !preset.sources.length) {
      throw new Error(`invalid_preset:${preset.id}`);
    }

    const sourceKeys = new Set();

    for (const source of preset.sources) {
      if (!source?.key || sourceKeys.has(source.key)) {
        throw new Error(`invalid_source_key:${preset.id}`);
      }

      sourceKeys.add(source.key);

      if (!source.name || !source.url || !source.match_regex) {
        throw new Error(`invalid_source:${preset.id}:${source.key}`);
      }
    }
  }

  return raw;
}

function presetFingerprint(iso) {
  return [
    iso.distribution || '',
    iso.edition || '',
    iso.version_track || '',
    iso.architecture || '',
    iso.file_type || 'iso'
  ].join('|').toLowerCase();
}

export function createPresetsService({ rootDir, config, pool }) {
  const dataDir = path.dirname(path.resolve(config.db.sqlitePath));
  const bundledPath = path.join(rootDir, 'presets', 'catalog.json');
  const cachePath = path.join(dataDir, 'presets-catalog-cache.json');
  const statePath = path.join(dataDir, 'presets-state.json');

  let memoryCatalog = null;

  function loadState() {
    return readJsonFile(statePath, {
      catalog_refreshed_at: null,
      catalog_source: 'bundled',
      catalog_remote_url: null,
      catalog_etag: null,
      bindings: {}
    });
  }

  function saveState(state) {
    writeJsonFile(statePath, state);
  }

  function loadBundledCatalog() {
    const raw = readJsonFile(bundledPath);

    if (!raw) {
      throw new Error('bundled_catalog_missing');
    }

    return normalizeCatalog(raw);
  }

  function loadCachedCatalog() {
    const raw = readJsonFile(cachePath);
    return raw ? normalizeCatalog(raw) : null;
  }

  function resolveActiveCatalog() {
    if (memoryCatalog) {
      return memoryCatalog;
    }

    const state = loadState();
    let catalog = null;
    let source = 'bundled';

    if (config.presets.preferRemote) {
      try {
        catalog = loadCachedCatalog();
        source = catalog ? 'remote_cache' : null;
      } catch {
        catalog = null;
      }
    }

    if (!catalog) {
      try {
        catalog = loadBundledCatalog();
        source = 'bundled';
      } catch {
        catalog = loadCachedCatalog();
        source = catalog ? 'remote_cache' : 'bundled';
      }
    }

    if (!catalog) {
      throw new Error('catalog_unavailable');
    }

    memoryCatalog = { catalog, source, state };
    return memoryCatalog;
  }

  function invalidateMemoryCatalog() {
    memoryCatalog = null;
  }

  function getActiveCatalogKind() {
    const { source } = resolveActiveCatalog();
    return source === 'remote_cache' ? 'github' : 'bundled';
  }

  function getCatalogMeta() {
    const { catalog, source, state } = resolveActiveCatalog();

    return {
      schema_version: catalog.schema_version,
      catalog_id: catalog.catalog_id || 'default',
      updated_at: catalog.updated_at || null,
      preset_count: catalog.presets.length,
      source,
      catalog_kind: source === 'remote_cache' ? 'github' : 'bundled',
      remote_url: config.presets.remoteUrl,
      refreshed_at: state.catalog_refreshed_at,
      bundled_path: bundledPath,
      cache_path: cachePath
    };
  }

  async function listExportableIsoItems({ onlyWithOkSources = true } = {}) {
    const [items] = await pool.query('SELECT * FROM iso_items ORDER BY distribution, name');
    const rows = [];

    for (const iso of items) {
      const [sources] = await pool.query(
        'SELECT * FROM iso_sources WHERE iso_item_id = ? ORDER BY priority ASC, id ASC',
        [iso.id]
      );

      const okSources = sources.filter((s) => s.last_status === 'ok');
      const selectable = onlyWithOkSources ? okSources.length > 0 : sources.length > 0;

      const catalog_drift = await getDriftForIsoItem(iso);

      rows.push({
        iso_item_id: iso.id,
        name: iso.name,
        distribution: iso.distribution,
        edition: iso.edition,
        version_track: iso.version_track,
        architecture: iso.architecture,
        catalog_preset_id: iso.catalog_preset_id || null,
        catalog_source: iso.catalog_source || null,
        catalog_update_available: Boolean(catalog_drift?.update_available),
        catalog_drift_summary: catalog_drift?.summary || null,
        source_count: sources.length,
        ok_source_count: okSources.length,
        selectable,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          last_status: s.last_status,
          url: s.url,
          catalog_source_key: s.catalog_source_key || null,
          catalog_source: s.catalog_source || null
        }))
      });
    }

    return rows;
  }

  async function buildCatalogFromSelection({
    isoItemIds = [],
    onlyOkSources = true,
    catalogId = 'iso-watcher-community'
  } = {}) {
    const ids = [...new Set(isoItemIds.map((id) => Number(id)).filter((id) => id > 0))];

    if (!ids.length) {
      throw new Error('iso_item_ids_required');
    }

    const placeholders = ids.map(() => '?').join(',');
    const [items] = await pool.query(`SELECT * FROM iso_items WHERE id IN (${placeholders})`, ids);

    if (!items.length) {
      throw new Error('iso_items_not_found');
    }

    const presetIds = new Set();
    const presets = [];

    for (const iso of items) {
      const [sources] = await pool.query(
        'SELECT * FROM iso_sources WHERE iso_item_id = ? ORDER BY priority ASC, id ASC',
        [iso.id]
      );

      const filtered = onlyOkSources
        ? sources.filter((s) => s.last_status === 'ok')
        : sources;

      const preset = buildPresetFromDbRow(iso, filtered, presetIds);

      if (preset) {
        presets.push(preset);
      }
    }

    if (!presets.length) {
      throw new Error('no_exportable_presets');
    }

    return buildCatalogDocument(presets, {
      catalog_id: catalogId,
      generator: 'iso-watcher-export'
    });
  }

  const ISO_COMPARE_FIELDS = [
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
  ];

  const SOURCE_COMPARE_FIELDS = [
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
  ];

  function normCompareValue(field, value, defaults = {}) {
    if (field === 'enabled' || field === 'is_public' || field === 'allow_insecure_tls' || field === 'discovery_enabled') {
      return value !== false && value !== 0 && value !== '0';
    }

    if (field === 'ftp_passive') {
      return value !== false && value !== 0 && value !== '0';
    }

    if (field === 'discovery_depth' || field === 'priority') {
      return Number(value ?? defaults[field] ?? 0);
    }

    if (value == null || value === '') {
      return defaults[field] ?? '';
    }

    return String(value).trim();
  }

  function compareIsoItem(presetIso, dbRow) {
    const defaults = { architecture: 'amd64', file_type: 'iso' };
    const changes = [];

    for (const field of ISO_COMPARE_FIELDS) {
      const catalog = normCompareValue(field, presetIso[field], defaults);
      const current = normCompareValue(field, dbRow[field], defaults);

      if (catalog !== current) {
        changes.push({
          field,
          catalog: presetIso[field] ?? null,
          current: dbRow[field] ?? null
        });
      }
    }

    return changes;
  }

  function compareSource(presetSource, dbRow) {
    const payload = sourcePayload(presetSource);
    const changes = [];

    for (const field of SOURCE_COMPARE_FIELDS) {
      const catalog = normCompareValue(field, payload[field], { discovery_depth: 0, priority: 100 });
      const current = normCompareValue(field, dbRow[field], { discovery_depth: 0, priority: 100 });

      if (catalog !== current) {
        changes.push({
          field,
          catalog: payload[field] ?? null,
          current: dbRow[field] ?? null
        });
      }
    }

    return changes;
  }

  function normalizeUrlForMatch(url) {
    return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
  }

  function slugifyLoose(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isSourceLinkedToPreset(dbRow, presetId, sourceKey) {
    if (!dbRow) {
      return false;
    }

    return String(dbRow.catalog_preset_id || '') === String(presetId)
      && String(dbRow.catalog_source_key || '') === String(sourceKey);
  }

  async function findDbSourceForPresetKey(isoItemId, presetId, sourceKey, binding, presetSource = null) {
    const boundId = binding?.sources?.[sourceKey];

    if (boundId) {
      const [rows] = await pool.query(
        'SELECT * FROM iso_sources WHERE id = ? AND iso_item_id = ?',
        [boundId, isoItemId]
      );

      if (rows[0]) {
        return rows[0];
      }
    }

    const [rows] = await pool.query(
      `SELECT * FROM iso_sources
       WHERE iso_item_id = ? AND catalog_preset_id = ? AND catalog_source_key = ?`,
      [isoItemId, presetId, sourceKey]
    );

    if (rows[0]) {
      return rows[0];
    }

    if (!presetSource) {
      return null;
    }

    const [allRows] = await pool.query(
      'SELECT * FROM iso_sources WHERE iso_item_id = ?',
      [isoItemId]
    );

    const targetUrl = normalizeUrlForMatch(presetSource.url);
    const keySlug = slugifyLoose(sourceKey);

    if (targetUrl) {
      const byUrl = allRows.find((row) => normalizeUrlForMatch(row.url) === targetUrl);

      if (byUrl) {
        return byUrl;
      }
    }

    if (keySlug) {
      const byName = allRows.find((row) => slugifyLoose(row.name) === keySlug);

      if (byName) {
        return byName;
      }
    }

    return null;
  }

  async function computePresetDrift(preset, state) {
    const isoRow = await findIsoItemForPreset(preset, state);
    const presetSources = Array.isArray(preset.sources) ? preset.sources : [];

    if (!isoRow) {
      return {
        status: 'not_imported',
        iso_item_id: null,
        update_available: false,
        content_drift: false,
        linking_recommended: false,
        iso_changes: [],
        source_changes: [],
        missing_sources: presetSources.map((s) => s.key),
        unlinked_sources: [],
        summary: 'Non importé dans cette instance'
      };
    }

    const binding = state.bindings?.[preset.id] || {};
    const iso_changes = compareIsoItem(preset.iso_item, isoRow);
    const source_changes = [];
    const missing_sources = [];
    const unlinked_sources = [];

    for (const source of presetSources) {
      const dbSource = await findDbSourceForPresetKey(
        isoRow.id,
        preset.id,
        source.key,
        binding,
        source
      );

      if (!dbSource) {
        missing_sources.push(source.key);
        continue;
      }

      if (!isSourceLinkedToPreset(dbSource, preset.id, source.key)) {
        unlinked_sources.push({
          key: source.key,
          name: source.name,
          source_id: dbSource.id,
          db_name: dbSource.name,
          url: dbSource.url
        });
      }

      const diffs = compareSource(source, dbSource);

      if (diffs.length) {
        source_changes.push({
          key: source.key,
          name: source.name,
          changes: diffs
        });
      }
    }

    const content_drift = iso_changes.length > 0 || source_changes.length > 0 || missing_sources.length > 0;
    const linking_recommended = unlinked_sources.length > 0;
    const update_available = content_drift || linking_recommended;
    const parts = [];

    if (iso_changes.length) {
      parts.push(`${iso_changes.length} champ(s) ISO`);
    }

    if (source_changes.length) {
      parts.push(`${source_changes.length} source(s) différente(s)`);
    }

    if (missing_sources.length) {
      parts.push(`${missing_sources.length} source(s) absente(s)`);
    }

    if (unlinked_sources.length) {
      parts.push(`${unlinked_sources.length} source(s) en base non liée(s) au catalogue`);
    }

    let summary = 'À jour avec le catalogue';

    if (content_drift && linking_recommended) {
      summary = `Mise à jour disponible : ${parts.join(', ')}`;
    } else if (content_drift) {
      summary = `Écarts de contenu : ${parts.filter((p) => !p.includes('non liée')).join(', ')}`;
    } else if (linking_recommended) {
      summary = `Liaison catalogue recommandée : ${parts.filter((p) => p.includes('non liée')).join(', ')}`;
    }

    return {
      status: update_available ? 'update_available' : 'up_to_date',
      iso_item_id: isoRow.id,
      update_available,
      content_drift,
      linking_recommended,
      iso_changes,
      source_changes,
      missing_sources,
      unlinked_sources,
      summary
    };
  }

  async function getPresetDrift(presetId) {
    const preset = getPreset(presetId);

    if (!preset) {
      return null;
    }

    const state = loadState();
    const drift = await computePresetDrift(preset, state);

    return {
      preset_id: presetId,
      label: preset.label || preset.iso_item?.name,
      catalog_kind: getActiveCatalogKind(),
      ...drift
    };
  }

  /** Presets importés dont le catalogue GitHub diffère de la base locale. */
  async function listPresetDriftUpdates() {
    const { catalog, state } = resolveActiveCatalog();
    const presets = [];

    for (const preset of catalog.presets) {
      const drift = await computePresetDrift(preset, state);

      if (!drift.update_available) {
        continue;
      }

      presets.push({
        preset_id: preset.id,
        label: preset.label || preset.iso_item?.name,
        distribution: preset.iso_item?.distribution || null,
        linked_iso_item_id: drift.iso_item_id,
        summary: drift.summary,
        status: drift.status,
        content_drift: drift.content_drift,
        linking_recommended: drift.linking_recommended,
        iso_changes: drift.iso_changes,
        source_changes: drift.source_changes,
        missing_sources: drift.missing_sources,
        unlinked_sources: drift.unlinked_sources
      });
    }

    return {
      catalog_kind: getActiveCatalogKind(),
      catalog_id: catalog.catalog_id || 'iso-watcher-community',
      count: presets.length,
      presets
    };
  }

  function findPresetForIsoRow(isoRow, catalog) {
    if (!isoRow) {
      return null;
    }

    if (isoRow.catalog_preset_id) {
      return catalog.presets.find((p) => p.id === isoRow.catalog_preset_id) || null;
    }

    const dist = String(isoRow.distribution || '').toLowerCase();
    const edition = String(isoRow.edition || '').toLowerCase();
    const track = String(isoRow.version_track || '').toLowerCase();
    const arch = String(isoRow.architecture || 'amd64').toLowerCase();
    const fileType = String(isoRow.file_type || 'iso').toLowerCase();

    const matches = catalog.presets.filter((preset) => {
      const iso = preset.iso_item || {};

      return String(iso.distribution || '').toLowerCase() === dist
        && String(iso.edition || '').toLowerCase() === edition
        && String(iso.version_track || '').toLowerCase() === track
        && String(iso.architecture || 'amd64').toLowerCase() === arch
        && String(iso.file_type || 'iso').toLowerCase() === fileType;
    });

    if (!matches.length) {
      return null;
    }

    if (matches.length === 1) {
      return matches[0];
    }

    const byName = matches.find((p) => p.iso_item?.name === isoRow.name);

    return byName || matches[0];
  }

  async function getDriftForIsoItem(isoRow) {
    if (!isoRow?.id) {
      return null;
    }

    const { catalog } = resolveActiveCatalog();
    const preset = findPresetForIsoRow(isoRow, catalog);

    if (!preset) {
      if (isoRow.catalog_preset_id) {
        return {
          preset_id: isoRow.catalog_preset_id,
          status: 'preset_not_in_catalog',
          iso_item_id: isoRow.id,
          update_available: false,
          content_drift: false,
          linking_recommended: false,
          iso_changes: [],
          source_changes: [],
          missing_sources: [],
          unlinked_sources: [],
          summary: 'Preset absent du catalogue actif'
        };
      }

      return null;
    }

    const state = loadState();
    const drift = await computePresetDrift(preset, state);

    if (drift.iso_item_id && drift.iso_item_id !== isoRow.id) {
      return {
        ...drift,
        status: 'binding_mismatch',
        update_available: false,
        summary: `Lié à une autre ISO (#${drift.iso_item_id}) via le binding preset`
      };
    }

    return {
      preset_id: preset.id,
      ...drift
    };
  }

  function filterPresetsList({ tag, q } = {}) {
    const { catalog } = resolveActiveCatalog();
    const needle = String(q || '').trim().toLowerCase();
    const tagFilter = String(tag || '').trim().toLowerCase();

    return catalog.presets.filter((preset) => {
      if (tagFilter && !(preset.tags || []).map((t) => t.toLowerCase()).includes(tagFilter)) {
        return false;
      }

      if (!needle) {
        return true;
      }

      const hay = [
        preset.id,
        preset.label,
        preset.iso_item?.name,
        preset.iso_item?.distribution,
        preset.iso_item?.edition,
        ...(preset.tags || [])
      ].join(' ').toLowerCase();

      return hay.includes(needle);
    });
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  async function listPresets({ tag, q } = {}) {
    const { state } = resolveActiveCatalog();
    const filtered = filterPresetsList({ tag, q });
    const rows = [];

    for (const preset of filtered) {
      const drift = await computePresetDrift(preset, state);
      const sources = toArray(preset.sources);
      const isoChanges = toArray(drift.iso_changes);
      const sourceChanges = toArray(drift.source_changes);
      const missingSources = toArray(drift.missing_sources);
      const unlinkedSources = toArray(drift.unlinked_sources);

      rows.push({
        id: preset.id,
        label: preset.label || preset.iso_item?.name,
        description: preset.description || preset.iso_item?.description || null,
        tags: preset.tags || [],
        stability: preset.stability || 'verified',
        distribution: preset.iso_item?.distribution,
        edition: preset.iso_item?.edition,
        version_track: preset.iso_item?.version_track,
        architecture: preset.iso_item?.architecture,
        source_count: sources.length,
        imported: drift.status !== 'not_imported',
        import_status: drift.status,
        linked_iso_item_id: drift.iso_item_id,
        update_available: drift.content_drift,
        linking_recommended: drift.linking_recommended,
        drift_summary: drift.summary,
        drift_counts: {
          iso: isoChanges.length,
          sources: sourceChanges.length,
          missing_sources: missingSources.length,
          unlinked_sources: unlinkedSources.length
        },
        catalog_kind: getActiveCatalogKind()
      });
    }

    return rows;
  }

  function getPreset(presetId) {
    const { catalog } = resolveActiveCatalog();
    const preset = catalog.presets.find((p) => p.id === presetId);

    if (!preset) {
      return null;
    }

    const state = loadState();
    const binding = state.bindings?.[presetId] || null;

    return {
      ...preset,
      binding
    };
  }

  async function refreshFromRemote(remoteUrl = config.presets.remoteUrl) {
    const url = String(remoteUrl || '').trim();

    if (!url) {
      throw new Error('presets_remote_url_missing');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeouts.httpMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });

      if (!res.ok) {
        throw new Error(`catalog_fetch_failed:${res.status}`);
      }

      const raw = await res.json();
      const catalog = normalizeCatalog(raw);
      writeJsonFile(cachePath, catalog);

      const state = loadState();
      state.catalog_refreshed_at = new Date().toISOString();
      state.catalog_source = 'remote_cache';
      state.catalog_remote_url = url;
      state.catalog_etag = res.headers.get('etag') || null;
      saveState(state);
      invalidateMemoryCatalog();

      return {
        ok: true,
        preset_count: catalog.presets.length,
        updated_at: catalog.updated_at,
        refreshed_at: state.catalog_refreshed_at,
        url
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function findIsoItemForPreset(preset, state) {
    const binding = state.bindings?.[preset.id];

    if (binding?.iso_item_id) {
      const [rows] = await pool.query('SELECT * FROM iso_items WHERE id = ?', [binding.iso_item_id]);
      if (rows[0]) return rows[0];
    }

    const fp = presetFingerprint(preset.iso_item);
    const [rows] = await pool.query(
      `SELECT * FROM iso_items
       WHERE LOWER(COALESCE(distribution,'')) = ?
         AND LOWER(COALESCE(edition,'')) = ?
         AND LOWER(COALESCE(version_track,'')) = ?
         AND LOWER(COALESCE(architecture,'')) = ?
         AND LOWER(COALESCE(file_type,'iso')) = ?`,
      [
        (preset.iso_item.distribution || '').toLowerCase(),
        (preset.iso_item.edition || '').toLowerCase(),
        (preset.iso_item.version_track || '').toLowerCase(),
        (preset.iso_item.architecture || 'amd64').toLowerCase(),
        (preset.iso_item.file_type || 'iso').toLowerCase()
      ]
    );

    if (rows.length === 1) {
      return rows[0];
    }

    if (rows.length > 1) {
      const byName = rows.find((r) => r.name === preset.iso_item.name);
      return byName || rows[0];
    }

    return null;
  }

  function sourcePayload(source) {
    return {
      name: source.name,
      protocol: source.protocol || 'https',
      url: source.url,
      allow_insecure_tls: Boolean(source.allow_insecure_tls),
      ftp_passive: source.ftp_passive !== false,
      match_regex: source.match_regex,
      version_regex: source.version_regex || null,
      checksum_regex: source.checksum_regex || null,
      discovery_enabled: Boolean(source.discovery_enabled),
      discovery_depth: Number(source.discovery_depth || 0),
      discovery_regex: source.discovery_regex || null,
      priority: Number(source.priority ?? 100),
      enabled: source.enabled !== false
    };
  }

  async function upsertSource(isoItemId, presetId, source, binding, state, catalogSource) {
    const payload = sourcePayload(source);
    const boundId = binding?.sources?.[source.key];
    const originFields = {
      catalog_preset_id: presetId,
      catalog_source_key: source.key,
      catalog_source: catalogSource
    };

    if (boundId) {
      const [existing] = await pool.query('SELECT id FROM iso_sources WHERE id = ? AND iso_item_id = ?', [
        boundId,
        isoItemId
      ]);

      if (existing.length) {
        const fields = { ...payload, ...originFields };
        const sets = Object.keys(fields).map((f) => `${f} = ?`).join(', ');
        await pool.query(`UPDATE iso_sources SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
          ...Object.values(fields),
          boundId
        ]);
        return boundId;
      }
    }

    const [result] = await pool.query(
      `INSERT INTO iso_sources
       (iso_item_id, name, protocol, url, allow_insecure_tls, ftp_passive, match_regex, version_regex, checksum_regex,
        discovery_enabled, discovery_depth, discovery_regex, priority, enabled,
        catalog_preset_id, catalog_source_key, catalog_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        isoItemId,
        payload.name,
        payload.protocol,
        payload.url,
        payload.allow_insecure_tls,
        payload.ftp_passive,
        payload.match_regex,
        payload.version_regex,
        payload.checksum_regex,
        payload.discovery_enabled,
        payload.discovery_depth,
        payload.discovery_regex,
        payload.priority,
        payload.enabled,
        originFields.catalog_preset_id,
        originFields.catalog_source_key,
        originFields.catalog_source
      ]
    );

    const sourceId = result.insertId;
    binding.sources = binding.sources || {};
    binding.sources[source.key] = sourceId;
    state.bindings[presetId] = binding;
    return sourceId;
  }

  async function applyPreset(presetId, options = {}) {
    const preset = getPreset(presetId);

    if (!preset) {
      throw new Error('preset_not_found');
    }

    const mode = String(options.mode || 'import').toLowerCase();
    const catalogSource = String(options.catalog_source || getActiveCatalogKind() || 'github');
    const state = loadState();
    let isoItem = null;
    let created = false;

    if (mode === 'create') {
      isoItem = null;
    } else {
      isoItem = await findIsoItemForPreset(preset, state);
    }

    if (!isoItem) {
      const iso = preset.iso_item;
      const [result] = await pool.query(
        `INSERT INTO iso_items
         (name, system_family, distribution, edition, version_track, architecture, file_type, description, enabled, is_public, created_by_user_id,
          catalog_preset_id, catalog_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          iso.name,
          iso.system_family || null,
          iso.distribution || null,
          iso.edition || null,
          iso.version_track || null,
          iso.architecture || 'amd64',
          iso.file_type || 'iso',
          iso.description || null,
          iso.enabled !== false,
          iso.is_public !== false,
          options.created_by_user_id || null,
          presetId,
          catalogSource
        ]
      );

      isoItem = { id: result.insertId, ...iso };
      created = true;
    } else if (mode === 'sync') {
      const iso = preset.iso_item;
      await pool.query(
        `UPDATE iso_items SET
           name = ?, system_family = ?, distribution = ?, edition = ?, version_track = ?,
           architecture = ?, file_type = ?, description = ?, enabled = ?, is_public = ?,
           catalog_preset_id = ?, catalog_source = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          iso.name,
          iso.system_family || null,
          iso.distribution || null,
          iso.edition || null,
          iso.version_track || null,
          iso.architecture || 'amd64',
          iso.file_type || 'iso',
          iso.description || null,
          iso.enabled !== false,
          iso.is_public !== false,
          presetId,
          catalogSource,
          isoItem.id
        ]
      );
    } else if (isoItem) {
      await pool.query(
        'UPDATE iso_items SET catalog_preset_id = ?, catalog_source = ? WHERE id = ?',
        [presetId, catalogSource, isoItem.id]
      );
    }

    const binding = state.bindings[presetId] || {
      iso_item_id: isoItem.id,
      sources: {},
      imported_at: new Date().toISOString()
    };

    binding.iso_item_id = isoItem.id;
    const sourceIds = [];

    for (const source of preset.sources) {
      const sourceId = await upsertSource(isoItem.id, presetId, source, binding, state, catalogSource);
      sourceIds.push(sourceId);
    }

    state.bindings[presetId] = binding;
    saveState(state);

    return {
      preset_id: presetId,
      mode,
      catalog_source: catalogSource,
      created,
      iso_item_id: isoItem.id,
      source_ids: sourceIds
    };
  }

  return {
    getCatalogMeta,
    getActiveCatalogKind,
    listPresets,
    getPreset,
    getPresetDrift,
    listPresetDriftUpdates,
    getDriftForIsoItem,
    refreshFromRemote,
    applyPreset,
    listExportableIsoItems,
    buildCatalogFromSelection,
    invalidateMemoryCatalog,
    paths: { bundledPath, cachePath, statePath }
  };
}
