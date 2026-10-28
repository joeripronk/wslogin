#!/usr/bin/env bash
set -euo pipefail

# Installs the termd session daemon (termd/ in this repo) system-wide
# under /usr/local: the daemon code goes to /usr/local/lib/termd with
# its own node_modules (it runs standalone, as the session user, and
# the CLI must work without the wslogin app dir), and the command
# `termd` is symlinked into /usr/local/bin so users can attach to their
# sessions from the shell.
#
# wslogin-server does not need this install: it spawns the bundled
# termd/termd.js from the app dir by default. Point termd_command at
# /usr/local/lib/termd/termd.js to share one version between wslogin
# and the CLI.
#
# Override defaults with environment variables, for example:
#   APP_DIR=/opt/termd ./install-termd.sh

APP_DIR="${APP_DIR:-/usr/local/lib/termd}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
RUN_USER="${RUN_USER:-wslogin}"
SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"
TERMD_SOURCE="$SOURCE_DIR/termd"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

if [[ ! -f "$TERMD_SOURCE/termd.js" ]]; then
  echo "error: $TERMD_SOURCE not found (termd is bundled in this repo)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required" >&2
  exit 1
fi

echo "Installing termd from $TERMD_SOURCE to $APP_DIR"
mkdir -p "$APP_DIR"
install -m 0755 "$TERMD_SOURCE/termd.js" "$APP_DIR/termd.js"
install -m 0644 "$TERMD_SOURCE/package.json" "$APP_DIR/package.json"

echo "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)

echo "Installing termd command in $BIN_DIR"
ln -sf "$APP_DIR/termd.js" "$BIN_DIR/termd"

# Registry base for the daemon sockets: the base is owned by the service
# user with the session users ACL-granted wx, the per-user dirs below
# belong to their users and inherit the default ACL that keeps wslogin in.
if id -u "$RUN_USER" >/dev/null 2>&1; then
  RUN_GROUP="$(id -gn "$RUN_USER")"
  mkdir -p /run/wslogin/termd
  chown "$RUN_USER":"$RUN_GROUP" /run/wslogin /run/wslogin/termd
  chmod 755 /run/wslogin /run/wslogin/termd
  if command -v setfacl >/dev/null 2>&1; then
    setfacl -d -m "u:$RUN_USER:rwx" -d -m 'm::rwx' /run/wslogin/termd
  else
    echo "warning: setfacl not installed, wslogin cannot reach the daemon sockets" >&2
  fi
else
  echo "warning: user $RUN_USER not found, create it (install-wslogin.sh) before enabling termd mode" >&2
fi

echo "Installed: $APP_DIR/termd.js, $BIN_DIR/termd"
echo "wslogin uses the bundled termd/termd.js by default; to share this"
echo "install, set in the wslogin config (/etc/wslogin/config.ini):"
echo "  termd_command=$APP_DIR/termd.js"
echo "and restart the wslogin service."
