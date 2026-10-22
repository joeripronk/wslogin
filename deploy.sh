#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wslogin}"
SERVICE="${SERVICE:-wslogin}"
SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  echo "error: $SOURCE_DIR is not a git checkout" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "error: rsync is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required" >&2
  exit 1
fi

echo "Deploying $SOURCE_DIR to $APP_DIR"
mkdir -p "$APP_DIR"

if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --chown=root:root \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='sessions/' \
    --exclude='cookies/' \
    --exclude='*.key' \
    --exclude='*.crt' \
    --exclude='*.cert' \
    --exclude='*.pem' \
    --exclude='*.ini' \
    --exclude='*.swp' \
    --exclude='*.swo' \
    --exclude='*~' \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

echo "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)

if systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
  echo "Restarting ${SERVICE}.service"
  systemctl daemon-reload
  systemctl restart "${SERVICE}.service"
  systemctl --no-pager --lines=0 status "${SERVICE}.service"
else
  echo "warning: ${SERVICE}.service is not installed; not restarting" >&2
fi

echo "Deployment complete"
