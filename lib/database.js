import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { SQLITE_SCHEMA, SQLITE_MIGRATIONS } from './schema-sqlite.js';

function isSelectSql(sql) {
  const trimmed = String(sql).trim().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
}

function createSqlitePool(dbPath, logger) {
  const dir = path.dirname(dbPath);

  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return {
    driver: 'sqlite',
    async query(sql, params = []) {
      try {
        if (isSelectSql(sql)) {
          const rows = db.prepare(sql).all(...params);
          return [rows];
        }

        const info = db.prepare(sql).run(...params);

        return [{
          insertId: Number(info.lastInsertRowid),
          affectedRows: info.changes
        }];
      } catch (error) {
        error.sql = sql;
        throw error;
      }
    },
    async close() {
      db.close();
    }
  };
}

function createMysqlPool(config) {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: config.mysql.connectionLimit,
    charset: 'utf8mb4'
  });

  return {
    driver: 'mysql',
    query: (sql, params) => pool.query(sql, params),
    close: () => pool.end()
  };
}

async function applyScanInterruptedStatusMigration(pool, logger) {
  const statements = [
    `ALTER TABLE scan_runs MODIFY COLUMN status ENUM(
      'running', 'success', 'partial_error', 'error', 'interrupted'
    ) NOT NULL DEFAULT 'running'`,
    `ALTER TABLE scan_run_sources MODIFY COLUMN status ENUM(
      'pending', 'running', 'success', 'error', 'skipped', 'interrupted'
    ) NOT NULL DEFAULT 'pending'`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  logger?.info?.('MySQL : statuts scan « interrupted » disponibles');
}

async function initMysql(pool, logger) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_type ENUM('admin', 'internal', 'public') NOT NULL,
      username VARCHAR(190) NULL,
      email VARCHAR(320) NULL,
      external_ref VARCHAR(190) NULL,
      display_name VARCHAR(190) NULL,
      created_by_username VARCHAR(190) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_public_email (user_type, email),
      KEY idx_username (username),
      KEY idx_email (email),
      KEY idx_external_ref (external_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS iso_items (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      system_family VARCHAR(100) NULL,
      distribution VARCHAR(100) NULL,
      edition VARCHAR(100) NULL,
      version_track VARCHAR(100) NULL,
      architecture ENUM('amd64', 'x86', 'arm64', 'armhf', 'i386', 'other') DEFAULT 'amd64',
      file_type ENUM('iso', 'img', 'zip', 'exe', 'other') DEFAULT 'iso',
      description TEXT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_public BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_user_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      KEY idx_distribution (distribution),
      KEY idx_architecture (architecture),
      KEY idx_enabled (enabled),
      KEY idx_public (is_public)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS iso_sources (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      iso_item_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(190) NOT NULL,
      protocol ENUM('http', 'https', 'ftp') NOT NULL,
      url TEXT NOT NULL,
      allow_insecure_tls BOOLEAN NOT NULL DEFAULT FALSE,
      ftp_passive BOOLEAN NOT NULL DEFAULT TRUE,
      match_regex TEXT NOT NULL,
      version_regex TEXT NULL,
      checksum_regex TEXT NULL,
      discovery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      discovery_depth INT NOT NULL DEFAULT 0,
      discovery_regex TEXT NULL,
      priority INT NOT NULL DEFAULT 100,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_status ENUM('never', 'ok', 'error') NOT NULL DEFAULT 'never',
      last_error TEXT NULL,
      last_checked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (iso_item_id) REFERENCES iso_items(id) ON DELETE CASCADE,
      KEY idx_iso_item_id (iso_item_id),
      KEY idx_enabled (enabled),
      KEY idx_priority (priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS iso_releases (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      iso_item_id BIGINT UNSIGNED NOT NULL,
      source_id BIGINT UNSIGNED NULL,
      version VARCHAR(190) NULL,
      filename VARCHAR(500) NOT NULL,
      url TEXT NOT NULL,
      checksum_url TEXT NULL,
      checksum_sha256 VARCHAR(128) NULL,
      file_size BIGINT UNSIGNED NULL,
      published_at DATETIME NULL,
      detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_latest BOOLEAN NOT NULL DEFAULT FALSE,
      raw_metadata JSON NULL,
      local_path TEXT NULL,
      download_status VARCHAR(32) NOT NULL DEFAULT 'none',
      local_downloaded_at DATETIME NULL,
      FOREIGN KEY (iso_item_id) REFERENCES iso_items(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES iso_sources(id) ON DELETE SET NULL,
      UNIQUE KEY uq_iso_release_filename (iso_item_id, filename),
      KEY idx_iso_latest (iso_item_id, is_latest),
      KEY idx_detected_at (detected_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS destinations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      destination_type ENUM('email', 'discord_webhook', 'teams_webhook', 'generic_webhook') NOT NULL,
      label VARCHAR(190) NULL,
      target TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      config JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_user_id (user_id),
      KEY idx_destination_type (destination_type),
      KEY idx_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      iso_item_id BIGINT UNSIGNED NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      notify_mode ENUM('immediate', 'hourly_digest', 'daily_digest') NOT NULL DEFAULT 'immediate',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (iso_item_id) REFERENCES iso_items(id) ON DELETE CASCADE,
      UNIQUE KEY uq_user_iso (user_id, iso_item_id),
      KEY idx_user_enabled (user_id, enabled),
      KEY idx_iso_enabled (iso_item_id, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS scan_runs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trigger_type ENUM('scheduler', 'manual', 'test') NOT NULL,
      triggered_by_user_id BIGINT UNSIGNED NULL,
      status ENUM('running', 'success', 'partial_error', 'error', 'interrupted') NOT NULL DEFAULT 'running',
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      checked_sources INT NOT NULL DEFAULT 0,
      found_releases INT NOT NULL DEFAULT 0,
      new_releases INT NOT NULL DEFAULT 0,
      total_sources INT NOT NULL DEFAULT 0,
      completed_sources INT NOT NULL DEFAULT 0,
      notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      context_json JSON NULL,
      duration_ms INT UNSIGNED NULL,
      error_message TEXT NULL,
      FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS notification_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      iso_release_id BIGINT UNSIGNED NOT NULL,
      event_type ENUM('new_release', 'test') NOT NULL DEFAULT 'new_release',
      title VARCHAR(500) NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (iso_release_id) REFERENCES iso_releases(id) ON DELETE CASCADE,
      KEY idx_event_type (event_type),
      KEY idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS notification_deliveries (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      notification_event_id BIGINT UNSIGNED NOT NULL,
      destination_id BIGINT UNSIGNED NOT NULL,
      status ENUM('pending', 'sent', 'failed', 'rate_limited') NOT NULL DEFAULT 'pending',
      scheduled_for DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      digest_bucket VARCHAR(32) NULL,
      attempt_count INT NOT NULL DEFAULT 0,
      last_attempt_at DATETIME NULL,
      next_retry_at DATETIME NULL,
      response_code INT NULL,
      response_body TEXT NULL,
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (notification_event_id) REFERENCES notification_events(id) ON DELETE CASCADE,
      FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE,
      KEY idx_status_next_retry (status, next_retry_at),
      KEY idx_destination_status (destination_id, status),
      KEY idx_scheduled_status (status, scheduled_for)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS scan_run_sources (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      scan_run_id BIGINT UNSIGNED NOT NULL,
      source_id BIGINT UNSIGNED NOT NULL,
      iso_item_id BIGINT UNSIGNED NOT NULL,
      iso_name VARCHAR(190) NULL,
      source_name VARCHAR(190) NULL,
      source_url TEXT NULL,
      status ENUM('pending', 'running', 'success', 'error', 'skipped', 'interrupted') NOT NULL DEFAULT 'pending',
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      duration_ms INT UNSIGNED NULL,
      matches_found INT NOT NULL DEFAULT 0,
      new_releases INT NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      discovery_json JSON NULL,
      log_excerpt TEXT NULL,
      FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      KEY idx_scan_run_id (scan_run_id),
      KEY idx_scan_run_status (scan_run_id, status),
      KEY idx_source_id (source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS scan_run_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      scan_run_id BIGINT UNSIGNED NOT NULL,
      level ENUM('debug', 'info', 'warn', 'error') NOT NULL DEFAULT 'info',
      category VARCHAR(64) NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      context_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      KEY idx_scan_run_log (scan_run_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }

  try {
    await applyScanInterruptedStatusMigration(pool, logger);
  } catch (error) {
    logger?.error?.({ err: error.message }, 'Migration MySQL statut interrupted échouée');
    throw error;
  }

  const migrations = [
    'ALTER TABLE iso_releases ADD COLUMN local_path TEXT NULL',
    'ALTER TABLE iso_releases ADD COLUMN download_status VARCHAR(32) NOT NULL DEFAULT \'none\'',
    'ALTER TABLE iso_releases ADD COLUMN local_downloaded_at DATETIME NULL',
    'ALTER TABLE iso_items ADD COLUMN catalog_preset_id VARCHAR(190) NULL',
    'ALTER TABLE iso_items ADD COLUMN catalog_source VARCHAR(32) NULL',
    'ALTER TABLE iso_sources ADD COLUMN catalog_preset_id VARCHAR(190) NULL',
    'ALTER TABLE iso_sources ADD COLUMN catalog_source_key VARCHAR(64) NULL',
    'ALTER TABLE iso_sources ADD COLUMN catalog_source VARCHAR(32) NULL'
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (error) {
      if (![1060, 1061, 1062].includes(error?.errno)) {
        logger?.warn?.({ err: error.message, sql }, 'Migration MySQL ignorée');
      }
    }
  }
}

async function initSqlite(pool, logger) {
  for (const statement of SQLITE_SCHEMA) {
    await pool.query(statement);
  }

  for (const sql of SQLITE_MIGRATIONS) {
    try {
      await pool.query(sql);
    } catch (error) {
      if (!String(error.message).includes('duplicate column')) {
        logger?.warn?.({ err: error.message, sql }, 'Migration SQLite ignorée');
      }
    }
  }
}

export async function createDatabase(config, logger = console) {
  let pool;

  if (config.db.driver === 'mysql') {
    if (!config.db.mysql.password && !process.env.MYSQL_ALLOW_EMPTY_PASSWORD) {
      throw new Error('DB_DRIVER=mysql requiert MYSQL_PASSWORD (ou MYSQL_ALLOW_EMPTY_PASSWORD=1).');
    }

    pool = createMysqlPool(config.db);
    await initMysql(pool, logger);
  } else {
    pool = createSqlitePool(config.db.sqlitePath, logger);
    await initSqlite(pool, logger);
  }

  return {
    pool,
    driver: config.db.driver,
    async init() {
      if (config.db.driver === 'mysql') {
        await initMysql(pool, logger);
      } else {
        await initSqlite(pool, logger);
      }
    }
  };
}
