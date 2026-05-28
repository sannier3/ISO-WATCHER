# Security - ISO Watcher

[![Français](https://img.shields.io/badge/lang-Français-lightgrey.svg)](SECURITY.md) [![English](https://img.shields.io/badge/lang-English-blue.svg)](SECURITY.en.md) [![License](https://img.shields.io/badge/License-MIT-success?style=flat-square)](../LICENSE)

This document describes known risks and best practices for deploying ISO Watcher.

## Trust model

| Mechanism | Usage | Trust level |
|-----------|--------|-------------|
| `INTRANET_SHARED_TOKEN` | API (intranet PHP, scripts, integrations) | Shared secret - **never expose to the browser** |
| Cookie `iw_ui_session` (HttpOnly) | `/` and `/admin` interfaces | Signed 12 h session, not readable by JavaScript |
| Header `X-UI-Session` (legacy) | Compatibility | Same token as the cookie - prefer the cookie |
| `X-Actor-Type` + token | Classic API clients | Actor type is **declarative**: anyone with the token can claim `admin` |

The shared token is the main API barrier. Protect it like a root password.

## Built-in protections

### Brute-force protection (login)

- Per-IP limit on `POST /api/v1/admin/ui-login` and `POST /api/v1/public/ui-session`.
- Variables: `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS`, `LOGIN_LOCKOUT_MS`.
- HTTP **429** response with `Retry-After` header when locked.

### Browser sessions (cookies)

- Cookie **`iw_ui_session`**: `HttpOnly`, `SameSite`, `Secure` (if `UI_SESSION_COOKIE_SECURE=true`).
- Token is no longer stored in `sessionStorage` / `localStorage` (reduces XSS session theft).
- `fetch` calls use `credentials: 'include'`.
- Logout: `POST /api/v1/admin/ui-logout` or `/api/v1/public/ui-logout`.

### XSS

- **Content-Security-Policy** (Helmet): scripts limited to `'self'`, no embedded objects, `frame-ancestors 'none'`.
- Systematic HTML escaping in admin and public pages (`escapeHtml`).
- No `eval` / HTML injected from the API into the DOM.

### API

- **Constant-time** comparison of `X-Intranet-Token`.
- Global **rate limiting** on `/api/v1` (`API_RATE_LIMIT_MAX` / window).
- `TRUST_PROXY=true` behind nginx for correct client IP (rate limit, private network).

## Internet exposure (nginx / Cloudflare)

Expected model:

```
HTTPS client → nginx / Cloudflare (TLS) → Node :3088 (internal HTTP)
```

nginx example (excerpt):

```nginx
location / {
  proxy_pass http://127.0.0.1:3088;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Recommended `.env` in production:

```env
TRUST_PROXY=true
UI_SESSION_COOKIE_SECURE=true
UI_SESSION_COOKIE_SAME_SITE=lax
SECURITY_HSTS_ENABLED=true
ADMIN_UI_AUTH_REQUIRED=true
ADMIN_UI_PASSWORD=<strong password>
CORS_ORIGIN=https://your-domain.example
PUBLIC_UI_ALLOW_ACTIONS=false
```

## Web interfaces

### Admin console (`/admin`)

- `ADMIN_UI_AUTH_REQUIRED=true` **required** if the service is reachable outside the LAN.
- `ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK=true` (default): login refused from public IPs (unless the proxy is misconfigured).
- Do not log login responses (still contains `ui_session` in JSON for debug - the cookie is enough).

### Public page (`/`)

- Catalogue: `GET /api/v1/releases/recent?public=true` **without authentication**.
- Actions (scan, links): `PUBLIC_UI_ALLOW_ACTIONS` + cookie or manual token.
- `PUBLIC_UI_ACTIONS_AUTO_AUTH=true`: automatic operator rights on LAN - **do not enable on the Internet**.

## Network and exposure

- Do not publish port `3088` directly on the Internet; use a TLS reverse proxy.
- `CORS_ORIGIN=*` **incompatible** with session cookies: set the exact site URL.
- Behind a reverse proxy: `TRUST_PROXY=true` and IP filtering at the proxy if needed.

## Deployment checklist

1. Long random token (`INTRANET_SHARED_TOKEN`) - e.g. [IT Tools - Token generator](https://it-tools.tech/token-generator).
2. `ADMIN_UI_AUTH_REQUIRED=true` + dedicated `ADMIN_UI_PASSWORD`.
3. `TRUST_PROXY=true` + `UI_SESSION_COOKIE_SECURE=true` behind HTTPS.
4. `PUBLIC_UI_ALLOW_ACTIONS=false` by default.
5. Firewall: Node reachable only from the proxy.
6. `npm install` after updates (`@fastify/cookie` required).

## Reporting

For a security issue, contact the repository / instance administrator (do not open a public issue with secrets).
