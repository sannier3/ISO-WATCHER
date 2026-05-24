# Sécurité - ISO Watcher

Ce document décrit les risques connus et les bonnes pratiques pour déployer ISO Watcher.

## Modèle de confiance

| Mécanisme | Usage | Niveau de confiance |
|-----------|--------|-------------------|
| `INTRANET_SHARED_TOKEN` | API (PHP intranet, scripts, intégrations) | Secret partagé - **ne jamais exposer au navigateur** |
| Cookie `iw_ui_session` (HttpOnly) | Interfaces `/` et `/admin` | Session signée 12 h, non lisible par JavaScript |
| En-tête `X-UI-Session` (legacy) | Compatibilité | Même jeton que le cookie - préférer le cookie |
| `X-Actor-Type` + token | Clients API classiques | Le type d’acteur est **déclaratif** : quiconque possède le token peut se présenter en `admin` |

Le token partagé est la barrière principale de l’API. Protégez-le comme un mot de passe root.

## Protections intégrées

### Anti brute-force (login)

- Limite par IP sur `POST /api/v1/admin/ui-login` et `POST /api/v1/public/ui-session`.
- Variables : `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS`, `LOGIN_LOCKOUT_MS`.
- Réponse HTTP **429** avec en-tête `Retry-After` si verrouillé.

### Sessions navigateur (cookies)

- Cookie **`iw_ui_session`** : `HttpOnly`, `SameSite`, `Secure` (si `UI_SESSION_COOKIE_SECURE=true`).
- Le jeton n’est plus stocké dans `sessionStorage` / `localStorage` (réduction vol de session XSS).
- Les appels `fetch` utilisent `credentials: 'include'`.
- Déconnexion : `POST /api/v1/admin/ui-logout` ou `/api/v1/public/ui-logout`.

### XSS

- **Content-Security-Policy** (Helmet) : scripts limités à `'self'`, pas d’objets embarqués, `frame-ancestors 'none'`.
- Échappement HTML systématique côté admin et page publique (`escapeHtml`).
- Pas d’`eval` / HTML injecté depuis l’API dans le DOM.

### API

- Comparaison **à temps constant** du `X-Intranet-Token`.
- **Rate limiting** global sur `/api/v1` (`API_RATE_LIMIT_MAX` / fenêtre).
- `TRUST_PROXY=true` derrière nginx pour une IP client correcte (rate limit, réseau privé).

## Exposition Internet (nginx / Cloudflare)

Modèle attendu :

```
Client HTTPS → nginx / Cloudflare (TLS) → Node :3088 (HTTP interne)
```

Exemple nginx (extrait) :

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

`.env` recommandé en prod :

```env
TRUST_PROXY=true
UI_SESSION_COOKIE_SECURE=true
UI_SESSION_COOKIE_SAME_SITE=lax
SECURITY_HSTS_ENABLED=true
ADMIN_UI_AUTH_REQUIRED=true
ADMIN_UI_PASSWORD=<mot de passe fort>
CORS_ORIGIN=https://votre-domaine.example
PUBLIC_UI_ALLOW_ACTIONS=false
```

## Interfaces web

### Console admin (`/admin`)

- `ADMIN_UI_AUTH_REQUIRED=true` **obligatoire** si le service est joignable hors LAN.
- `ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK=true` (défaut) : login refusé depuis IP publiques (sauf si proxy mal configuré).
- La réponse de login ne doit pas être loguée (contient encore `ui_session` en JSON pour debug - le cookie suffit).

### Page publique (`/`)

- Catalogue : `GET /api/v1/releases/recent?public=true` **sans authentification**.
- Actions (scan, liens) : `PUBLIC_UI_ALLOW_ACTIONS` + cookie ou token manuel.
- `PUBLIC_UI_ACTIONS_AUTO_AUTH=true` : droits opérateur automatiques sur le LAN - **ne pas activer sur Internet**.

## Réseau et exposition

- Ne publiez pas le port `3088` directement sur Internet ; passez par un reverse proxy TLS.
- `CORS_ORIGIN=*` **incompatible** avec les cookies de session : indiquez l’URL exacte du site.
- Derrière un reverse proxy : `TRUST_PROXY=true` et filtrage IP au proxy si besoin.

## Checklist déploiement

1. Token long et aléatoire (`INTRANET_SHARED_TOKEN`) - par ex. [IT Tools - Token generator](https://it-tools.tech/token-generator).
2. `ADMIN_UI_AUTH_REQUIRED=true` + `ADMIN_UI_PASSWORD` dédié.
3. `TRUST_PROXY=true` + `UI_SESSION_COOKIE_SECURE=true` derrière HTTPS.
4. `PUBLIC_UI_ALLOW_ACTIONS=false` par défaut.
5. Pare-feu : Node joignable seulement depuis le proxy.
6. `npm install` après mise à jour (`@fastify/cookie` requis).

## Signalement

Pour un problème de sécurité, contactez l’administrateur du dépôt / de l’instance (ne pas ouvrir d’issue publique avec des secrets).
