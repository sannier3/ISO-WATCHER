import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import * as ftp from 'basic-ftp';

/**
 * Stockage local des ISO — uniquement les releases connues en base (local_path géré par l'app).
 */
export function createFileStorage(config, pool, logger = console) {
  const root = path.resolve(config.storage.root);
  const maxParallel = config.storage.maxParallelDownloads || 2;
  let activeDownloads = 0;
  const downloadQueue = [];

  function runQueued(task) {
    return new Promise((resolve, reject) => {
      downloadQueue.push({ task, resolve, reject });
      drainDownloadQueue();
    });
  }

  function drainDownloadQueue() {
    while (activeDownloads < maxParallel && downloadQueue.length) {
      const job = downloadQueue.shift();
      activeDownloads += 1;

      Promise.resolve()
        .then(() => job.task())
        .then(job.resolve, job.reject)
        .finally(() => {
          activeDownloads -= 1;
          drainDownloadQueue();
        });
    }
  }

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true });
  }

  function releaseIsoItem(release) {
    return {
      name: release.iso_name || release.name,
      distribution: release.distribution
    };
  }

  function buildLocalPath(release, isoItem) {
    const safeFile = sanitizePathSegment(release.filename || `release-${release.id}.iso`);

    if (!config.storage.useSubfolders) {
      return path.join(root, safeFile);
    }

    const safeDist = sanitizePathSegment(isoItem?.distribution || 'unknown');
    const safeIso = sanitizePathSegment(isoItem?.name || `iso-${release.iso_item_id}`);
    return path.join(root, safeDist, safeIso, safeFile);
  }

  function getCandidatePaths(release, isoItem) {
    const paths = [];
    const primary = buildLocalPath(release, isoItem);
    paths.push(primary);

    const flatName = sanitizePathSegment(release.filename || `release-${release.id}.iso`);
    const flatPath = path.join(root, flatName);

    if (flatPath !== primary) {
      paths.push(flatPath);
    }

    return paths;
  }

  async function tryLinkExistingFile(releaseId, release) {
    const candidates = getCandidatePaths(release, releaseIsoItem(release));

    for (const filePath of candidates) {
      const resolved = path.resolve(filePath);
      const rootResolved = path.resolve(root);

      if (!resolved.startsWith(rootResolved)) {
        continue;
      }

      try {
        const stat = await fs.promises.stat(resolved);

        if (!stat.isFile()) {
          continue;
        }

        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        await pool.query(
          `UPDATE iso_releases
           SET local_path = ?, download_status = 'completed', local_downloaded_at = ?, file_size = ?
           WHERE id = ?`,
          [resolved, now, stat.size, releaseId]
        );

        logger.info({ release_id: releaseId, local_path: resolved }, 'Fichier local existant référencé (sans téléchargement)');

        return {
          ok: true,
          linked: true,
          skipped_download: true,
          local_path: resolved,
          file_size: stat.size
        };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn({ filePath: resolved, err: error.message }, 'Lecture fichier candidat échouée');
        }
      }
    }

    return null;
  }

  async function getReleaseContext(releaseId) {
    return pool.query(
      `SELECT r.*, i.name AS iso_name, i.distribution, s.allow_insecure_tls, s.ftp_passive, s.protocol
       FROM iso_releases r
       JOIN iso_items i ON i.id = r.iso_item_id
       LEFT JOIN iso_sources s ON s.id = r.source_id
       WHERE r.id = ?`,
      [releaseId]
    ).then(([rows]) => rows[0] || null);
  }

  async function deleteLocalFileSafe(filePath) {
    if (!filePath) {
      return;
    }

    const resolved = path.resolve(filePath);
    const rootResolved = path.resolve(root);

    if (!resolved.startsWith(rootResolved)) {
      logger.warn({ filePath }, 'Chemin local hors STORAGE_ROOT — suppression ignorée');
      return;
    }

    try {
      await fs.promises.unlink(resolved);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn({ filePath, err: error.message }, 'Suppression fichier locale échouée');
      }
    }
  }

  async function cleanupReplacedFiles(isoItemId, keepReleaseId) {
    if (!config.storage.replaceOldFiles) {
      return;
    }

    const [rows] = await pool.query(
      `SELECT id, local_path FROM iso_releases
       WHERE iso_item_id = ? AND id != ? AND local_path IS NOT NULL`,
      [isoItemId, keepReleaseId]
    );

    for (const row of rows) {
      await deleteLocalFileSafe(row.local_path);
      await pool.query(
        `UPDATE iso_releases SET local_path = NULL, download_status = 'replaced' WHERE id = ?`,
        [row.id]
      );
    }
  }

  async function downloadHttpToFile(url, destPath, allowInsecureTls, timeoutMs) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const options = {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'iso-watcher/0.2' }
      };

      if (parsed.protocol === 'https:') {
        options.agent = new https.Agent({ rejectUnauthorized: !allowInsecureTls });
      }

      const req = transport.request(parsed, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          downloadHttpToFile(new URL(res.headers.location, url).toString(), destPath, allowInsecureTls, timeoutMs)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        pipeline(res, fileStream).then(resolve).catch(reject);
      });

      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function downloadFtpToFile(url, destPath, timeoutMs, { passive = true } = {}) {
    const client = new ftp.Client(timeoutMs);
    client.ftp.verbose = false;
    client.ftp.passive = passive;

    try {
      const parsed = new URL(url);
      await client.access({
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 21,
        user: decodeURIComponent(parsed.username || 'anonymous'),
        password: decodeURIComponent(parsed.password || 'anonymous@'),
        secure: false
      });
      await client.downloadTo(destPath, decodeURIComponent(parsed.pathname));
    } finally {
      client.close();
    }
  }

  async function downloadRelease(releaseId) {
    return runQueued(() => downloadReleaseInternal(releaseId));
  }

  /** Lance le téléchargement en file d'attente (réponse API immédiate). */
  async function enqueueDownloadRelease(releaseId) {
    if (!config.storage.enabled) {
      return { ok: false, error: 'storage_disabled' };
    }

    try {
      const release = await getReleaseContext(releaseId);

      if (!release) {
        return { ok: false, error: 'release_not_found' };
      }

      ensureRoot();

      const linked = await tryLinkExistingFile(releaseId, release);

      if (linked) {
        await cleanupReplacedFiles(release.iso_item_id, releaseId);
        return linked;
      }

      await pool.query(
        `UPDATE iso_releases SET download_status = 'downloading' WHERE id = ?`,
        [releaseId]
      );

      runQueued(() => downloadReleaseInternal(releaseId, { skipPrep: true })).catch((error) => {
        logger.error({ err: error, releaseId }, 'Téléchargement en arrière-plan échoué');
      });

      return {
        ok: true,
        accepted: true,
        async: true,
        status: 'downloading',
        release_id: releaseId,
        message: 'Téléchargement démarré en arrière-plan'
      };
    } catch (error) {
      logger.error({ err: error, releaseId }, 'enqueueDownloadRelease échoué');

      return {
        ok: false,
        error: 'download_failed',
        message: String(error.message || error)
      };
    }
  }

  async function downloadReleaseInternal(releaseId, options = {}) {
    if (!config.storage.enabled) {
      return { skipped: true, reason: 'storage_disabled' };
    }

    let destPath = null;

    try {
      let release;

      if (!options.skipPrep) {
        release = await getReleaseContext(releaseId);

        if (!release) {
          return { ok: false, error: 'release_not_found' };
        }

        ensureRoot();

        const linked = await tryLinkExistingFile(releaseId, release);

        if (linked) {
          await cleanupReplacedFiles(release.iso_item_id, releaseId);
          return linked;
        }

        await pool.query(
          `UPDATE iso_releases SET download_status = 'downloading' WHERE id = ?`,
          [releaseId]
        );
      } else {
        release = await getReleaseContext(releaseId);

        if (!release) {
          return { ok: false, error: 'release_not_found' };
        }
      }

      const isoItem = releaseIsoItem(release);
      destPath = buildLocalPath(release, isoItem);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

      const parsed = new URL(release.url);

      if (parsed.protocol === 'ftp:') {
        await downloadFtpToFile(release.url, destPath, config.timeouts.ftpMs, {
          passive: release.ftp_passive !== false && release.ftp_passive !== 0
        });
      } else {
        await downloadHttpToFile(
          release.url,
          destPath,
          Boolean(release.allow_insecure_tls),
          config.timeouts.downloadMs
        );
      }

      const stat = await fs.promises.stat(destPath);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      await pool.query(
        `UPDATE iso_releases
         SET local_path = ?, download_status = 'completed', local_downloaded_at = ?, file_size = ?
         WHERE id = ?`,
        [destPath, now, stat.size, releaseId]
      );

      await cleanupReplacedFiles(release.iso_item_id, releaseId);

      return { ok: true, local_path: destPath, file_size: stat.size };
    } catch (error) {
      await pool.query(
        `UPDATE iso_releases SET download_status = 'failed' WHERE id = ?`,
        [releaseId]
      ).catch(() => {});

      if (destPath) {
        try {
          await fs.promises.unlink(destPath);
        } catch {
          /* fichier partiel absent */
        }
      }

      return {
        ok: false,
        error: 'download_failed',
        message: String(error.message || error)
      };
    }
  }

  async function ingestNewRelease(releaseId, source) {
    if (!config.storage.enabled || !config.storage.downloadOnDetect) {
      return;
    }

    return downloadRelease(releaseId);
  }

  async function onReleaseRemoved(release) {
    if (!release?.local_path) {
      return;
    }

    await deleteLocalFileSafe(release.local_path);
  }

  /**
   * Vérifie l'accès au répertoire de stockage sans exposer son chemin.
   */
  async function checkFilesystemAccess() {
    if (!config.storage.enabled) {
      return {
        enabled: false,
        reachable: null,
        readable: null,
        writable: null,
        ok: true
      };
    }

    const result = {
      enabled: true,
      reachable: false,
      readable: false,
      writable: false,
      ok: false,
      error: null
    };

    try {
      let stat;

      try {
        stat = fs.statSync(root);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          try {
            fs.mkdirSync(root, { recursive: true });
            stat = fs.statSync(root);
          } catch {
            result.error = 'storage_unreachable';
            return result;
          }
        } else {
          result.error = normalizeFsError(error, 'storage_unreachable');
          return result;
        }
      }

      if (!stat.isDirectory()) {
        result.error = 'storage_not_directory';
        return result;
      }

      result.reachable = true;

      try {
        await fs.promises.access(root, fs.constants.R_OK);
        await fs.promises.readdir(root);
        result.readable = true;
      } catch (error) {
        result.error = normalizeFsError(error, 'storage_not_readable');
        return result;
      }

      const probeName = `.iso-watcher-write-test-${process.pid}-${Date.now()}`;
      const probePath = path.join(root, probeName);

      try {
        await fs.promises.writeFile(probePath, 'ok', { flag: 'wx' });
        await fs.promises.unlink(probePath);
        result.writable = true;
      } catch (error) {
        result.error = normalizeFsError(error, 'storage_not_writable');
        return result;
      }

      result.ok = true;
      return result;
    } catch (error) {
      result.error = normalizeFsError(error, 'storage_check_failed');
      return result;
    }
  }

  async function getStorageStatus() {
    const [downloadingRows] = await pool.query(
      `SELECT r.id AS release_id, r.filename, r.version, r.download_status, r.iso_item_id,
              r.local_path, r.local_downloaded_at, r.file_size, r.detected_at,
              i.name AS iso_name, i.distribution
       FROM iso_releases r
       JOIN iso_items i ON i.id = r.iso_item_id
       WHERE r.download_status = 'downloading'
       ORDER BY r.detected_at DESC`
    );

    const [trackedRows] = await pool.query(
      `SELECT r.id AS release_id, r.filename, r.version, r.download_status, r.iso_item_id,
              r.local_path, r.local_downloaded_at, r.file_size, r.detected_at,
              i.name AS iso_name, i.distribution
       FROM iso_releases r
       JOIN iso_items i ON i.id = r.iso_item_id
       WHERE r.download_status != 'none' OR r.local_path IS NOT NULL
       ORDER BY
         CASE r.download_status
           WHEN 'downloading' THEN 0
           WHEN 'failed' THEN 1
           WHEN 'completed' THEN 2
           ELSE 3
         END,
         r.detected_at DESC
       LIMIT 50`
    );

    const [countRows] = await pool.query(
      `SELECT download_status, COUNT(*) AS count FROM iso_releases GROUP BY download_status`
    );

    const counts = {
      none: 0,
      downloading: 0,
      completed: 0,
      failed: 0,
      replaced: 0
    };

    for (const row of countRows) {
      const key = String(row.download_status || 'none');

      if (Object.prototype.hasOwnProperty.call(counts, key)) {
        counts[key] = Number(row.count) || 0;
      }
    }

    return {
      enabled: config.storage.enabled,
      use_subfolders: config.storage.useSubfolders,
      root: config.storage.enabled ? root : null,
      download_on_detect: config.storage.downloadOnDetect,
      replace_old_files: config.storage.replaceOldFiles,
      queue: {
        active: activeDownloads,
        queued: downloadQueue.length,
        max_parallel: maxParallel
      },
      counts,
      downloads_in_progress: downloadingRows,
      tracked_releases: trackedRows
    };
  }

  return {
    root,
    ensureRoot,
    buildLocalPath,
    getCandidatePaths,
    tryLinkExistingFile,
    downloadRelease,
    enqueueDownloadRelease,
    ingestNewRelease,
    onReleaseRemoved,
    deleteLocalFileSafe,
    cleanupReplacedFiles,
    getStorageStatus,
    checkFilesystemAccess
  };
}

function normalizeFsError(error, fallback) {
  const code = String(error?.code || '').toLowerCase();

  if (['eacces', 'eperm'].includes(code)) {
    return fallback;
  }

  if (['enoent', 'enotdir', 'eio', 'erofs', 'enospc'].includes(code)) {
    return fallback;
  }

  return fallback;
}

function sanitizePathSegment(value) {
  return String(value || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'unknown';
}
