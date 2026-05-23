# API ISO Watcher — Référence complète

**Version API** : `0.2.0`  
**Base URL** : `http://<hôte>:<port>` (défaut `http://127.0.0.1:3088`)

Toutes les routes JSON renvoient `Content-Type: application/json` sauf mention contraire.

---

## Table des matières

1. [Authentification](#authentification)
2. [Format des erreurs](#format-des-erreurs)
3. [Système et santé](#système-et-santé)
4. [Configuration et interfaces web](#configuration-et-interfaces-web)
5. [Administration](#administration)
6. [Utilisateurs](#utilisateurs)
7. [ISO (iso_items)](#iso-iso_items)
8. [Sources (iso_sources)](#sources-iso_sources)
9. [Releases et stockage local](#releases-et-stockage-local)
10. [Scans](#scans)
11. [Vérification des liens](#vérification-des-liens)
12. [Destinations](#destinations)
13. [Abonnements](#abonnements)
14. [Notifications](#notifications)
15. [Modèles et énumérations](#modèles-et-énumérations)
16. [Exemples complets](#exemples-complets-dappels-api)
    - [Public sans auth](#1-public-sans-authentification)
    - [Utilisateur public](#2-utilisateur-public)
    - [Acteur interne](#3-acteur-interne)
    - [Administrateur](#4-acteur-administrateur)
    - [Sessions UI](#5-sessions-ui-navigateur)
    - [Cas particuliers](#6-cas-particuliers-et-erreurs)

---

## Authentification

### En-têtes

| En-tête | Obligatoire | Description |
|---------|-------------|-------------|
| `X-Intranet-Token` | Oui* | Token partagé (`INTRANET_SHARED_TOKEN`) pour l’API machine-à-machine |
| `X-UI-Session` | Alternative | Session signée émise par `ui-login` / `ui-session` (interfaces web) |
| `X-Actor-Username` | Non | Identifiant pour l’audit (défaut : `system`) |
| `X-Actor-Type` | Non | `internal`, `admin`, `public` (défaut : `internal`) |
| `X-Public-Email` | Conditionnel | E-mail de l’utilisateur public (routes « propres » à un compte public) |

\* Sauf routes listées comme **sans auth** ci-dessous.

### Types d’acteur

| Type | Usage |
|------|--------|
| `internal` | Intranet, scripts, opérateurs |
| `admin` | Console `/admin`, routes `admin/*` |
| `public` | Portail public (catalogue, abonnements par e-mail) |

> **Attention** : avec `X-Intranet-Token`, le type d’acteur est **déclaratif**. Protégez le token ; utilisez `X-UI-Session` pour les navigateurs.

### Routes sans authentification

| Route | Méthode |
|-------|---------|
| `/health`, `/ready`, `/version` | GET |
| `/`, `/ui/*`, `/docs`, `/admin/*` | GET (fichiers statiques) |
| `/api/v1/admin/ui-config` | GET |
| `/api/v1/admin/ui-login` | POST |
| `/api/v1/public/ui-config` | GET |
| `/api/v1/public/ui-session` | POST |
| `/api/v1/releases/recent?public=true` | GET |

### Accès restreint au réseau privé

`POST /api/v1/admin/ui-login` et `POST /api/v1/public/ui-session` peuvent être limités aux IP privées (`ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK`, `PUBLIC_UI_RESTRICT_TO_PRIVATE_NETWORK`).

---

## Format des erreurs

```json
{
  "error": "unauthorized",
  "message": "Description optionnelle"
}
```

### Codes HTTP et `error` courants

| HTTP | `error` | Signification |
|------|---------|---------------|
| 400 | `email_required`, `discovery_regex_required`, `invalid_release_id`, … | Requête invalide |
| 401 | `unauthorized`, `invalid_credentials`, `invalid_ui_session` | Authentification |
| 403 | `admin_required`, `forbidden`, `public_actions_disabled`, `private_network_required` | Droits insuffisants |
| 404 | `*_not_found` | Ressource absente |
| 409 | `link_check_already_running`, `user_has_active_subscriptions` | Conflit |
| 502 | `delivery_failed` | Échec envoi notification |
| 503 | `storage_disabled`, `admin_ui_disabled` | Service indisponible |

---

## Système et santé

### `GET /health`

**Auth** : non

Vérification de vivacité + stockage (sans exposer le chemin du répertoire).

**Réponse 200**

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

| Champ `storage` | Description |
|-----------------|-------------|
| `enabled` | `STORAGE_ENABLED` |
| `reachable` | Dossier existant ou créable |
| `readable` | Lecture / listage OK |
| `writable` | Test d’écriture + suppression d’un fichier sonde |
| `ok` | `true` si stockage désactivé ou les trois checks OK |
| `error` | `storage_unreachable`, `storage_not_readable`, `storage_not_writable`, … |

`ok` global est `false` si le stockage est activé mais `storage.ok` est `false`.

---

### `GET /ready`

**Auth** : non

Vérifie la connexion à la base de données.

**Réponse 200**

```json
{
  "ok": true,
  "db_driver": "sqlite",
  "version": "0.2.0"
}
```

**Réponse 503** : base inaccessible.

---

### `GET /version`

**Auth** : non

```json
{
  "version": "0.2.0",
  "db_driver": "sqlite"
}
```

---

## Configuration et interfaces web

### `GET /api/v1/config/public`

**Auth** : oui (token ou session UI)

Configuration non sensible (pas de chemins disque).

**Réponse 200**

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

**Auth** : non

Paramètres pour la page publique `/`.

**Réponse 200**

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

**Auth** : non (conditions ci-dessous)

Obtient une session opérateur pour la page publique.

**Conditions** : `PUBLIC_UI_ALLOW_ACTIONS=true`, `PUBLIC_UI_ACTIONS_AUTO_AUTH=true`, réseau privé si restriction activée.

**Corps** : vide ou `{}`

**Réponse 200**

```json
{
  "ok": true,
  "ui_session": "<token-signé>",
  "actor": { "username": "operator", "type": "internal" }
}
```

**Erreurs** : `public_actions_disabled`, `auto_auth_disabled`, `private_network_required`

---

### `GET /api/v1/admin/ui-config`

**Auth** : non

**Réponse 200**

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

**Auth** : non

Connexion console `/admin`.

**Corps JSON**

| Champ | Type | Description |
|-------|------|-------------|
| `password` | string | Mot de passe si `ADMIN_UI_AUTH_REQUIRED=true` |

**Réponse 200**

```json
{
  "ok": true,
  "ui_session": "<token-signé>",
  "actor": { "username": "admin", "type": "admin" }
}
```

**Erreurs** : `invalid_credentials`, `admin_ui_disabled`, `private_network_required`

---

## Administration

### `GET /api/v1/admin/overview`

**Auth** : oui — **`X-Actor-Type: admin`** (ou session UI admin)

Tableau de bord.

**Réponse 200**

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

**Auth** : admin

**Query**

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `limit` | `100` | 1–500 |

**Réponse 200** : tableau d’utilisateurs (`id`, `user_type`, `username`, `email`, `display_name`, `external_ref`, `created_at`).

---

### `POST /api/v1/admin/release-link-check`

**Auth** : `admin` **ou** `internal` si `PUBLIC_UI_ALLOW_ACTIONS=true`

Vérifie les URLs des releases ; supprime celles dont le lien est définitivement mort.

**Corps JSON**

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `send_admin_report` | boolean | `true` | Envoyer le rapport e-mail admin |
| `report_hours` | number | `24` | Fenêtre « nouvelles releases » du rapport (1–168) |

**Réponse 200**

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

**Erreurs** : `link_check_already_running`, `admin_or_operator_required`

---

## Utilisateurs

### `POST /api/v1/users/upsert`

**Auth** : oui

Crée ou met à jour un utilisateur (clé : `user_type` + `email` / `external_ref` / `username`).

**Corps JSON**

| Champ | Type | Description |
|-------|------|-------------|
| `user_type` | string | `internal` (défaut), `public` |
| `email` | string | E-mail normalisé |
| `username` | string | Optionnel |
| `external_ref` | string | Référence externe |
| `display_name` | string | Nom affiché |

**Réponse 200** : objet `users` complet.

---

### `GET /api/v1/users/:userId`

**Auth** : oui

**Réponse 200** : utilisateur ou **404** `user_not_found`.

---

### `GET /api/v1/public/users/by-email`

**Auth** : oui (souvent acteur `public`)

**Query** : `email` (obligatoire)

**Réponse 200** : utilisateur `user_type=public` ou **404**.

---

### `DELETE /api/v1/public/users/by-email`

**Auth** : oui

**Query** : `email`

**Réponse 200**

```json
{ "deleted": true }
```

ou `{ "deleted": false, "reason": "not_found" }`

**409** `user_has_active_subscriptions` si des abonnements actifs existent.

---

## ISO (iso_items)

### `GET /api/v1/iso-items`

**Auth** : oui

**Query**

| Paramètre | Description |
|-----------|-------------|
| `distribution` | Filtre distribution |
| `architecture` | Filtre architecture |
| `enabled` | `true` / `false` |
| `public` | Filtre `is_public` |

**Réponse 200** : tableau de `iso_items`.

---

### `POST /api/v1/iso-items`

**Auth** : oui

**Corps JSON**

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `name` | string | **requis** | Nom de l’ISO |
| `system_family` | string | null | ex. `linux` |
| `distribution` | string | null | ex. `ubuntu` |
| `edition` | string | null | |
| `version_track` | string | null | |
| `architecture` | string | `amd64` | |
| `file_type` | string | `iso` | |
| `description` | string | null | |
| `enabled` | boolean | `true` | |
| `is_public` | boolean | `true` | Visible catalogue public |
| `created_by_user_id` | number | null | |

**Réponse 200** : ISO créé.

---

### `GET /api/v1/iso-items/:isoItemId`

**Auth** : oui — **Réponse** : ISO ou **404** `iso_item_not_found`.

---

### `PATCH /api/v1/iso-items/:isoItemId`

**Auth** : oui

Champs modifiables : `name`, `system_family`, `distribution`, `edition`, `version_track`, `architecture`, `file_type`, `description`, `enabled`, `is_public`.

**Réponse 200** : ISO mis à jour.

---

### `POST /api/v1/iso-items/:isoItemId/enable`

### `POST /api/v1/iso-items/:isoItemId/disable`

**Auth** : oui — **Réponse** : `{ "enabled": true|false }` (selon implémentation `setIsoItemEnabled`).

---

### `DELETE /api/v1/iso-items/:isoItemId`

**Auth** : oui — **Réponse** : `{ "deleted": true }`.

---

## Sources (iso_sources)

### `GET /api/v1/iso-items/:isoItemId/sources`

**Auth** : oui — **Réponse** : tableau de sources triées par `priority`.

---

### `POST /api/v1/iso-items/:isoItemId/sources`

**Auth** : oui

**Corps JSON**

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `name` | string | **requis** | Libellé |
| `url` | string | **requis** | URL HTTP(S) ou FTP |
| `protocol` | string | auto | `http`, `https`, `ftp` (déduit de l’URL) |
| `allow_insecure_tls` | boolean | `false` | |
| `ftp_passive` | boolean | `true` | |
| `match_regex` | string | **requis** | Filtre fichiers ISO |
| `version_regex` | string | null | Extraction version |
| `checksum_regex` | string | null | |
| `discovery_enabled` | boolean | `false` | Exploration récursive |
| `discovery_depth` | number | `1` | 1–6 |
| `discovery_regex` | string | si discovery | Regex sous-dossiers |
| `priority` | number | `100` | Plus petit = prioritaire |
| `enabled` | boolean | `true` | |

**Erreurs** : `discovery_regex_required`, regex invalide.

**Réponse 200** : source créée.

---

### `PATCH /api/v1/sources/:sourceId`

**Auth** : oui — mêmes champs que création (partiels).

---

### `POST /api/v1/sources/:sourceId/test`

**Auth** : oui

Teste la source sans persister de release.

**Réponse 200**

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

**Auth** : oui

**Corps JSON**

| Champ | Type | Défaut |
|-------|------|--------|
| `notify` | boolean | `true` |
| `triggered_by_user_id` | number | null |

**Réponse 200** : voir [Scans asynchrones](#scans-asynchrones).

---

### `POST /api/v1/sources/:sourceId/enable` / `disable`

### `DELETE /api/v1/sources/:sourceId`

**Auth** : oui.

---

### `GET /api/v1/iso-items/:isoItemId/latest`

**Auth** : oui — Dernière release `is_latest=true` ou **404** `release_not_found`.

---

### `GET /api/v1/iso-items/:isoItemId/releases`

**Auth** : oui

**Query** : `limit` (défaut `100`, max `500`).

---

### `GET /api/v1/iso-items/:isoItemId/download`

**Auth** : oui

Métadonnées de téléchargement de la **dernière** release (URL distante, pas le fichier local).

**Réponse 200**

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

## Releases et stockage local

### `GET /api/v1/releases/recent`

**Auth** : oui — **sauf** `?public=true` (sans token, acteur `public`)

**Query**

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `limit` | `50` | 1–500 |
| `public` | — | `true` = ISO publiques uniquement |
| `enabled` | — | `true` / `false` sur `iso_items` |
| `latest` | — | `true` = `is_latest` |
| `distribution` | — | Filtre |
| `architecture` | — | Filtre |

**Réponse 200** : tableau de releases avec jointure `iso_name`, `distribution`, `architecture`, `edition`.

Champs release notables : `id`, `iso_item_id`, `source_id`, `version`, `filename`, `url`, `file_size`, `checksum_url`, `checksum_sha256`, `detected_at`, `is_latest`, `download_status`, `local_path`, `local_downloaded_at`.

---

### `POST /api/v1/releases/:releaseId/download`

**Auth** : oui

Déclenche le téléchargement local (`STORAGE_ENABLED=true`).

**Réponse 200**

```json
{
  "ok": true,
  "release_id": 42,
  "local_path": "/chemin/interne/non-exposé-par-cette-doc.iso",
  "linked_existing": false
}
```

**Erreurs** : `storage_disabled`, `release_not_found`, échec réseau **502**.

---

### `GET /api/v1/releases/:releaseId/local-file`

**Auth** : oui

**Réponse** : flux binaire `application/octet-stream` (fichier local).

**Erreurs** : `local_file_not_found`, `local_file_missing`.

---

### `GET /api/v1/storage/status`

**Auth** : `admin` ou `internal`

État du stockage, file d’attente, releases suivies.

**Réponse 200**

```json
{
  "enabled": true,
  "use_subfolders": true,
  "root": "/chemin/configuré",
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

### Scans asynchrones

`POST /scans/run`, `POST /sources/:id/scan`, `POST /iso-items/:id/scan` lancent un scan en arrière-plan.

**Réponse 200 immédiate**

```json
{
  "scan_run_id": 15,
  "status": "running",
  "async": true,
  "message": "Scan accepté et exécuté en arrière-plan"
}
```

Interroger `GET /api/v1/scans/:scanRunId` jusqu’à `is_finished: true`.

---

### `POST /api/v1/scans/run`

**Auth** : oui — `internal`/`admin` ; ou opérateur si `PUBLIC_UI_ALLOW_ACTIONS=true`

Scan global de toutes les sources actives.

**Corps JSON**

| Champ | Type | Défaut |
|-------|------|--------|
| `notify` | boolean | `true` |
| `triggered_by_user_id` | number | null |

**403** `public_actions_disabled` si actions publiques désactivées et acteur non admin.

---

### `POST /api/v1/iso-items/:isoItemId/scan`

**Auth** : oui — scan des sources d’un ISO.

**Corps** : identique à `scans/run`.

---

### `POST /api/v1/scans/test`

**Auth** : oui

Test une source + option notification test.

**Corps JSON**

| Champ | Type | Description |
|-------|------|-------------|
| `source_id` | number | **requis** |
| `send_test_notification` | boolean | Optionnel |
| `destination_id` | number | Si envoi test |

**Réponse 200** : résultat `testSource` (+ envoi si demandé).

---

### `GET /api/v1/scans`

**Auth** : oui

**Query** : `limit` (défaut `100`).

**Réponse 200** : liste avec champs calculés `is_finished`, `progress_percent`.

Statuts `scan_runs.status` : `running`, `success`, `error`, `partial_error`.

---

### `GET /api/v1/scans/:scanRunId`

**Auth** : oui

**Query**

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `log_limit` | `SCAN_LOG_API_DEFAULT_LIMIT` (défaut 2000) | Plafond `SCAN_LOG_API_MAX_LIMIT` (0 = jusqu'à 100000) |
| `log_since_id` | `0` | Logs après cet ID |

**Réponse 200**

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

**Auth** : oui

**Query** : `limit`, `since_id`

**Réponse 200**

```json
{
  "scan_run_id": 15,
  "is_finished": false,
  "status": "running",
  "logs": [ ]
}
```

---

## Vérification des liens

Voir [`POST /api/v1/admin/release-link-check`](#post-apiv1adminrelease-link-check).

Planifiée via `LINK_CHECK_CRON` si `LINK_CHECK_ENABLED=true`.

---

## Destinations

### `GET /api/v1/destination-types`

**Auth** : oui

**Réponse 200**

```json
[
  { "type": "email", "name": "Email HTML", "supports_grouping": true },
  { "type": "discord_webhook", "name": "Discord Webhook", "supports_embeds": true, "supports_grouping": true },
  { "type": "teams_webhook", "name": "Microsoft Teams Workflow Webhook", "supports_adaptive_cards": true, "supports_grouping": true },
  { "type": "generic_webhook", "name": "Webhook générique JSON", "supports_grouping": true }
]
```

---

### `GET /api/v1/users/:userId/destinations`

**Auth** : oui — acteur `public` : en-tête `X-Public-Email` + même `userId`.

---

### `POST /api/v1/users/:userId/destinations`

**Corps JSON**

| Champ | Type | Description |
|-------|------|-------------|
| `destination_type` | string | `email`, `discord_webhook`, `teams_webhook`, `generic_webhook` |
| `label` | string | Optionnel |
| `target` | string | E-mail ou URL webhook |
| `enabled` | boolean | défaut `true` |
| `config` | object | Options canal (JSON) |

---

### `PATCH /api/v1/destinations/:destinationId`

Champs : `destination_type`, `label`, `target`, `enabled`, `config`.

---

### `POST /api/v1/destinations/:destinationId/test`

**Auth** : oui (+ propriété si `public`)

**Corps** : `{ "message": "Texte optionnel" }`

**Réponse 200** : `{ "sent": true, "channel": "discord_webhook" }`

---

### `POST /api/v1/destinations/:destinationId/enable` / `disable`

### `DELETE /api/v1/destinations/:destinationId`

---

## Abonnements

### `GET /api/v1/users/:userId/subscriptions`

**Auth** : oui — liste avec infos ISO jointes.

---

### `GET /api/v1/public/subscriptions?email=`

**Auth** : oui — **400** si e-mail manquant ; `[]` si utilisateur inconnu.

---

### `POST /api/v1/users/:userId/subscriptions`

**Corps JSON**

| Champ | Type | Défaut |
|-------|------|--------|
| `iso_item_id` | number | **requis** |
| `notify_mode` | string | `immediate` |
| `enabled` | boolean | `true` |

Modes : `immediate`, `hourly_digest`, `daily_digest`.

---

### `POST /api/v1/public/subscriptions`

Création compte public + abonnements + destinations en une requête.

**Corps JSON**

| Champ | Type | Description |
|-------|------|-------------|
| `email` | string | **requis** |
| `display_name` | string | Optionnel |
| `iso_item_ids` | number[] | ISO à suivre |
| `notify_mode` | string | défaut `immediate` |
| `destinations` | array | `{ destination_type, label, target, config }` |

**Réponse 200**

```json
{
  "user": { "id": 1, "email": "user@example.com", "user_type": "public" },
  "subscriptions": [ ],
  "destinations": [ ]
}
```

---

### `PATCH /api/v1/subscriptions/:subscriptionId`

Champs : `enabled`, `notify_mode`.

---

### `DELETE /api/v1/subscriptions/:subscriptionId`

**Réponse** : `{ "deleted": true }`.

---

### `DELETE /api/v1/public/subscriptions`

**Corps JSON**

| Champ | Type |
|-------|------|
| `email` | string |
| `iso_item_ids` | number[] |

**Réponse** : `{ "deleted": <nombre> }`.

---

## Notifications

### `GET /api/v1/notifications/events`

**Auth** : oui

**Query** : `limit` (défaut `100`).

---

### `GET /api/v1/notifications/events/:eventId`

**Auth** : oui — détail ou **404** `event_not_found`.

---

### `GET /api/v1/notifications/deliveries`

**Auth** : oui

**Query**

| Paramètre | Description |
|-----------|-------------|
| `status` | `pending`, `sent`, `failed`, … |
| `destination_id` | Filtre |

Max 500 lignes.

---

### `POST /api/v1/notifications/deliveries/:deliveryId/retry`

**Auth** : oui — remet en `pending` et relance l’envoi.

---

### `POST /api/v1/notifications/test`

**Auth** : oui (admin/intranet)

**Corps JSON**

| Champ | Type |
|-------|------|
| `destination_id` | number **requis** |
| `iso_item_id` | number optionnel |
| `include_fake_release` | boolean (non utilisé directement) |

---

### `POST /api/v1/notifications/preview`

**Auth** : oui

Aperçu HTML / payload sans envoi.

**Corps JSON**

| Champ | Type |
|-------|------|
| `destination_type` | string (défaut `email`) |
| `release_ids` | number[] |

**Réponse 200** : structure d’aperçu selon le canal.

---

## Modèles et énumérations

### `download_status` (releases)

| Valeur | Description |
|--------|-------------|
| `none` | Pas de copie locale |
| `downloading` | Téléchargement en cours |
| `completed` | Fichier local OK |
| `failed` | Échec |
| `replaced` | Ancien fichier remplacé |

### `user_type`

`internal`, `public`

### `notify_mode`

`immediate`, `hourly_digest`, `daily_digest`

### `scan_runs.trigger_type`

`manual`, `scheduled`, …

### `destination.config` (exemples)

**Discord** : `{ "username": "ISO Watcher", "avatar_url": "..." }`  
**Email** : options de regroupement selon implémentation.

---

## Exemples complets d'appels API

Base : `http://<hôte>:3088` — remplacez `VOTRE_TOKEN` par `INTRANET_SHARED_TOKEN`.

### Matrice des acteurs

| Acteur | En-têtes | Usage |
|--------|----------|--------|
| **Aucun** | — | `/health`, `/ready`, catalogue `?public=true` |
| **public** | Token + `X-Actor-Type: public` + `X-Public-Email` | Portail : ses abonnements/destinations uniquement |
| **internal** | Token + `X-Actor-Type: internal` | Intranet, scripts, opérateur |
| **admin** | Token + `X-Actor-Type: admin` ou `X-UI-Session` | Console `/admin`, routes `/admin/*` |

---

### 1. Public (sans authentification)

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

**GET /api/v1/releases/recent?public=true&enabled=true&limit=5** (sans token)

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

### 2. Utilisateur public

**POST /api/v1/public/subscriptions** — inscription complète

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

**GET /api/v1/public/subscriptions?email=** — avec `X-Public-Email` pour les routes « propres »

```bash
curl -s "http://127.0.0.1:3088/api/v1/public/subscriptions?email=user@example.com" \
  -H "X-Intranet-Token: VOTRE_TOKEN" \
  -H "X-Actor-Type: public" \
  -H "X-Public-Email: user@example.com"
```

**DELETE /api/v1/public/subscriptions** — désabonnement partiel

```json
{ "deleted": 1 }
```

---

### 3. Acteur interne

**POST /api/v1/iso-items** + **POST …/sources**

```bash
curl -s -X POST http://127.0.0.1:3088/api/v1/iso-items \
  -H "X-Intranet-Token: VOTRE_TOKEN" \
  -H "X-Actor-Type: internal" \
  -H "Content-Type: application/json" \
  -d '{"name":"Debian netinst","distribution":"debian","architecture":"amd64","is_public":true}'
```

**POST /api/v1/scans/run** — scan asynchrone

```json
{
  "scan_run_id": 87,
  "status": "running",
  "async": true,
  "message": "Scan accepté et exécuté en arrière-plan"
}
```

**GET /api/v1/scans/87** — polling jusqu'à `is_finished: true`

**POST /api/v1/releases/:id/download** — téléchargement local

Réponse si fichier déjà présent :

```json
{
  "ok": true,
  "linked": true,
  "skipped_download": true,
  "local_path": "/mnt/ISO/fichier.iso",
  "file_size": 6345887744
}
```

Réponse si téléchargement démarré :

```json
{
  "ok": true,
  "accepted": true,
  "async": true,
  "status": "downloading",
  "release_id": 42,
  "message": "Téléchargement démarré en arrière-plan"
}
```

Suivi : `GET /api/v1/storage/status` (internal ou admin).

---

### 4. Acteur administrateur

**GET /api/v1/admin/overview** — requiert `X-Actor-Type: admin`

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

**POST /api/v1/users/upsert** + gestion abonnements/destinations de tout utilisateur.

---

### 5. Sessions UI (navigateur)

**POST /api/v1/admin/ui-login** (sans token)

```json
{
  "ok": true,
  "ui_session": "<token-signé-12h>",
  "actor": { "username": "admin", "type": "admin" }
}
```

Puis : `X-UI-Session: <ui_session>` sur toutes les routes API.

**POST /api/v1/public/ui-session** — opérateur page publique (si `PUBLIC_UI_ACTIONS_AUTO_AUTH=true`)

```json
{
  "ok": true,
  "ui_session": "…",
  "actor": { "username": "operator", "type": "internal" }
}
```

---

### 6. Cas particuliers et erreurs

| HTTP | `error` | Contexte |
|------|---------|----------|
| 401 | `unauthorized` | Token manquant/invalide |
| 401 | `invalid_ui_session` | Session UI expirée |
| 403 | `admin_required` | Route admin avec acteur internal |
| 403 | `forbidden` | Public accède à une ressource d'un autre user |
| 403 | `public_actions_disabled` | Scan/liens sans droit opérateur |
| 403 | `public_email_required` | Public sans `X-Public-Email` |
| 400 | `discovery_regex_required` | Source avec découverte sans regex |
| 400 | `email_required` | Paramètre e-mail manquant |
| 404 | `*_not_found` | ISO, release, user, fichier local… |
| 409 | `link_check_already_running` | Double vérification liens |
| 409 | `user_has_active_subscriptions` | Suppression user public |
| 502 | `download_failed` | Téléchargement — voir `message` |
| 502 | `delivery_failed` | Notification — voir `message` et `channel` |
| 503 | `storage_disabled` | `STORAGE_ENABLED=false` |

Exemple erreur téléchargement :

```json
{
  "ok": false,
  "error": "download_failed",
  "message": "HTTP 404"
}
```

Exemple erreur notification :

```json
{
  "error": "delivery_failed",
  "channel": "discord_webhook",
  "message": "getaddrinfo ENOTFOUND discord.com"
}
```

---

*Documentation ISO Watcher v0.2.0 — version HTML : [/docs](http://127.0.0.1:3088/docs) — voir aussi [SECURITY.md](../SECURITY.md).*
