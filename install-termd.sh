#!/usr/bin/env bash
set -euo pipefail

# Installs the termd session daemon (github.com/joeripronk/termd) that
# wslogin-server drives in termd mode (config: termd=true). The daemon is
# spawned per session as the session user; it needs its own node_modules,
# so it installs standalone.
#
# Source resolution, in order: TERMD_SOURCE (a termd git checkout), the
# sibling checkout next to this repo, or a clone of TERMD_REPO into
# /usr/local/src/termd (kept and updated on re-runs).
#
# Override defaults with environment variables, for example:
#   APP_DIR=/opt/termd TERMD_SOURCE=~/src/termd ./install-termd.sh

APP_DIR="${APP_DIR:-/usr/local/lib/termd}"
RUN_USER="${RUN_USER:-wslogin}"
TERMD_REPO="${TERMD_REPO:-https://github.com/joeripronk/termd.git}"
TERMD_SOURCE="${TERMD_SOURCE:-}"
SCRIPT_PATH="$(readlink -f "$0")"
SOURCE_DIR="$(dirname "$SCRIPT_PATH")"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -- "$SCRIPT_PATH" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi
for cmd in npm git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required" >&2
    exit 1
  fi
done

if [[ -n "$TERMD_SOURCE" ]]; then
  if [[ ! -d "$TERMD_SOURCE/.git" ]]; then
    echo "error: TERMD_SOURCE $TERMD_SOURCE is not a git checkout" >&2
    exit 1
  fi
elif [[ -d "$SOURCE_DIR/../termd/.git" ]]; then
  TERMD_SOURCE="$(readlink -f "$SOURCE_DIR/../termd")"
else
  TERMD_SOURCE=/usr/local/src/termd
  if [[ -d "$TERMD_SOURCE/.git" ]]; then
    echo "Updating $TERMD_SOURCE"
    git -C "$TERMD_SOURCE" pull --ff-only
  else
    echo "Cloning $TERMD_REPO into $TERMD_SOURCE"
    git clone "$TERMD_REPO" "$TERMD_SOURCE"
  fi
fi

echo "Installing termd from $TERMD_SOURCE to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='*.swp' \
  --exclude='*.swo' \
  --exclude='*~' \
  "$TERMD_SOURCE/" "$APP_DIR/"
chmod 0755 "$APP_DIR/termd.js"

echo "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)

# The daemon must be able to spawn its shell as the session user: the
# wslogin-run setuid helper (built by install-wslogin.sh) is used by
# wslogin-server to start it, termd itself never needs privileges.

# Registry base for the daemon sockets, same ACL dance as the tmux socket
# base (see wslogin-server.js): the base is owned by the service user with
# the session users ACL-granted +wx, the per-user dirs below belong to
# their users and inherit the default ACL that keeps wslogin in.
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

echo "Installed. Enable in $RUN_USER's wslogin config (/etc/wslogin/config.ini):"
echo "  termd=true"
echo "  termd_command=$APP_DIR/termd.js"
echo "and restart the wslogin service."
