# ISO Watcher API - Complete reference

[![Français](https://img.shields.io/badge/lang-Français-lightgrey.svg)](API.md) [![English](https://img.shields.io/badge/lang-English-blue.svg)](API.en.md) [![License](https://img.shields.io/badge/License-MIT-success?style=flat-square)](../LICENSE)

**API Version**: `0.2.0`  
**Base URL**: `http://<host>:<port>` (default `http://127.0.0.1:3088`)

All JSON routes return `Content-Type: application/json` unless stated otherwise.

---

## Table of contents

1. [Authentication](#authentication)
2. [Error format](#error-format)
3. [System and health](#system-and-health)
4. [Configuration and web interfaces](#configuration-and-web-interfaces)
5. [Administration](#administration)
6. [Users](#users)
7. [ISO (iso_items)](#iso-iso_items)
8. [Sources (iso_sources)](#sources-iso_sources)
9. [Releases and local storage](#releases-and-local-storage)
10. [Scans](#scans)
11. [Link verification](#link-verification)
12. [Destinations](#destinations)
13. [Subscriptions](#subscriptions)
14. [Notifications](#notifications)
15. [Models and enumerations](#models-and-enumerations)
16. [Complete examples](#complete-api-call-examples)
    - [Public without auth](#1-public-without-authentication)
    - [Public user](#2-public-user)
    - [Internal actor](#3-internal-actor)
    - [Administrator](#4-administrator-actor)
    - [UI sessions](#5-ui-sessions-browser)
    - [Edge cases](#6-edge-cases-and-errors)

---

## Authentication

### Headers

| Header | Required | Description |
|---------|-------------|-------------|
| `X-Intranet-Token` | Yes* | Shared token (`INTRANET_SHARED_TOKEN`) for machine-to-machine API |
| `X-UI-Session` | Alternative | Signed session issued by `ui-login` / `ui-session` (web interfaces) |
| `X-Actor-Username` | No | Identifier for audit (default: `system`) |
| `X-Actor-Type` | No | `internal`, `admin`, `public` (default: `internal`) |
| `X-Public-Email` | Conditional | Public user email (routes scoped to a public account) |

\* Except routes listed as **no auth** below.

### Actor types

| Type | Usage |
|------|--------|
| `internal` | Intranet, scripts, operators |
| `admin` | `/admin` console, `admin/*` routes |
| `public` | Public portal (catalog, email-based subscriptions) |

> **Warning**: with `X-Intranet-Token`, the actor type is **declarative**. Protect the token; use `X-UI-Session` for browsers.

### Routes without authentication

| Route | Method |
|-------|---------|
| `/health`, `/ready`, `/version` | GET |
| `/`, `/ui/*`, `/docs`, `/admin/*` | GET (static files) |
| `/api/v1/admin/ui-config` | GET |
| `/api/v1/admin/ui-login` | POST |
| `/api/v1/public/ui-config` | GET |
| `/api/v1/public/ui-session` | POST |
| `/api/v1/releases/recent?public=true` | GET |

### Private network restricted access

`POST /api/v1/admin/ui-login` and `POST /api/v1/public/ui-session` may be limited to private IPs (`ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK`, `PUBLIC_UI_RESTRICT_TO_PRIVATE_NETWORK`).

---

## Error format

```json
{
  "error": "unauthorized",
  "message": "Optional description"
}
```

### Common HTTP codes and `error` values

| HTTP | `error` | Meaning |
|------|---------|---------------|
| 400 | `email_required`, `discovery_regex_required`, `invalid_release_id`, … | Invalid request |
| 401 | `unauthorized`, `invalid_credentials`, `invalid_ui_session` | Authentication |
| 403 | `admin_required`, `forbidden`, `public_actions_disabled`, `private_network_required` | Insufficient permissions |
| 404 | `*_not_found` | Resource missing |
| 409 | `link_check_already_running`, `user_has_active_subscriptions` | Conflict |
| 502 | `delivery_failed` | Notification delivery failure |
| 503 | `storage_disabled`, `admin_ui_disabled` | Service unavailable |

---

## System and health

### `GET /health`

**Auth**: no

Liveness check + storage (without exposing the directory path).

**Response 200**

```json
{
  "ok": true,
  "version": "0.2.0",
  "db_driver": "sqlite",
  "storage_enabled": true,
  "storage": {
    "enabled": true,
    "reachable": true,
    "readable": true,
    "writable": true,
    "ok": true,
    "error": null
  }
}
```

| `storage` field | Description |
|-----------------|-------------|
| `enabled` | `STORAGE_ENABLED` |
| `reachable` | Directory exists or can be created |
| `readable` | Read / listing OK |
| `writable` | Write test + probe file deletion |
| `ok` | `true` if storage disabled or all three checks OK |
| `error` | `storage_unreachable`, `storage_not_readable`, `storage_not_writable`, … |

Global `ok` is `false` if storage is enabled but `storage.ok` is `false`.

---

### `GET /ready`

**Auth**: no

Checks database connectivity.

**Response 200**

```json
{
  "ok": true,
  "db_driver": "sqlite",
  "version": "0.2.0"
}
```

**Response 503**: database unreachable.

---

### `GET /version`

**Auth**: no

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite"
}
```

---

## Configuration and web interfaces

### `GET /api/v1/config/public`

**Auth**: yes (token or UI session)

Non-sensitive configuration (no disk paths).

**Response 200**

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite",
  "storage_enabled": true,
  "storage_use_subfolders": true,
  "ui_enabled": true,
  "public_actions_enabled": false,
  "public_actions_auto_auth": false,
  "admin_ui_enabled": true,
  "admin_ui_auth_required": true
}
```

---

### `GET /api/v1/public/ui-config`

**Auth**: no

Settings for the public page `/`.

**Response 200**

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite",
  "public_actions_enabled": false,
  "public_actions_auto_auth": false,
  "admin_ui_enabled": true,
  "admin_ui_auth_required": true,
  "link_check_enabled": true,
  "scheduler_enabled": true
}
```

---

### `POST /api/v1/public/ui-session`

**Auth**: no (conditions below)

Obtains an operator session for the public page.

**Conditions**: `PUBLIC_UI_ALLOW_ACTIONS=true`, `PUBLIC_UI_ACTIONS_AUTO_AUTH=true`, private network if restriction enabled.

**Body**: empty or `{}`

**Response 200**

```json
{
  "ok": true,
  "ui_session": "<signed-token>",
  "actor": { "username": "operator", "type": "internal" }
}
```

**Errors**: `public_actions_disabled`, `auto_auth_disabled`, `private_network_required`

---

### `GET /api/v1/admin/ui-config`

**Auth**: no

**Response 200**

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite",
  "admin_ui_enabled": true,
  "auth_required": true,
  "storage_enabled": true,
  "scheduler_enabled": true,
  "link_check_enabled": true
}
```

---

### `POST /api/v1/admin/ui-login`

**Auth**: no

`/admin` console login.

**JSON body**

| Field | Type | Description |
|-------|------|-------------|
| `password` | string | Password if `ADMIN_UI_AUTH_REQUIRED=true` |

**Response 200**

```json
{
  "ok": true,
  "ui_session": "<signed-token>",
  "actor": { "username": "admin", "type": "admin" }
}
```

**Errors**: `invalid_credentials`, `admin_ui_disabled`, `private_network_required`

---

## Administration

### `GET /api/v1/admin/overview`

**Auth**: yes - **`X-Actor-Type: admin`** (or admin UI session)

Dashboard.

**Response 200**

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite",
  "counts": { "iso_items": 12, "releases": 340, "users": 5 },
  "recent_scans": [ { "id": 1, "status": "success", "trigger_type": "manual", "started_at": "...", "new_releases": 2 } ],
  "storage": { "enabled": true, "counts": { "completed": 10, "downloading": 1 }, "queue": { "active": 1, "queued": 0 } },
  "config": {
    "storage_enabled": true,
    "scheduler_enabled": true,
    "scheduler_cron": "0 * * * *",
    "link_check_enabled": true,
    "admin_email": "admin@example.com"
  }
}
```

---

### `GET /api/v1/admin/users`

**Auth**: admin

**Query**

| Parameter | Default | Description |
|-----------|--------|-------------|
| `limit` | `100` | 1–500 |

**Response 200**: array of users (`id`, `user_type`, `username`, `email`, `display_name`, `external_ref`, `created_at`).

---

### `POST /api/v1/admin/release-link-check`

**Auth**: `admin` **or** `internal` if `PUBLIC_UI_ALLOW_ACTIONS=true`

Verifies release URLs; removes those whose link is permanently dead.

**JSON body**

| Field | Type | Default | Description |
|-------|------|--------|-------------|
| `send_admin_report` | boolean | `true` | Send admin email report |
| `report_hours` | number | `24` | "New releases" window for the report (1–168) |

**Response 200**

```json
{
  "skipped": false,
  "checked": 120,
  "valid": 118,
  "removed": 2,
  "new_in_period": 5,
  "report_hours": 24,
  "duration_ms": 45000,
  "removed_releases": [
    { "id": 10, "iso_name": "Ubuntu", "filename": "ubuntu.iso", "version": "24.04", "url": "https://...", "reason": "http_404", "http_status": 404 }
  ]
}
```

**Errors**: `link_check_already_running`, `admin_or_operator_required`

---

## Users

### `POST /api/v1/users/upsert`

**Auth**: yes

Creates or updates a user (key: `user_type` + `email` / `external_ref` / `username`).

**JSON body**

| Field | Type | Description |
|-------|------|-------------|
| `user_type` | string | `internal` (default), `public` |
| `email` | string | Normalized email |
| `username` | string | Optional |
| `external_ref` | string | External reference |
| `display_name` | string | Display name |

**Response 200**: full `users` object.

---

### `GET /api/v1/users/:userId`

**Auth**: yes

**Response 200**: user or **404** `user_not_found`.

---

### `GET /api/v1/public/users/by-email`

**Auth**: yes (often `public` actor)

**Query**: `email` (required)

**Response 200**: user with `user_type=public` or **404**.

---

### `DELETE /api/v1/public/users/by-email`

**Auth**: yes

**Query**: `email`

**Response 200**

```json
{ "deleted": true }
```

or `{ "deleted": false, "reason": "not_found" }`

**409** `user_has_active_subscriptions` if active subscriptions exist.

---

## ISO (iso_items)

### `GET /api/v1/iso-items`

**Auth**: yes

**Query**

| Parameter | Description |
|-----------|-------------|
| `distribution` | Distribution filter |
| `architecture` | Architecture filter |
| `enabled` | `true` / `false` |
| `public` | `is_public` filter |

**Response 200**: array of `iso_items`.

---

### `POST /api/v1/iso-items`

**Auth**: yes

**JSON body**

| Field | Type | Default | Description |
|-------|------|--------|-------------|
| `name` | string | **required** | ISO name |
| `system_family` | string | null | e.g. `linux` |
| `distribution` | string | null | e.g. `ubuntu` |
| `edition` | string | null | |
| `version_track` | string | null | |
| `architecture` | string | `amd64` | |
| `file_type` | string | `iso` | |
| `description` | string | null | |
| `enabled` | boolean | `true` | |
| `is_public` | boolean | `true` | Visible in public catalog |
| `created_by_user_id` | number | null | |

**Response 200**: created ISO.

---

### `GET /api/v1/iso-items/:isoItemId`

**Auth**: yes - **Response**: ISO or **404** `iso_item_not_found`.

---

### `PATCH /api/v1/iso-items/:isoItemId`

**Auth**: yes

Editable fields: `name`, `system_family`, `distribution`, `edition`, `version_track`, `architecture`, `file_type`, `description`, `enabled`, `is_public`.

**Response 200**: updated ISO.

---

### `POST /api/v1/iso-items/:isoItemId/enable`

### `POST /api/v1/iso-items/:isoItemId/disable`

**Auth**: yes - **Response**: `{ "enabled": true|false }` (per `setIsoItemEnabled` implementation).

---

### `DELETE /api/v1/iso-items/:isoItemId`

**Auth**: yes - **Response**: `{ "deleted": true }`.

---

## Sources (iso_sources)

### `GET /api/v1/iso-items/:isoItemId/sources`

**Auth**: yes - **Response**: array of sources sorted by `priority`.

---

### `POST /api/v1/iso-items/:isoItemId/sources`

**Auth**: yes

**JSON body**

| Field | Type | Default | Description |
|-------|------|--------|-------------|
| `name` | string | **required** | Label |
| `url` | string | **required** | HTTP(S) or FTP URL |
| `protocol` | string | auto | `http`, `https`, `ftp` (inferred from URL) |
| `allow_insecure_tls` | boolean | `false` | |
| `ftp_passive` | boolean | `true` | |
| `match_regex` | string | **required** | ISO file filter |
| `version_regex` | string | null | Version extraction |
| `checksum_regex` | string | null | |
| `discovery_enabled` | boolean | `false` | Recursive exploration |
| `discovery_depth` | number | `1` | 1–6 |
| `discovery_regex` | string | if discovery | Subfolder regex |
| `priority` | number | `100` | Lower = higher priority |
| `enabled` | boolean | `true` | |

**Errors**: `discovery_regex_required`, invalid regex.

**Response 200**: created source.

---

### `PATCH /api/v1/sources/:sourceId`

**Auth**: yes - same fields as create (partial).

---

### `POST /api/v1/sources/:sourceId/test`

**Auth**: yes

Tests the source without persisting a release.

**Response 200**

```json
{
  "ok": true,
  "source_id": 1,
  "matches": [
    {
      "filename": "ubuntu-24.04.iso",
      "url": "https://...",
      "version": "24.04",
      "file_size": 1234567890
    }
  ],
  "discovery": {
    "enabled": true,
    "scanned_directories": 3,
    "scanned_urls": 5
  }
}
```

---

### `POST /api/v1/sources/:sourceId/scan`

**Auth**: yes

**JSON body**

| Field | Type | Default |
|-------|------|--------|
| `notify` | boolean | `true` |
| `triggered_by_user_id` | number | null |

**Response 200**: see [Asynchronous scans](#asynchronous-scans).

---

### `POST /api/v1/sources/:sourceId/enable` / `disable`

### `DELETE /api/v1/sources/:sourceId`

**Auth**: yes.

---

### `GET /api/v1/iso-items/:isoItemId/latest`

**Auth**: yes - Latest release with `is_latest=true` or **404** `release_not_found`.

---

### `GET /api/v1/iso-items/:isoItemId/releases`

**Auth**: yes

**Query**: `limit` (default `100`, max `500`).

---

### `GET /api/v1/iso-items/:isoItemId/download`

**Auth**: yes

Download metadata for the **latest** release (remote URL, not the local file).

**Response 200**

```json
{
  "iso_item_id": 1,
  "source_id": 2,
  "name": "Ubuntu Desktop",
  "distribution": "ubuntu",
  "version": "24.04.1",
  "filename": "ubuntu.iso",
  "download_url": "https://...",
  "checksum_url": null,
  "checksum_sha256": null,
  "file_size": 1234567890,
  "published_at": null,
  "detected_at": "2026-05-22T10:00:00.000Z",
  "is_latest": true
}
```

---

## Releases and local storage

### `GET /api/v1/releases/recent`

**Auth**: yes - **except** `?public=true` (no token, `public` actor)

**Query**

| Parameter | Default | Description |
|-----------|--------|-------------|
| `limit` | `50` | 1–500 |
| `public` | - | `true` = public ISOs only |
| `enabled` | - | `true` / `false` on `iso_items` |
| `latest` | - | `true` = `is_latest` |
| `distribution` | - | Filter |
| `architecture` | - | Filter |

**Response 200**: array of releases with joined `iso_name`, `distribution`, `architecture`, `edition`.

Notable release fields: `id`, `iso_item_id`, `source_id`, `version`, `filename`, `url`, `file_size`, `checksum_url`, `checksum_sha256`, `detected_at`, `is_latest`, `download_status`, `local_path`, `local_downloaded_at`.

---

### `POST /api/v1/releases/:releaseId/download`

**Auth**: yes

Triggers local download (`STORAGE_ENABLED=true`).

**Response 200**

```json
{
  "ok": true,
  "release_id": 42,
  "local_path": "/internal/path/not-exposed-by-this-doc.iso",
  "linked_existing": false
}
```

**Errors**: `storage_disabled`, `release_not_found`, network failure **502**.

---

### `GET /api/v1/releases/:releaseId/local-file`

**Auth**: yes

**Response**: binary stream `application/octet-stream` (local file).

**Errors**: `local_file_not_found`, `local_file_missing`.

---

### `GET /api/v1/storage/status`

**Auth**: `admin` or `internal`

Storage state, queue, tracked releases.

**Response 200**

```json
{
  "enabled": true,
  "use_subfolders": true,
  "root": "/configured/path",
  "download_on_detect": true,
  "replace_old_files": true,
  "queue": { "active": 1, "queued": 2, "max_parallel": 2 },
  "counts": { "none": 100, "downloading": 1, "completed": 50, "failed": 2, "replaced": 3 },
  "downloads_in_progress": [ ],
  "tracked_releases": [ ]
}
```

---

## Scans

### Asynchronous scans

`POST /scans/run`, `POST /sources/:id/scan`, `POST /iso-items/:id/scan` start a background scan.

**Immediate 200 response**

```json
{
  "scan_run_id": 15,
  "status": "running",
  "async": true,
  "message": "Scan accepted and running in the background"
}
```

Poll `GET /api/v1/scans/:scanRunId` until `is_finished: true`.

---

### `POST /api/v1/scans/run`

**Auth**: yes - `internal`/`admin`; or operator if `PUBLIC_UI_ALLOW_ACTIONS=true`

Global scan of all active sources.

**JSON body**

| Field | Type | Default |
|-------|------|--------|
| `notify` | boolean | `true` |
| `triggered_by_user_id` | number | null |

**403** `public_actions_disabled` if public actions disabled and actor is not admin.

---

### `POST /api/v1/iso-items/:isoItemId/scan`

**Auth**: yes - scan all sources for an ISO.

**Body**: same as `scans/run`.

---

### `POST /api/v1/scans/test`

**Auth**: yes

Tests a source + optional test notification.

**JSON body**

| Field | Type | Description |
|-------|------|-------------|
| `source_id` | number | **required** |
| `send_test_notification` | boolean | Optional |
| `destination_id` | number | If sending test |

**Response 200**: `testSource` result (+ send if requested).

---

### `GET /api/v1/scans`

**Auth**: yes

**Query**: `limit` (default `100`).

**Response 200**: list with computed fields `is_finished`, `progress_percent`.

`scan_runs.status` values: `running`, `success`, `error`, `partial_error`.

---

### `GET /api/v1/scans/:scanRunId`

**Auth**: yes

**Query**

| Parameter | Default | Description |
|-----------|--------|-------------|
| `log_limit` | `SCAN_LOG_API_DEFAULT_LIMIT` (default 2000) | Cap `SCAN_LOG_API_MAX_LIMIT` (0 = up to 100000) |
| `log_since_id` | `0` | Logs after this ID |

**Response 200**

```json
{
  "id": 15,
  "status": "running",
  "trigger_type": "manual",
  "started_at": "...",
  "finished_at": null,
  "total_sources": 10,
  "completed_sources": 3,
  "new_releases": 1,
  "is_finished": false,
  "progress_percent": 30,
  "sources": [ { "source_id": 1, "status": "success", "matches_found": 2, "new_releases": 0, "discovery": {} } ],
  "logs": [ { "id": 1, "level": "info", "message": "...", "context": {}, "created_at": "..." } ]
}
```

---

### `GET /api/v1/scans/:scanRunId/logs`

**Auth**: yes

**Query**: `limit`, `since_id`

**Response 200**

```json
{
  "scan_run_id": 15,
  "is_finished": false,
  "status": "running",
  "logs": [ ]
}
```

---

## Link verification

See [`POST /api/v1/admin/release-link-check`](#post-apiv1adminrelease-link-check).

Scheduled via `LINK_CHECK_CRON` if `LINK_CHECK_ENABLED=true`.

---

## Destinations

### `GET /api/v1/destination-types`

**Auth**: yes

**Response 200**

```json
[
  { "type": "email", "name": "Email HTML", "supports_grouping": true },
  { "type": "discord_webhook", "name": "Discord Webhook", "supports_embeds": true, "supports_grouping": true },
  { "type": "teams_webhook", "name": "Microsoft Teams Workflow Webhook", "supports_adaptive_cards": true, "supports_grouping": true },
  { "type": "generic_webhook", "name": "Generic JSON webhook", "supports_grouping": true }
]
```

---

### `GET /api/v1/users/:userId/destinations`

**Auth**: yes - `public` actor: `X-Public-Email` header + same `userId`.

---

### `POST /api/v1/users/:userId/destinations`

**JSON body**

| Field | Type | Description |
|-------|------|-------------|
| `destination_type` | string | `email`, `discord_webhook`, `teams_webhook`, `generic_webhook` |
| `label` | string | Optional |
| `target` | string | Email or webhook URL |
| `enabled` | boolean | default `true` |
| `config` | object | Channel options (JSON) |

---

### `PATCH /api/v1/destinations/:destinationId`

Fields: `destination_type`, `label`, `target`, `enabled`, `config`.

---

### `POST /api/v1/destinations/:destinationId/test`

**Auth**: yes (+ ownership if `public`)

**Body**: `{ "message": "Optional text" }`

**Response 200**: `{ "sent": true, "channel": "discord_webhook" }`

---

### `POST /api/v1/destinations/:destinationId/enable` / `disable`

### `DELETE /api/v1/destinations/:destinationId`

---

## Subscriptions

### `GET /api/v1/users/:userId/subscriptions`

**Auth**: yes - list with joined ISO info.

---

### `GET /api/v1/public/subscriptions?email=`

**Auth**: yes - **400** if email missing; `[]` if user unknown.

---

### `POST /api/v1/users/:userId/subscriptions`

**JSON body**

| Field | Type | Default |
|-------|------|--------|
| `iso_item_id` | number | **required** |
| `notify_mode` | string | `immediate` |
| `enabled` | boolean | `true` |

Modes: `immediate`, `hourly_digest`, `daily_digest`.

---

### `POST /api/v1/public/subscriptions`

Create public account + subscriptions + destinations in one request.

**JSON body**

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | **required** |
| `display_name` | string | Optional |
| `iso_item_ids` | number[] | ISOs to follow |
| `notify_mode` | string | default `immediate` |
| `destinations` | array | `{ destination_type, label, target, config }` |

**Response 200**

```json
{
  "user": { "id": 1, "email": "user@example.com", "user_type": "public" },
  "subscriptions": [ ],
  "destinations": [ ]
}
```

---

### `PATCH /api/v1/subscriptions/:subscriptionId`

Fields: `enabled`, `notify_mode`.

---

### `DELETE /api/v1/subscriptions/:subscriptionId`

**Response**: `{ "deleted": true }`.

---

### `DELETE /api/v1/public/subscriptions`

**JSON body**

| Field | Type |
|-------|------|
| `email` | string |
| `iso_item_ids` | number[] |

**Response**: `{ "deleted": <count> }`.

---

## Notifications

### `GET /api/v1/notifications/events`

**Auth**: yes

**Query**: `limit` (default `100`).

---

### `GET /api/v1/notifications/events/:eventId`

**Auth**: yes - detail or **404** `event_not_found`.

---

### `GET /api/v1/notifications/deliveries`

**Auth**: yes

**Query**

| Parameter | Description |
|-----------|-------------|
| `status` | `pending`, `sent`, `failed`, … |
| `destination_id` | Filter |

Max 500 rows.

---

### `POST /api/v1/notifications/deliveries/:deliveryId/retry`

**Auth**: yes - sets back to `pending` and retries delivery.

---

### `POST /api/v1/notifications/test`

**Auth**: yes (admin/intranet)

**JSON body**

| Field | Type |
|-------|------|
| `destination_id` | number **required** |
| `iso_item_id` | number optional |
| `include_fake_release` | boolean (not used directly) |

---

### `POST /api/v1/notifications/preview`

**Auth**: yes

HTML / payload preview without sending.

**JSON body**

| Field | Type |
|-------|------|
| `destination_type` | string (default `email`) |
| `release_ids` | number[] |

**Response 200**: preview structure per channel.

---

## Models and enumerations

### `download_status` (releases)

| Value | Description |
|--------|-------------|
| `none` | No local copy |
| `downloading` | Download in progress |
| `completed` | Local file OK |
| `failed` | Failure |
| `replaced` | Old file replaced |

### `user_type`

`internal`, `public`

### `notify_mode`

`immediate`, `hourly_digest`, `daily_digest`

### `scan_runs.trigger_type`

`manual`, `scheduled`, …

### `destination.config` (examples)

**Discord**: `{ "username": "ISO Watcher", "avatar_url": "..." }`  
**Email**: grouping options per implementation.

---

## Complete API call examples

Base: `http://<host>:3088` - replace `VOTRE_TOKEN` with `INTRANET_SHARED_TOKEN`.

### Actor matrix

| Actor | Headers | Usage |
|--------|----------|--------|
| **None** | - | `/health`, `/ready`, catalog `?public=true` |
| **public** | Token + `X-Actor-Type: public` + `X-Public-Email` | Portal: own subscriptions/destinations only |
| **internal** | Token + `X-Actor-Type: internal` | Intranet, scripts, operator |
| **admin** | Token + `X-Actor-Type: admin` or `X-UI-Session` | `/admin` console, `/admin/*` routes |

---

### 1. Public (without authentication)

**GET /health**

```bash
curl -s http://127.0.0.1:3088/health
```

```json
{
  "ok": true,
  "version": "0.2.0",
  "db_driver": "mysql",
  "storage_enabled": true,
  "storage": {
    "enabled": true,
    "reachable": true,
    "readable": true,
    "writable": true,
    "ok": true,
    "error": null
  }
}
```

**GET /api/v1/releases/recent?public=true&enabled=true&limit=5** (no token)

```bash
curl -s "http://127.0.0.1:3088/api/v1/releases/recent?public=true&enabled=true&limit=5"
```

```json
[
  {
    "id": 42,
    "iso_item_id": 3,
    "filename": "ubuntu-24.04.1-desktop-amd64.iso",
    "version": "24.04.1",
    "url": "https://releases.ubuntu.com/24.04.1/…",
    "file_size": 6345887744,
    "detected_at": "2026-05-20 14:22:00",
    "is_latest": true,
    "download_status": "completed",
    "iso_name": "Ubuntu Desktop",
    "distribution": "ubuntu",
    "architecture": "amd64"
  }
]
```

---

### 2. Public user

**POST /api/v1/public/subscriptions** - full signup

```bash
curl -s -X POST http://127.0.0.1:3088/api/v1/public/subscriptions \
  -H "X-Intranet-Token: VOTRE_TOKEN" \
  -H "X-Actor-Type: public" \
  -H "X-Actor-Username: portal" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "display_name": "Jean Dupont",
    "iso_item_ids": [3, 7],
    "notify_mode": "immediate",
    "destinations": [{
      "destination_type": "discord_webhook",
      "label": "Mon salon",
      "target": "https://discord.com/api/webhooks/…",
      "config": { "username": "ISO Watcher" }
    }]
  }'
```

```json
{
  "user": { "id": 12, "user_type": "public", "email": "user@example.com" },
  "subscriptions": [{ "id": 30, "iso_item_id": 3, "notify_mode": "immediate", "enabled": true }],
  "destinations": [{ "id": 8, "destination_type": "discord_webhook", "enabled": true }]
}
```

**GET /api/v1/public/subscriptions?email=** - with `X-Public-Email` for scoped routes

```bash
curl -s "http://127.0.0.1:3088/api/v1/public/subscriptions?email=user@example.com" \
  -H "X-Intranet-Token: VOTRE_TOKEN" \
  -H "X-Actor-Type: public" \
  -H "X-Public-Email: user@example.com"
```

**DELETE /api/v1/public/subscriptions** - partial unsubscribe

```json
{ "deleted": 1 }
```

---

### 3. Internal actor

**POST /api/v1/iso-items** + **POST …/sources**

```bash
curl -s -X POST http://127.0.0.1:3088/api/v1/iso-items \
  -H "X-Intranet-Token: VOTRE_TOKEN" \
  -H "X-Actor-Type: internal" \
  -H "Content-Type: application/json" \
  -d '{"name":"Debian netinst","distribution":"debian","architecture":"amd64","is_public":true}'
```

**POST /api/v1/scans/run** - asynchronous scan

```json
{
  "scan_run_id": 87,
  "status": "running",
  "async": true,
  "message": "Scan accepted and running in the background"
}
```

**GET /api/v1/scans/87** - polling until `is_finished: true`

**POST /api/v1/releases/:id/download** - local download

Response if file already present:

```json
{
  "ok": true,
  "linked": true,
  "skipped_download": true,
  "local_path": "/mnt/ISO/fichier.iso",
  "file_size": 6345887744
}
```

Response if download started:

```json
{
  "ok": true,
  "accepted": true,
  "async": true,
  "status": "downloading",
  "release_id": 42,
  "message": "Download started in the background"
}
```

Tracking: `GET /api/v1/storage/status` (internal or admin).

---

### 4. Administrator actor

**GET /api/v1/admin/overview** - requires `X-Actor-Type: admin`

```json
{
  "counts": { "iso_items": 12, "releases": 340, "users": 5 },
  "recent_scans": [ … ],
  "storage": { "enabled": true, "counts": { "completed": 50 } }
}
```

**POST /api/v1/admin/release-link-check**

```json
{
  "checked": 120,
  "removed": 2,
  "removed_releases": [{ "id": 10, "reason": "http_404", "http_status": 404 }]
}
```

**POST /api/v1/users/upsert** + manage any user's subscriptions/destinations.

---

### 5. UI sessions (browser)

**POST /api/v1/admin/ui-login** (no token)

```json
{
  "ok": true,
  "ui_session": "<signed-token-12h>",
  "actor": { "username": "admin", "type": "admin" }
}
```

Then: `X-UI-Session: <ui_session>` on all API routes.

**POST /api/v1/public/ui-session** - public page operator (if `PUBLIC_UI_ACTIONS_AUTO_AUTH=true`)

```json
{
  "ok": true,
  "ui_session": "…",
  "actor": { "username": "operator", "type": "internal" }
}
```

---

### 6. Edge cases and errors

| HTTP | `error` | Context |
|------|---------|----------|
| 401 | `unauthorized` | Missing/invalid token |
| 401 | `invalid_ui_session` | Expired UI session |
| 403 | `admin_required` | Admin route with internal actor |
| 403 | `forbidden` | Public accesses another user's resource |
| 403 | `public_actions_disabled` | Scan/links without operator rights |
| 403 | `public_email_required` | Public without `X-Public-Email` |
| 400 | `discovery_regex_required` | Source with discovery but no regex |
| 400 | `email_required` | Missing email parameter |
| 404 | `*_not_found` | ISO, release, user, local file… |
| 409 | `link_check_already_running` | Duplicate link verification |
| 409 | `user_has_active_subscriptions` | Delete public user |
| 502 | `download_failed` | Download - see `message` |
| 502 | `delivery_failed` | Notification - see `message` and `channel` |
| 503 | `storage_disabled` | `STORAGE_ENABLED=false` |

Download error example:

```json
{
  "ok": false,
  "error": "download_failed",
  "message": "HTTP 404"
}
```

Notification error example:

```json
{
  "error": "delivery_failed",
  "channel": "discord_webhook",
  "message": "getaddrinfo ENOTFOUND discord.com"
}
```

---

*ISO Watcher documentation v0.2.0 - HTML version: [/docs](http://127.0.0.1:3088/docs) - see also [SECURITY.md](../SECURITY.md).*
