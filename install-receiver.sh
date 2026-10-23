#!/usr/bin/env bash
set -euo pipefail

# Installs receiver.js with a systemd service. It can be run
# repeatedly to update the files and restart the service.
#
# Override defaults with environment variables, for example:
#   DATA_DIR=/srv/wslogin-uploads ./install-receiver.sh

APP_DIR="${APP_DIR:-/opt/wslogin-receiver}"
CONFIG_DIR="${CONFIG_DIR:-/etc/wslogin}"
CONFIG_FILE="${CONFIG_FILE:-$CONFIG_DIR/receiver.ini}"
DATA_DIR="${DATA_DIR:-/var/lib/wslogin-uploads}"
SSL_DIR="${SSL_DIR:-$CONFIG_DIR/ssl}"
SERVICE="${SERVICE:-wslogin-receiver}"
SERVICE_USER="${SERVICE_USER:-wslogin-upload}"

SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

for file in receiver.js ssl.js template.js receiver.ini RECEIVER.md; do
  if [[ ! -f "$SOURCE_DIR/$file" ]]; then
    echo "error: $SOURCE_DIR/$file is missing" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl is required" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"

if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Creating group $SERVICE_USER"
  groupadd --system "$SERVICE_USER"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Creating user $SERVICE_USER"
  useradd --system --gid "$SERVICE_USER" --home-dir "$DATA_DIR" \
    --no-create-home --shell "$NOLOGIN" "$SERVICE_USER"
fi

echo "Installing receiver files in $APP_DIR"
install -d -o root -g root -m 0755 "$APP_DIR"
for file in receiver.js ssl.js template.js RECEIVER.md; do
  install -o root -g root -m 0644 "$SOURCE_DIR/$file" "$APP_DIR/$file"
done

# The receiver only needs ini and ws; do not pull in node-pty and the rest of
# the terminal dependencies.
cat > "$APP_DIR/package.json" <<'JSON'
{
  "private": true,
  "dependencies": {
    "ini": "^6.0.0",
    "ws": "^8.22.0"
  }
}
JSON
echo "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)

echo "Preparing data and configuration directories"
install -d -m 0755 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$SSL_DIR"

if [[ -f "$CONFIG_FILE" ]]; then
  echo "Keeping existing configuration $CONFIG_FILE"
else
  echo "Installing configuration $CONFIG_FILE"
  install -o root -g root -m 0640 "$SOURCE_DIR/receiver.ini" "$CONFIG_FILE"
  sed -i "s|^receiver_data_dir=.*|receiver_data_dir=$DATA_DIR|" \
    "$CONFIG_FILE"
  chown "root:$SERVICE_USER" "$CONFIG_FILE"
fi

echo "Installing systemd service $SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=wslogin session upload receiver
Documentation=file://$APP_DIR/RECEIVER.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=WSLOGIN_CONFIG=$CONFIG_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/receiver.js
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=true
ReadWritePaths=$DATA_DIR $SSL_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "/etc/systemd/system/$SERVICE.service"

systemctl daemon-reload
systemctl enable "$SERVICE.service" >/dev/null 2>&1 || true
systemctl restart "$SERVICE.service"

sleep 1
if systemctl is-active --quiet "$SERVICE.service"; then
  echo "Receiver installed and running as $SERVICE.service"
else
  echo "warning: $SERVICE.service is not running" >&2
  journalctl -u "$SERVICE.service" -n 20 --no-pager || true
  exit 1
fi

systemctl --no-pager --lines=0 status "$SERVICE.service" || true
echo "Configuration: $CONFIG_FILE"
echo "Data directory: $DATA_DIR"
