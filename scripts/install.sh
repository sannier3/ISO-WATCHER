#!/usr/bin/env bash
# ISO Watcher — installation / désinstallation (Debian / Ubuntu, systemd)
#
# Debian / Ubuntu — root direct (LXC, conteneur) :
#   curl -fsSL https://raw.githubusercontent.com/JBSAN/iso-watcher/main/scripts/install.sh | bash
#
# Avec élévation sudo si nécessaire :
#   curl -fsSL …/scripts/install.sh | sudo bash
#
# Avec MariaDB (paquet mariadb-server + base + utilisateur) :
#   curl -fsSL …/scripts/install.sh | bash -s -- --mysql
#
# Variables : ISO_WATCHER_REPO, ISO_WATCHER_BRANCH, ISO_WATCHER_INSTALL_DIR
# Options : --dir --branch --repo --mysql --no-start --uninstall --purge -h

set -euo pipefail

SERVICE_NAME="iso-watcher"
DEFAULT_REPO="JBSAN/iso-watcher"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/iso-watcher"
DEFAULT_MYSQL_DB="iso_watcher"
DEFAULT_MYSQL_USER="iso_watcher"

REPO_SLUG="${ISO_WATCHER_REPO:-$DEFAULT_REPO}"
BRANCH="${ISO_WATCHER_BRANCH:-$DEFAULT_BRANCH}"
INSTALL_DIR="${ISO_WATCHER_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_MARIADB=false
NO_START=false
UNINSTALL=false
PURGE=false

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!>\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]]
}

ensure_privileges() {
  if is_root; then
    return 0
  fi

  local script="${BASH_SOURCE[0]:-}"

  if command_exists sudo; then
    if [[ -n "$script" && -f "$script" ]]; then
      log "Élévation des privilèges via sudo…"
      exec sudo -E bash "$script" "$@"
    fi
    err "Root requis. Relancez avec : curl -fsSL …/install.sh | sudo bash"
  fi

  err "Root requis (uid 0). Pas de sudo détecté — en LXC/conteneur, connectez-vous en root et lancez : bash … (sans sudo)."
}

detect_os() {
  if [[ ! -f /etc/os-release ]]; then
    warn "Fichier /etc/os-release absent — Debian/Ubuntu supposé."
    return 0
  fi

  # shellcheck disable=SC1091
  . /etc/os-release

  case "${ID:-}" in
    debian|ubuntu|linuxmint|pop|elementary)
      log "Système détecté : ${PRETTY_NAME:-$ID}"
      ;;
    *)
      err "OS non supporté : ${PRETTY_NAME:-$ID}. Ce script cible Debian et Ubuntu uniquement."
      ;;
  esac

  if ! command_exists apt-get; then
    err "apt-get introuvable — installation impossible sur ce système."
  fi
}

need_systemd() {
  if ! command_exists systemctl; then
    err "systemd (systemctl) requis pour gérer le service ${SERVICE_NAME}."
  fi
}

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq "$@"
}

apt_update() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) INSTALL_DIR="${2:?}"; shift 2 ;;
      --branch) BRANCH="${2:?}"; shift 2 ;;
      --repo) REPO_SLUG="${2:?}"; shift 2 ;;
      --mysql) INSTALL_MARIADB=true; shift ;;
      --no-start) NO_START=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --purge) PURGE=true; shift ;;
      -h|--help) usage ;;
      *) err "Option inconnue : $1 (essayez --help)" ;;
    esac
  done
}

node_major_version() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

install_nodejs() {
  log "Paquets Node.js (git, curl, compilateurs pour better-sqlite3)…"
  apt_update
  apt_install git ca-certificates curl build-essential python3

  if ! command_exists node || [[ "$(node_major_version)" -lt 20 ]]; then
    log "Node.js 20+ requis — dépôt NodeSource…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt_install nodejs
  fi

  if ! command_exists node || [[ "$(node_major_version)" -lt 20 ]]; then
    err "Node.js 20+ introuvable après installation."
  fi

  log "Node $(node -v) · npm $(npm -v)"
}

mysql_cli() {
  if command_exists mariadb; then
    mariadb "$@"
  elif command_exists mysql; then
    mysql "$@"
  else
    err "Client mariadb/mysql introuvable après installation MariaDB."
  fi
}

env_set() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "${env_file}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${env_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${env_file}"
  fi
}

env_get() {
  local env_file="$1"
  local key="$2"
  local line

  [[ -f "${env_file}" ]] || return 1
  line="$(grep -E "^${key}=" "${env_file}" 2>/dev/null | tail -n1 || true)"
  [[ -n "${line}" ]] || return 1
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line#\"}"
  line="${line%\"}"
  printf '%s' "${line}"
}

load_mysql_credentials_from_env_file() {
  local env_file="${INSTALL_DIR}/.env"

  [[ -f "${env_file}" ]] || return 0

  MYSQL_DATABASE="$(env_get "${env_file}" MYSQL_DATABASE || echo "${MYSQL_DATABASE:-$DEFAULT_MYSQL_DB}")"
  MYSQL_USER="$(env_get "${env_file}" MYSQL_USER || echo "${MYSQL_USER:-$DEFAULT_MYSQL_USER}")"
  local file_pass
  file_pass="$(env_get "${env_file}" MYSQL_PASSWORD || true)"
  if [[ -n "${file_pass}" && "${file_pass}" != "mot-de-passe-mysql" ]]; then
    MYSQL_PASSWORD="${file_pass}"
  fi
}

install_mariadb_server() {
  log "Installation MariaDB (mariadb-server)…"
  apt_update
  apt_install mariadb-server mariadb-client

  if command_exists systemctl; then
    systemctl enable mariadb 2>/dev/null || systemctl enable mysql 2>/dev/null || true
    systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true
  fi

  local db_name="${MYSQL_DATABASE:-$DEFAULT_MYSQL_DB}"
  local db_user="${MYSQL_USER:-$DEFAULT_MYSQL_USER}"
  local db_pass="${MYSQL_PASSWORD:-}"

  if [[ -z "${db_pass}" ]]; then
    db_pass="$(generate_token | cut -c1-40)"
    log "Mot de passe MySQL généré pour l'utilisateur ${db_user}."
  fi

  log "Création base « ${db_name} » et utilisateur « ${db_user} »…"

  mysql_cli <<EOSQL
CREATE DATABASE IF NOT EXISTS \`${db_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${db_user}'@'localhost' IDENTIFIED BY '${db_pass}';
ALTER USER '${db_user}'@'localhost' IDENTIFIED BY '${db_pass}';
GRANT ALL PRIVILEGES ON \`${db_name}\`.* TO '${db_user}'@'localhost';
FLUSH PRIVILEGES;
EOSQL

  MYSQL_DATABASE="${db_name}"
  MYSQL_USER="${db_user}"
  MYSQL_PASSWORD="${db_pass}"
}

configure_env_for_mariadb() {
  local env_file="${INSTALL_DIR}/.env"

  [[ -f "${env_file}" ]] || err "Fichier .env introuvable — impossible de configurer MySQL."

  log "Configuration .env pour DB_DRIVER=mysql…"

  env_set "${env_file}" DB_DRIVER mysql
  env_set "${env_file}" MYSQL_HOST 127.0.0.1
  env_set "${env_file}" MYSQL_PORT 3306
  env_set "${env_file}" MYSQL_DATABASE "${MYSQL_DATABASE}"
  env_set "${env_file}" MYSQL_USER "${MYSQL_USER}"
  env_set "${env_file}" MYSQL_PASSWORD "${MYSQL_PASSWORD}"

  warn "Identifiants MySQL enregistrés dans ${env_file}"
}

clone_or_update_repo() {
  local url="https://github.com/${REPO_SLUG}.git"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Mise à jour du dépôt dans ${INSTALL_DIR}…"
    git -C "${INSTALL_DIR}" fetch origin "${BRANCH}" --depth 1 2>/dev/null || git -C "${INSTALL_DIR}" fetch origin
    git -C "${INSTALL_DIR}" checkout "${BRANCH}"
    git -C "${INSTALL_DIR}" pull --ff-only origin "${BRANCH}" 2>/dev/null || true
  elif [[ -f "${INSTALL_DIR}/server.js" ]]; then
    warn "${INSTALL_DIR} existe sans .git — mise à jour npm uniquement."
  else
    log "Clone ${url} (branche ${BRANCH}) → ${INSTALL_DIR}…"
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone --depth 1 --branch "${BRANCH}" "${url}" "${INSTALL_DIR}"
  fi
}

generate_token() {
  if command_exists openssl; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

setup_env_file() {
  local env_file="${INSTALL_DIR}/.env"
  local example="${INSTALL_DIR}/.env.example"

  if [[ ! -f "${example}" ]]; then
    err "Fichier .env.example manquant dans ${INSTALL_DIR}."
  fi

  if [[ ! -f "${env_file}" ]]; then
    log "Création de ${env_file} depuis .env.example…"
    cp "${example}" "${env_file}"
    local token
    token="$(generate_token)"
    if grep -q '^INTRANET_SHARED_TOKEN=change-ce-token' "${env_file}" 2>/dev/null; then
      sed -i "s/^INTRANET_SHARED_TOKEN=.*/INTRANET_SHARED_TOKEN=${token}/" "${env_file}"
      log "Token INTRANET_SHARED_TOKEN généré automatiquement."
    fi
    warn "Éditez ${env_file} (SMTP, stockage…) puis : systemctl restart ${SERVICE_NAME}"
  else
    log "Fichier .env existant conservé."
  fi

  chmod 600 "${env_file}" 2>/dev/null || true
}

setup_data_dirs() {
  mkdir -p "${INSTALL_DIR}/data/storage"

  if grep -q '^SQLITE_PATH=\./data/' "${INSTALL_DIR}/.env" 2>/dev/null \
    && ! grep -q '^DB_DRIVER=mysql' "${INSTALL_DIR}/.env" 2>/dev/null; then
    mkdir -p "${INSTALL_DIR}/data"
  fi
}

npm_install_app() {
  log "npm ci (production)…"
  cd "${INSTALL_DIR}"
  export NODE_ENV=production
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
}

extra_readwrite_paths() {
  local env_file="${INSTALL_DIR}/.env"
  local paths=()
  local key val

  [[ -f "${env_file}" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^(STORAGE_ROOT|SQLITE_PATH)= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%$'\r'}"
    val="${val#\"}"
    val="${val%\"}"

    if [[ "$val" != /* ]]; then
      val="${INSTALL_DIR}/${val#./}"
    fi

    case "$key" in
      STORAGE_ROOT)
        paths+=("$(dirname "${val}")" "${val}")
        ;;
      SQLITE_PATH)
        paths+=("$(dirname "${val}")")
        ;;
    esac
  done < "${env_file}"

  local seen="" p real
  for p in "${paths[@]}"; do
    real="$(readlink -f "${p}" 2>/dev/null || echo "${p}")"
    [[ -z "$real" || "$real" == "${INSTALL_DIR}"* ]] && continue
    [[ " $seen " == *" $real "* ]] && continue
    seen+=" ${real}"
    printf '%s\n' "${real}"
  done
}

write_systemd_unit() {
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  local node_bin
  node_bin="$(command -v node)"

  local after="network-online.target"
  local wants="network-online.target"
  if $INSTALL_MARIADB; then
    after="network-online.target mariadb.service"
    wants="network-online.target"
  fi

  local rw_paths=("${INSTALL_DIR}")
  local extra
  while IFS= read -r extra; do
    [[ -n "$extra" ]] && rw_paths+=("${extra}")
  done < <(extra_readwrite_paths)
  local rw_line
  rw_line="$(printf '%s ' "${rw_paths[@]}")"
  rw_line="${rw_line%% }"

  log "Écriture de ${unit}…"

  cat >"${unit}" <<EOF
[Unit]
Description=ISO Watcher Node.js Service
Documentation=https://github.com/${REPO_SLUG}
After=${after}
Wants=${wants}

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=NODE_ENV=production
ExecStart=${node_bin} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGINT

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${rw_line}

[Install]
WantedBy=multi-user.target
EOF
}

install_systemd_service() {
  write_systemd_unit
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"

  if $NO_START; then
    log "Service activé (démarrage ignoré : --no-start)."
  else
    systemctl restart "${SERVICE_NAME}"
    sleep 2
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      log "Service ${SERVICE_NAME} actif."
    else
      warn "Le service ne semble pas démarré — journal : journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    fi
  fi
}

do_install() {
  detect_os
  need_systemd
  install_nodejs
  clone_or_update_repo
  setup_env_file

  if $INSTALL_MARIADB; then
    load_mysql_credentials_from_env_file
    install_mariadb_server
    configure_env_for_mariadb
  fi

  setup_data_dirs
  npm_install_app
  install_systemd_service

  log "Installation terminée."
  echo ""
  echo "  Répertoire : ${INSTALL_DIR}"
  echo "  Santé      : curl -s http://127.0.0.1:\$(grep ^APP_PORT= ${INSTALL_DIR}/.env | cut -d= -f2)/health"
  echo "  Interface  : http://<hôte>:3088/  ·  Admin : /admin"
  echo "  Logs       : journalctl -u ${SERVICE_NAME} -f"
  if $INSTALL_MARIADB; then
    echo "  MySQL      : ${MYSQL_USER}@${MYSQL_DATABASE} (mot de passe dans ${INSTALL_DIR}/.env)"
  fi
  echo ""
  if is_root && ! command_exists sudo; then
    echo "  (Exécution root sans sudo — adapté LXC/conteneur.)"
    echo ""
  fi
}

do_uninstall() {
  need_systemd

  if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    log "Arrêt et désactivation de ${SERVICE_NAME}…"
    systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  fi

  if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    log "Unité systemd supprimée."
  fi

  if $PURGE; then
    if [[ -d "${INSTALL_DIR}" ]]; then
      warn "Suppression de ${INSTALL_DIR} (--purge)…"
      rm -rf "${INSTALL_DIR}"
    fi
  else
    warn "Répertoire ${INSTALL_DIR} conservé (données et .env). Utilisez --purge pour tout supprimer."
  fi

  if $INSTALL_MARIADB; then
    warn "MariaDB n'est pas désinstallé (--uninstall ne supprime que le service ISO Watcher)."
  fi

  log "Désinstallation terminée."
}

main() {
  ensure_privileges "$@"
  parse_args "$@"

  if $UNINSTALL; then
    do_uninstall
  else
    do_install
  fi
}

main "$@"
