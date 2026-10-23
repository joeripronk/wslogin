#!/usr/bin/env bash
set -euo pipefail

# Installs uploader.js on a wslogin host with a systemd service. The uploader
# shares the existing wslogin installation (and its node_modules) because it
# reads session_dir relative to that directory and needs write access to the
# session logs. Run deploy.sh first if the wslogin installation is missing.
#
# Override defaults with environment variables, for example:
#   APP_DIR=/srv/wslogin SESSION_DIR=/srv/wslogin/sessions ./install-uploader.sh

APP_DIR="${APP_DIR:-/opt/wslogin}"
CONFIG_FILE="${CONFIG_FILE:-/etc/wslogin/config.ini}"
SERVICE="${SERVICE:-wslogin-uploader}"
SERVICE_USER="${SERVICE_USER:-root}"
SERVICE_GROUP="${SERVICE_GROUP:-root}"

SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

for file in uploader.js template.js RECEIVER.md; do
  if [[ ! -f "$SOURCE_DIR/$file" ]]; then
    echo "error: $SOURCE_DIR/$file is missing" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl is required" >&2
  exit 1
fi
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "error: $CONFIG_FILE is missing; install wslogin first" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR" ]]; then
  echo "error: $APP_DIR is missing; run deploy.sh first" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"

# The uploader resolves a relative session_dir against its own directory, so
# derive the absolute path for the systemd sandbox from the same config.
if [[ -z "${SESSION_DIR:-}" ]]; then
  SESSION_DIR="$(awk -F= '/^session_dir[[:space:]]*=/ {sub(/^[^=]*=[[:space:]]*/, ""); print; exit}' "$CONFIG_FILE")"
  SESSION_DIR="${SESSION_DIR%%[[:space:]]*}"
  if [[ -z "$SESSION_DIR" ]]; then
    SESSION_DIR="$APP_DIR/sessions"
  elif [[ "$SESSION_DIR" != /* ]]; then
    SESSION_DIR="$APP_DIR/$SESSION_DIR"
  fi
fi

if ! (cd "$APP_DIR" && node -e "require.resolve('ws'); require.resolve('ini')" >/dev/null 2>&1); then
  echo "error: ws and ini are not installed in $APP_DIR; run deploy.sh first" >&2
  exit 1
fi

if ! grep -qiE '^upload_enabled[[:space:]]*=[[:space:]]*(1|true|yes|on)[[:space:]]*$' "$CONFIG_FILE"; then
  echo "warning: upload_enabled is not true in $CONFIG_FILE; the service will exit" >&2
fi

echo "Installing uploader files in $APP_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  for file in uploader.js template.js RECEIVER.md; do
    install -o root -g root -m 0644 "$SOURCE_DIR/$file" "$APP_DIR/$file"
  done
fi

echo "Ensuring session directory $SESSION_DIR exists"
install -d -m 0755 "$SESSION_DIR"
if [[ "$SERVICE_USER" != root ]]; then
  echo "warning: $SERVICE_USER must be able to rename logs in $SESSION_DIR" >&2
fi

echo "Installing systemd service $SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=wslogin session log uploader
Documentation=file://$APP_DIR/RECEIVER.md
Wants=network-online.target
After=network-online.target wslogin.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_DIR
Environment=WSLOGIN_CONFIG=$CONFIG_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/uploader.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
ReadWritePaths=$SESSION_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "/etc/systemd/system/$SERVICE.service"

systemctl daemon-reload
systemctl enable "$SERVICE.service" >/dev/null 2>&1 || true
systemctl restart "$SERVICE.service"

sleep 1
if systemctl is-active --quiet "$SERVICE.service"; then
  echo "Uploader installed and running as $SERVICE.service"
else
  echo "warning: $SERVICE.service is not running" >&2
  journalctl -u "$SERVICE.service" -n 20 --no-pager || true
  exit 1
fi

systemctl --no-pager --lines=0 status "$SERVICE.service" || true
echo "Configuration: $CONFIG_FILE"
echo "Session directory: $SESSION_DIR"
