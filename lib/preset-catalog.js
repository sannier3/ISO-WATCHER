/**
 * Construction d'un catalogue presets depuis la base (export intranet / admin).
 */

export function slugifyPresetId(iso, existingIds = new Set()) {
  const parts = [iso.distribution, iso.edition, iso.version_track, iso.architecture]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));

  let base = parts.filter(Boolean).join('-') || `iso-item-${iso.id || 'new'}`;
  let id = base;
  let n = 2;

  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }

  existingIds.add(id);
  return id;
}

export function sourceKeyFromRow(source, index, usedKeys = new Set()) {
  let key = String(source.catalog_source_key || '').trim();

  if (!key) {
    key = String(source.name || `source-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `source-${index + 1}`;
  }

  let candidate = key;
  let n = 2;

  while (usedKeys.has(candidate)) {
    candidate = `${key}-${n}`;
    n += 1;
  }

  usedKeys.add(candidate);
  return candidate;
}

export function isoItemToPresetShape(iso) {
  return {
    name: iso.name,
    system_family: iso.system_family || 'linux',
    distribution: iso.distribution || null,
    edition: iso.edition || null,
    version_track: iso.version_track || null,
    architecture: iso.architecture || 'amd64',
    file_type: iso.file_type || 'iso',
    description: iso.description || null,
    enabled: iso.enabled !== false && iso.enabled !== 0,
    is_public: iso.is_public !== false && iso.is_public !== 0
  };
}

export function sourceRowToPresetShape(source, key) {
  return {
    key,
    name: source.name,
    protocol: source.protocol || 'https',
    url: source.url,
    allow_insecure_tls: Boolean(source.allow_insecure_tls),
    ftp_passive: source.ftp_passive !== false && source.ftp_passive !== 0,
    match_regex: source.match_regex,
    version_regex: source.version_regex || null,
    checksum_regex: source.checksum_regex || null,
    discovery_enabled: Boolean(source.discovery_enabled),
    discovery_depth: Number(source.discovery_depth || 0),
    discovery_regex: source.discovery_regex || null,
    priority: Number(source.priority ?? 100),
    enabled: source.enabled !== false && source.enabled !== 0
  };
}

export function buildPresetFromDbRow(iso, sources, existingPresetIds = new Set()) {
  const presetId = iso.catalog_preset_id || slugifyPresetId(iso, existingPresetIds);
  const usedKeys = new Set();
  const exportSources = [];

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    const key = sourceKeyFromRow(source, i, usedKeys);
    exportSources.push(sourceRowToPresetShape(source, key));
  }

  if (!exportSources.length) {
    return null;
  }

  const tags = [
    iso.system_family || 'linux',
    iso.distribution,
    iso.edition,
    iso.version_track,
    iso.architecture
  ].filter(Boolean);

  return {
    id: presetId,
    label: iso.name,
    description: iso.description || null,
    tags,
    stability: 'verified',
    iso_item: isoItemToPresetShape(iso),
    sources: exportSources,
    _meta: {
      exported_from_iso_item_id: iso.id,
      exported_at: new Date().toISOString()
    }
  };
}

export function buildCatalogDocument(presets, meta = {}) {
  return {
    schema_version: 1,
    catalog_id: meta.catalog_id || 'iso-watcher-community',
    updated_at: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    generator: meta.generator || 'iso-watcher',
    preset_count: presets.length,
    presets: presets.map((p) => {
      const { _meta, ...rest } = p;
      return rest;
    })
  };
}
