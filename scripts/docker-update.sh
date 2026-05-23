#!/usr/bin/env bash
# Met à jour ISO Watcher depuis l'image registry (GHCR).
#
# Usage (répertoire contenant docker-compose.yml et .env) :
#   ./scripts/docker-update.sh
#   ./scripts/docker-update.sh -f docker-compose.mysql.yml
#
# Équivalent manuel :
#   docker compose pull && docker compose up -d --remove-orphans

set -euo pipefail

COMPOSE_FILES=(-f docker-compose.yml)

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file) COMPOSE_FILES=(-f "${2:?}"); shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if [[ ! -f .env ]]; then
  echo "Fichier .env manquant. Copiez .env.example vers .env" >&2
  exit 1
fi

# shellcheck disable=SC1091
source .env 2>/dev/null || true
IMAGE="${ISO_WATCHER_IMAGE:-ghcr.io/sannier3/iso-watcher:latest}"

echo "==> Image cible : ${IMAGE}"
echo "==> docker compose pull"
docker compose "${COMPOSE_FILES[@]}" pull iso-watcher

echo "==> docker compose up -d"
docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans

echo "==> Terminé. Santé : curl -s http://127.0.0.1:${APP_PORT:-3088}/health"
