#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

for cmd in curl tar node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is required" >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

latest_version() {
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "https://registry.npmjs.org/$1/latest" |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).version))"
}

fetch_package() {
  local pkg="$1" version="$2" dest="$3"
  mkdir -p "$dest"
  echo "downloading $pkg@$version"
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "https://registry.npmjs.org/${pkg}/-/${pkg##*/}-${version}.tgz" |
    tar xz -C "$dest" --strip-components=1
}

XTERM_VERSION="$(latest_version @xterm/xterm)"
FIT_VERSION="$(latest_version @xterm/addon-fit)"
WEBLINKS_VERSION="$(latest_version @xterm/addon-web-links)"
SERIALIZE_VERSION="$(latest_version @xterm/addon-serialize)"
HEADLESS_VERSION="$(latest_version @xterm/headless)"

fetch_package @xterm/xterm "$XTERM_VERSION" "$TMP/xterm"
fetch_package @xterm/addon-fit "$FIT_VERSION" "$TMP/addon-fit"
fetch_package @xterm/addon-web-links "$WEBLINKS_VERSION" "$TMP/addon-web-links"
fetch_package @xterm/addon-serialize "$SERIALIZE_VERSION" "$TMP/addon-serialize"
fetch_package @xterm/headless "$HEADLESS_VERSION" "$TMP/headless"

echo "vendoring browser assets into www/t"
install -m 0644 "$TMP/xterm/lib/xterm.js" www/t/xterm.js
install -m 0644 "$TMP/xterm/lib/xterm.js.map" www/t/xterm.js.map
install -m 0644 "$TMP/xterm/css/xterm.css" www/t/xterm.css
install -m 0644 "$TMP/addon-fit/lib/addon-fit.js" www/t/xterm-addon-fit.js
install -m 0644 "$TMP/addon-fit/lib/addon-fit.js.map" www/t/xterm-addon-fit.js.map
install -m 0644 "$TMP/addon-web-links/lib/addon-web-links.js" www/t/xterm-addon-web-links.js
install -m 0644 "$TMP/addon-web-links/lib/addon-web-links.js.map" www/t/xterm-addon-web-links.js.map
rm -f www/t/xterm-addon-webgl.js www/t/xterm-addon-webgl.js.map

echo "vendoring browser assets into sudovideo"
mkdir -p sudovideo
install -m 0644 "$TMP/xterm/lib/xterm.js" sudovideo/xterm.js
install -m 0644 "$TMP/xterm/lib/xterm.js.map" sudovideo/xterm.js.map
install -m 0644 "$TMP/xterm/css/xterm.css" sudovideo/xterm.css
install -m 0644 "$TMP/addon-fit/lib/addon-fit.js" sudovideo/addon-fit.js
install -m 0644 "$TMP/addon-fit/lib/addon-fit.js.map" sudovideo/addon-fit.js.map
install -m 0644 "$TMP/addon-web-links/lib/addon-web-links.js" sudovideo/addon-web-links.js
install -m 0644 "$TMP/addon-web-links/lib/addon-web-links.js.map" sudovideo/addon-web-links.js.map

echo "updating www symlinks"
link_asset() {
  local name="$1"
  rm -f "www/$name"
  ln -s "t/$name" "www/$name"
}
link_asset xterm.js
link_asset xterm.js.map
link_asset xterm.css
link_asset xterm-addon-fit.js
link_asset xterm-addon-fit.js.map
link_asset xterm-addon-web-links.js
link_asset xterm-addon-web-links.js.map

echo "updating package.json"
node - "$XTERM_VERSION" "$FIT_VERSION" "$WEBLINKS_VERSION" "$SERIALIZE_VERSION" "$HEADLESS_VERSION" <<'NODE'
const fs = require('fs');
const [xterm, fit, webLinks, serialize, headless] = process.argv.slice(2);
const file = 'package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const deps = pkg.dependencies || {};

for (const name of ['xterm', 'xterm-addon-fit', 'xterm-addon-web-links', 'xterm-addon-serialize', 'xterm-headless']) {
  delete deps[name];
}

Object.assign(deps, {
  '@xterm/xterm': xterm,
  '@xterm/addon-fit': fit,
  '@xterm/addon-web-links': webLinks,
  '@xterm/addon-serialize': serialize,
  '@xterm/headless': headless,
});

pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
NODE

echo "updating source for xterm 6.x"
node <<'NODE'
const fs = require('fs');

const replacements = [
  ['require ("xterm-headless")', 'require ("@xterm/headless")'],
  ['require("xterm-addon-serialize")', 'require("@xterm/addon-serialize")'],
  ['require ("xterm")', 'require ("@xterm/xterm")'],
  ['.writeUtf8(', '.write('],
  ['new Terminal()', 'new Terminal({ allowProposedApi: true })'],
];

for (const file of ['server.js', 'www/wslogin.js', 'www/i.html', 'www/index.html.withscript']) {
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  for (const [from, to] of replacements) {
    text = text.split(from).join(to);
  }
  text = text.replace(/^[ \t]*bellStyle:\s*'visual',[ \t]*\r?\n/gm, '');
  if (text !== original) {
    fs.writeFileSync(file, text);
    console.log(`  patched ${file}`);
  }
}
NODE

echo "refreshing package-lock.json"
if command -v npm >/dev/null 2>&1; then
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
elif command -v corepack >/dev/null 2>&1; then
  corepack npm@10 install --package-lock-only --ignore-scripts --no-audit --no-fund
else
  echo "warning: npm/corepack not found; package-lock.json was not refreshed" >&2
fi

echo
echo "xterm updated: core $XTERM_VERSION, addon-fit $FIT_VERSION, addon-web-links $WEBLINKS_VERSION, addon-serialize $SERIALIZE_VERSION, headless $HEADLESS_VERSION"
echo "run 'npm install' to install the updated server dependencies."
