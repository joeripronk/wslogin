#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wslogin}"
SERVICE="${SERVICE:-wslogin}"
RUN_USER="${RUN_USER:-wslogin}"
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

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "Creating system user $RUN_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi

RUN_GROUP="$(id -gn "$RUN_USER")"

# tmux socket base directory; tmux sockets for live sessions live in
# per-user subdirectories of it (see session_tmux_path in server.js)
if [[ -d /run/wslogin ]]; then
  chown "$RUN_USER":"$RUN_GROUP" /run/wslogin
  chmod 755 /run/wslogin
else
  mkdir -p "/run/wslogin"
  chown "$RUN_USER":"$RUN_GROUP" "/run/wslogin"
  chmod 755 "/run/wslogin"
fi
if ! grep -qsw /run/wslogin /etc/tmpfiles.d/wslogin.conf 2>/dev/null; then
  echo "Installing /etc/tmpfiles.d/wslogin.conf"
  printf 'd /run/wslogin 0755 %s %s\n' "$RUN_USER" "$RUN_GROUP" > /etc/tmpfiles.d/wslogin.conf
fi
# the server creates the per-user socket dirs below this base; create the
# base itself here so a fresh install does not fail on the chmod below
mkdir -p /run/wslogin/tmux
chown "$RUN_USER":"$RUN_GROUP" /run/wslogin/tmux
chmod 755 /run/wslogin/tmux
if command -v setfacl >/dev/null 2>&1; then
  # default ACLs so user-owned socket directories and the tmux sockets
  # inside them stay accessible for the service user (see server.js);
  # the x bit is required for the service user to traverse into the
  # user-owned socket directories
  setfacl -d -m "u:$RUN_USER:rwx" -d -m 'm::rwx' /run/wslogin/tmux
else
  echo "warning: setfacl not installed, tmux socket attach will fail when the server runs unprivileged" >&2
fi

if getent group shadow >/dev/null 2>&1; then
  if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx shadow; then
    echo "Adding $RUN_USER to the shadow group (PAM password login)"
    usermod -aG shadow "$RUN_USER"
  fi
fi

SUDOERS="/etc/sudoers.d/$RUN_USER"
# sudo-rs (Ubuntu >= 25.10) ignores the !root exclusion, so the deny for
# root must be a later, password-only rule (last match wins).
SUDOERS_RULE="$RUN_USER ALL=(ALL:!root) NOPASSWD: ALL"
SUDOERS_DENY="$RUN_USER ALL=(root) ALL"
if [[ ! -e "$SUDOERS" ]] || ! grep -qxF "$SUDOERS_DENY" "$SUDOERS" 2>/dev/null; then
  echo "Installing $SUDOERS"
  TMP_SUDOERS="$(mktemp)"
  printf '%s\n%s\n' "$SUDOERS_RULE" "$SUDOERS_DENY" > "$TMP_SUDOERS"
  visudo -cf "$TMP_SUDOERS" >/dev/null
  install -o root -g root -m 0440 "$TMP_SUDOERS" "$SUDOERS"
  rm -f "$TMP_SUDOERS"
fi

if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --chown="$RUN_USER":"$RUN_GROUP" \
    --exclude='.git/' \
    --include='*.example.ini' \
    --exclude='node_modules/' \
    --exclude='sessions/' \
    --exclude='cookies/' \
    --exclude='ssl/' \
    --exclude='*.key' \
    --exclude='*.crt' \
    --exclude='*.cert' \
    --exclude='*.pem' \
    --exclude='playback-cache/' \
    --exclude='*.ini' \
    --exclude='*.swp' \
    --exclude='*.swo' \
    --exclude='*~' \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

echo "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --legacy-peer-deps)

echo "Handing $APP_DIR to $RUN_USER"
chown -R "$RUN_USER":"$RUN_GROUP" "$APP_DIR"

# setuid helper for the tmux attach (see wslogin-run.c): node-pty's child
# must run as the session user and only root can become one; the helper
# execs tmux directly, without sudo's forked parent in the process list.
# Built after the chown so it keeps root ownership and the setuid bit.
if command -v gcc >/dev/null 2>&1; then
  echo "Building setuid attach helper wslogin-run"
  gcc -O2 -Wall -DWSLOGIN_RUN_CALLER="\"$RUN_USER\"" \
    -o "$APP_DIR/wslogin-run.new" "$APP_DIR/wslogin-run.c"
  chown root:root "$APP_DIR/wslogin-run.new"
  chmod 4755 "$APP_DIR/wslogin-run.new"
  mv -f "$APP_DIR/wslogin-run.new" "$APP_DIR/wslogin-run"
else
  echo "warning: gcc not found, wslogin-run helper not built; attach falls back to sudo" >&2
fi

if [[ -r "${AUTH_CONF:-/etc/apache2/auth.conf}" ]]; then
  AUTH_INI="${AUTH_INI:-/etc/wslogin/auth.ini}" \
    "$APP_DIR/sync-auth-conf.sh"
fi

if [[ ! -e /etc/pam.d/wslogin ]]; then
  echo "Installing /etc/pam.d/wslogin from wslogin.pam.example"
  cp "$APP_DIR/wslogin.pam.example" /etc/pam.d/wslogin
fi

if systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
  # The detached server (process.title=wslogin, ppid=1) survives a unit
  # restart and would keep holding the port, failing the new instance with
  # EADDRINUSE. Kill leftovers of the unit first.
  LEFTOVER_PIDS="$(pgrep -x wslogin || true)"
  if [[ -n "$LEFTOVER_PIDS" ]]; then
    echo "Stopping leftover ${SERVICE} server processes: $(echo $LEFTOVER_PIDS | tr '\n' ' ')"
    kill $LEFTOVER_PIDS 2>/dev/null || true
    sleep 1
  fi
  echo "Restarting ${SERVICE}.service"
  systemctl daemon-reload
  systemctl restart "${SERVICE}.service"
  systemctl --no-pager --lines=0 status "${SERVICE}.service"
else
  echo "warning: ${SERVICE}.service is not installed; not restarting" >&2
fi

echo "Deployment complete"
