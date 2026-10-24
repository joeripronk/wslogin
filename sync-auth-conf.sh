#!/usr/bin/env bash
# Syncs the Apache mod_session settings from the auth server configuration
# (/etc/apache2/auth.conf) to the wslogin auth configuration
# (/etc/wslogin/auth.ini), so wslogin can decrypt the session cookie of
# https://auth.joeri.nu and use its session cookie for sso login.
set -euo pipefail

AUTH_CONF="${AUTH_CONF:-/etc/apache2/auth.conf}"
AUTH_INI="${AUTH_INI:-/etc/wslogin/auth.ini}"

if [[ ! -r "$AUTH_CONF" ]]; then
  echo "error: $AUTH_CONF is missing or not readable" >&2
  exit 1
fi

parsed="$(mktemp)"
trap 'rm -f "$parsed"' EXIT

awk '
  /^[[:space:]]*#/ { next }
  tolower($1) == "sessioncookiename" {
    name = $2
    for (i = 3; i <= NF; i++) {
      if (match($i, /[Dd][Oo][Mm][Aa][Ii][Nn]=[^;]+/)) {
        domain = substr($i, RSTART + 7, RLENGTH - 7)
      }
    }
  }
  tolower($1) == "sessioncryptopassphrase" {
    pass = $2
    gsub(/"/, "", pass)
    if (pass != "" && substr(pass, 1, 5) != "exec:") {
      print "passphrase=" pass
    }
  }
  END {
    if (name == "") exit 1
    print "cookie_name=" name
    if (domain != "") print "cookie_domain=" domain
  }
' "$AUTH_CONF" > "$parsed"

if ! grep -q '^cookie_name=' "$parsed" || ! grep -q '^passphrase=' "$parsed"; then
  echo "error: no SessionCookieName with SessionCryptoPassphrase found in $AUTH_CONF" >&2
  exit 1
fi

name="$(awk -F= '/^cookie_name=/{print substr($0,13)}' "$parsed")"
domain="$(awk -F= '/^cookie_domain=/{print substr($0,15)}' "$parsed" || true)"
echo "Syncing cookie '$name'${domain:+ (domain $domain)} from $AUTH_CONF to $AUTH_INI"

# keep host local options (verify_password, pam_service, sso_group) from
# the previous configuration
local_opts="$(mktemp)"
trap 'rm -f "$parsed" "$local_opts"' EXIT
if [[ -r "$AUTH_INI" ]]; then
  awk '/^(verify_password|pam_service|sso_group|linkshare_passphrase)=/' "$AUTH_INI" > "$local_opts"
fi

umask 077
mkdir -p "$(dirname "$AUTH_INI")"
{
  echo "; generated from $AUTH_CONF by sync-auth-conf.sh, do not edit"
  echo "; decrypts the session cookie of the auth server for sso login."
  cat "$parsed"
  cat "$local_opts"
} > "$AUTH_INI".tmp
mv "$AUTH_INI".tmp "$AUTH_INI"
chmod 600 "$AUTH_INI"
if [[ "$(id -u)" -eq 0 ]] && id wslogin >/dev/null 2>&1; then
  chown root:wslogin "$AUTH_INI"
fi
