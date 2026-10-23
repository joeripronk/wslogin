#!/usr/bin/env bash
set -euo pipefail

# Installs playback-server.js with a separate systemd service. It shares the
# wslogin installation and node_modules, but does not start the terminal
# websocket server.
#
# Override defaults with environment variables, for example:
#   PORT=9025 CACHE_DIR=/srv/playback-cache ./install-playback.sh

APP_DIR="${APP_DIR:-/opt/wslogin}"
CONFIG_DIR="${CONFIG_DIR:-/etc/wslogin}"
CONFIG_FILE="${CONFIG_FILE:-$CONFIG_DIR/playback.ini}"
MAIN_CONFIG="${MAIN_CONFIG:-$CONFIG_DIR/config.ini}"
SERVICE="${SERVICE:-wslogin-playback}"
SERVICE_USER="${SERVICE_USER:-root}"
SERVICE_GROUP="${SERVICE_GROUP:-root}"
PORT="${PORT:-9024}"
CACHE_DIR="${CACHE_DIR:-/var/cache/wslogin-playback}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/lib/wslogin-uploads/archive}"

SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

for file in playback-server.js playback.js template.js playback.example.ini; do
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
if [[ ! -d "$APP_DIR" ]]; then
  echo "error: $APP_DIR is missing; run deploy.sh first" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"

if ! (cd "$APP_DIR" && node -e "require.resolve('@xterm/headless'); require.resolve('ini'); require.resolve('authenticate-pam')" >/dev/null 2>&1); then
  echo "error: playback dependencies are not installed in $APP_DIR; run deploy.sh first" >&2
  exit 1
fi

if [[ -z "${SESSION_DIR:-}" ]]; then
  SESSION_DIR="$(awk -F= '/^session_dir[[:space:]]*=/ {sub(/^[^=]*=[[:space:]]*/, ""); print; exit}' "$MAIN_CONFIG" 2>/dev/null || true)"
  SESSION_DIR="${SESSION_DIR%%[[:space:]]*}"
  if [[ -z "$SESSION_DIR" ]]; then
    SESSION_DIR="$APP_DIR/sessions"
  elif [[ "$SESSION_DIR" != /* ]]; then
    SESSION_DIR="$APP_DIR/$SESSION_DIR"
  fi
fi

echo "Installing playback files in $APP_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  for file in playback-server.js playback.js template.js; do
    install -o root -g root -m 0644 "$SOURCE_DIR/$file" "$APP_DIR/$file"
  done
  if [[ -d "$SOURCE_DIR/sudovideo" ]]; then
    echo "Installing sudovideo files in $APP_DIR/sudovideo"
    install -d -o root -g root -m 0755 "$APP_DIR/sudovideo"
    install -o root -g root -m 0644 "$SOURCE_DIR/sudovideo/"* "$APP_DIR/sudovideo/"
  fi
fi

echo "Preparing cache directory $CACHE_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$CACHE_DIR"

install -d -m 0755 "$CONFIG_DIR"
if [[ -f "$CONFIG_FILE" ]]; then
  echo "Keeping existing configuration $CONFIG_FILE"
else
  echo "Installing configuration $CONFIG_FILE"
  install -o root -g root -m 0640 "$SOURCE_DIR/playback.example.ini" "$CONFIG_FILE"
  sed -i \
    -e "s|^port=.*|port=$PORT|" \
    -e "s|^playback_session_dir=.*|playback_session_dir=$SESSION_DIR|" \
    -e "s|^playback_archive_dir=.*|playback_archive_dir=$ARCHIVE_DIR|" \
    -e "s|^playback_www_dir=.*|playback_www_dir=$APP_DIR/sudovideo|" \
    -e "s|^playback_cache_dir=.*|playback_cache_dir=$CACHE_DIR|" \
    "$CONFIG_FILE"
fi

if [[ ! -d "$ARCHIVE_DIR" ]]; then
  echo "warning: archive directory $ARCHIVE_DIR does not exist yet" >&2
fi

echo "Installing systemd service $SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=wslogin session playback server
Documentation=file://$APP_DIR/playback.example.ini
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_DIR
Environment=WSLOGIN_CONFIG=$CONFIG_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/playback-server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
ReadWritePaths=$CACHE_DIR

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "/etc/systemd/system/$SERVICE.service"

systemctl daemon-reload
systemctl enable "$SERVICE.service" >/dev/null 2>&1 || true
systemctl restart "$SERVICE.service"

sleep 1
if systemctl is-active --quiet "$SERVICE.service"; then
  echo "Playback installed and running as $SERVICE.service"
else
  echo "warning: $SERVICE.service is not running" >&2
  journalctl -u "$SERVICE.service" -n 20 --no-pager || true
  exit 1
fi

systemctl --no-pager --lines=0 status "$SERVICE.service" || true
echo "Configuration: $CONFIG_FILE"
echo "Cache directory: $CACHE_DIR"
echo "Archive directory: $ARCHIVE_DIR"
