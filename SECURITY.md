# Sécurité — ISO Watcher

Ce document décrit les risques connus et les bonnes pratiques pour déployer ISO Watcher.

## Modèle de confiance

| Mécanisme | Usage | Niveau de confiance |
|-----------|--------|-------------------|
| `INTRANET_SHARED_TOKEN` | API (PHP intranet, scripts, intégrations) | Secret partagé — **ne jamais exposer au navigateur** |
| `X-UI-Session` | Interfaces `/` et `/admin` uniquement | Session signée 12 h, rôle inclus |
| `X-Actor-Type` + token | Clients API classiques | Le type d’acteur est **déclaratif** : quiconque possède le token peut se présenter en `admin` |

Le token partagé est la barrière principale de l’API. Protégez-le comme un mot de passe root.

## Interfaces web

### Console admin (`/admin`)

- `ADMIN_UI_AUTH_REQUIRED=true` **recommandé** dès que le service est joignable hors LAN.
- `ADMIN_UI_RESTRICT_TO_PRIVATE_NETWORK=true` (défaut) : `POST /api/v1/admin/ui-login` refuse les IP publiques.
- La réponse de login ne contient **plus** le token partagé, seulement une `ui_session` signée.
- Sans mot de passe (`ADMIN_UI_AUTH_REQUIRED=false`) : accès direct réservé à un réseau de confiance.

### Page publique (`/`)

- Catalogue : `GET /api/v1/releases/recent?public=true` **sans authentification** (releases marquées publiques).
- Actions (scan, liens) : `PUBLIC_UI_ALLOW_ACTIONS` + token ou `PUBLIC_UI_ACTIONS_AUTO_AUTH`.
- `PUBLIC_UI_ACTIONS_AUTO_AUTH=true` : équivalent à donner les droits opérateur à toute personne sur le LAN — **ne pas activer sur Internet**.

### Sessions navigateur

- Stockées en `sessionStorage` (admin) ou `localStorage` (page publique).
- Vulnérables en cas de XSS : gardez les UIs simples, pas de HTML non échappé injecté.

## Réseau et exposition

- Écoutez sur une interface interne (`APP_HOST=192.168.x.x` ou derrière un reverse proxy).
- Ne publiez pas le port `3088` sur Internet sans TLS, authentification forte et pare-feu.
- Derrière un reverse proxy : `X-Forwarded-For` peut fausser la détection réseau privé — désactivez `*_RESTRICT_TO_PRIVATE_NETWORK` ou filtrez au proxy.

## Configuration sensible

- Ne commitez jamais `.env` (token, mots de passe MySQL, SMTP).
- `GET /api/v1/config/public` n’expose plus le chemin `STORAGE_ROOT`.
- Helmet est actif mais **CSP désactivée** : à renforcer si vous ajoutez du contenu tiers.

## Checklist déploiement

1. Token long et aléatoire (`INTRANET_SHARED_TOKEN`).
2. `ADMIN_UI_AUTH_REQUIRED=true` sauf labo local.
3. `PUBLIC_UI_ALLOW_ACTIONS=false` par défaut ; activer seulement si nécessaire.
4. Ne pas activer `PUBLIC_UI_ACTIONS_AUTO_AUTH` sur un hôte public.
5. Pare-feu : accès 3088 limité au VLAN admin / intranet.
6. Sauvegardes MySQL/SQLite et répertoire `STORAGE_ROOT` hors partages larges en écriture.

## Signalement

Pour un problème de sécurité, contactez l’administrateur du dépôt / de l’instance (ne pas ouvrir d’issue publique avec des secrets).
