#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadSslOptions, allowPlaintext } = require('./ssl');
const { render: renderTemplate, placeholders: templatePlaceholders,
  isSafeRelative } = require('./template');

process.title = 'wslogin-receiver';

const DEFAULT_PORT = 9023;
const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;
const MAX_PAYLOAD = 1024 * 1024;
const META_SUFFIX = '.meta.json';
const CORRUPT_SUFFIX = '.corrupt';
const HOSTKEY_FILE = 'hostkey.hash';
const DEFAULT_STORE_TEMPLATE =
  'archive/<hostname>/<username>/<session>.json';
const DEFAULT_ACTIVE_TEMPLATE =
  'active/<hostname>/<username>/<session>.json';

var ini = require('ini');
var configPath = process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini';
if (!fs.existsSync(configPath)) {
  console.error('configuration file not found: ' + configPath);
  process.exit(1);
}
var config = ini.parse(fs.readFileSync(configPath, 'utf-8', true));
console.log('using configuration file ' + configPath);

function configInt(name, fallback) {
  if (!(name in config)) return fallback;
  var value = parseInt(config[name], 10);
  return Number.isFinite(value) ? value : fallback;
}
function configBool(name, fallback) {
  if (!(name in config)) return fallback;
  var value = String(config[name]).toLowerCase();
  return !(value == '0' || value == 'false' || value == 'no' || value == 'off');
}

var port = configInt('receiver_port', DEFAULT_PORT);
var dataDir = path.resolve(__dirname,
  config.receiver_data_dir || 'uploads');
var maxSize = Math.max(0, configInt('receiver_max_size', DEFAULT_MAX_SIZE));
var requireHostkey = configBool('receiver_require_hostkey', false);
var debug = configBool('receiver_debug', false);
var verbose = configBool('upload_append_verbose', false);
var storeTemplate = config.receiver_store_template
  ? String(config.receiver_store_template)
  : DEFAULT_STORE_TEMPLATE;
var allowedNames = ['date', 'hostname', 'username', 'session', 'kind'];
var storeNames = templatePlaceholders(storeTemplate);
for (var name of storeNames) {
  if (allowedNames.indexOf(name) == -1) {
    console.error('receiver_store_template uses unknown placeholder <'
      + name + '>: ' + storeTemplate);
    process.exit(1);
  }
}
if (!storeTemplate.endsWith('.json')) {
  console.error('receiver_store_template must end in .json: '
    + storeTemplate);
  process.exit(1);
}
// Active snapshots live in their own directory and are moved to the archive
// layout when the final (finished) copy is received. receiver_active_template
// is used when set; session_template is accepted as a fallback because earlier
// receiver configurations reused it for this purpose.
var activeTemplate = config.receiver_active_template
  ? String(config.receiver_active_template)
  : (config.session_template
      && templatePlaceholders(String(config.session_template)).has('hostname')
    ? String(config.session_template)
    : DEFAULT_ACTIVE_TEMPLATE);
var activeNames = templatePlaceholders(activeTemplate);
for (var activeName of activeNames) {
  if (allowedNames.indexOf(activeName) == -1) {
    console.error('receiver_active_template uses unknown placeholder <'
      + activeName + '>: ' + activeTemplate);
    process.exit(1);
  }
}
if (!activeTemplate.endsWith('.json')) {
  console.error('receiver_active_template must end in .json: '
    + activeTemplate);
  process.exit(1);
}
fs.mkdirSync(dataDir, {recursive: true});
console.log('receiver data_dir=' + dataDir + ' max_size=' + maxSize
  + ' require_hostkey=' + requireHostkey);
console.log('receiver_active_template=' + activeTemplate);
console.log('receiver_store_template=' + storeTemplate);

var HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
var USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
var SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
var SHA256_RE = /^[0-9a-f]{64}$/;
var KEY_MIN_LENGTH = 16;

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a != 'string' || typeof b != 'string' || a.length != b.length) {
    return false;
  }
  var ab = Buffer.from(a, 'utf8');
  var bb = Buffer.from(b, 'utf8');
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch (error) {
    return false;
  }
}

function startDateFor(meta) {
  var value = Number(meta.startdate);
  return Number.isFinite(value) && value > 0 ? value : Date.now() / 1000;
}

function renderPaths(template, meta) {
  var relative = renderTemplate(template, {
    hostname: meta.hostname,
    username: meta.username,
    session: meta.session,
    kind: meta.kind,
    date: startDateFor(meta)
  });
  if (!isSafeRelative(relative)) {
    throw new Error('unsafe store path: ' + relative);
  }
  var file = path.join(dataDir, relative);
  return {
    dir: path.dirname(file),
    file: file,
    metaFile: file + META_SUFFIX,
    corruptFile: file + CORRUPT_SUFFIX
  };
}

function activePaths(meta) {
  return renderPaths(activeTemplate, meta);
}

function archivePaths(meta) {
  return renderPaths(storeTemplate, meta);
}

// Active snapshots are written to the active layout. A finished upload is
// written straight to the archive and then removes the active copy, so a
// completed session never remains in the active directory.
function targetPaths(meta) {
  return meta.finished === true ? archivePaths(meta) : activePaths(meta);
}

function hostkeyFile(hostname) {
  return path.join(dataDir, hostname, HOSTKEY_FILE);
}

// Returns true when the announce is valid, otherwise an error string.
function validate(message) {
  if (typeof message.id != 'number' || !Number.isInteger(message.id)) {
    return 'missing stream id';
  }
  if (!HOSTNAME_RE.test(message.hostname || '')) return 'bad hostname';
  if (!USERNAME_RE.test(message.username || '')) return 'bad username';
  if (!SESSION_RE.test(message.session || '')) return 'bad session';
  if (message.kind != 'log') return 'unsupported kind';
  if (!Number.isInteger(message.size) || message.size < 0) return 'bad size';
  if (message.size > maxSize) return 'upload too large';
  if (!SHA256_RE.test(message.sha256 || '')) return 'bad sha256';
  if (message.startdate != null
      && (!Number.isFinite(Number(message.startdate))
        || Number(message.startdate) <= 0)) {
    return 'bad startdate';
  }
  if (message.finished != null && typeof message.finished != 'boolean') {
    return 'bad finished';
  }
  if (message.offset != null
      && (!Number.isInteger(message.offset)
        || message.offset < 0
        || message.offset > message.size)) {
    return 'bad offset';
  }
  if (message.hostkey != null
      && (typeof message.hostkey != 'string'
        || message.hostkey.length < KEY_MIN_LENGTH)) {
    return 'bad hostkey';
  }
  return null;
}

function checkHostkey(message) {
  var file = hostkeyFile(message.hostname);
  var expected = null;
  if (fs.existsSync(file)) {
    expected = fs.readFileSync(file, 'utf-8').trim().toLowerCase();
  }
  if (expected) {
    if (!message.hostkey) return 'hostkey required';
    if (!safeEqualHex(sha256hex(message.hostkey), expected)) {
      return 'bad hostkey';
    }
    return null;
  }
  if (requireHostkey) return 'hostkey required';
  return null;
}

function loadMetaAt(paths) {
  if (!fs.existsSync(paths.metaFile)) return null;
  try {
    var stored = JSON.parse(fs.readFileSync(paths.metaFile, 'utf-8'));
    if (Number.isInteger(stored.size) && SHA256_RE.test(stored.sha256)) {
      return stored;
    }
  } catch (error) {
    console.error('error reading ' + paths.metaFile + ': ' + error.message);
  }
  return null;
}

function saveMetaAt(paths, meta) {
  var tmp = paths.metaFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, paths.metaFile);
}

function clearMetaAt(paths) {
  try { fs.rmSync(paths.metaFile, {force: true}); } catch (error) {}
}

function removeStoredAt(paths) {
  try { fs.rmSync(paths.file, {force: true}); } catch (error) {}
  clearMetaAt(paths);
}

// Looks up the stored copy of a session in both layouts. The returned paths
// identify where the copy lives. Snapshots left in the archive layout by older
// receivers (finished:false) are moved back to the active layout.
function findStored(meta) {
  var active = activePaths(meta);
  var archive = archivePaths(meta);
  if (active.file === archive.file) {
    var stored = loadMetaAt(archive);
    return stored
      ? {stored: stored, paths: archive, finished: stored.finished === true}
      : null;
  }
  var activeMeta = loadMetaAt(active);
  var archiveMeta = loadMetaAt(archive);
  if (archiveMeta && archiveMeta.finished === true) {
    if (activeMeta) removeStoredAt(active);
    return {stored: archiveMeta, paths: archive, finished: true};
  }
  if (activeMeta) {
    if (archiveMeta) removeStoredAt(archive);
    return {stored: activeMeta, paths: active, finished: false};
  }
  if (archiveMeta) {
    if (archiveMeta.finished === false) {
      try {
        fs.mkdirSync(active.dir, {recursive: true});
        if (fs.existsSync(archive.file)) {
          fs.renameSync(archive.file, active.file);
        }
        saveMetaAt(active, archiveMeta);
        clearMetaAt(archive);
        console.log('moved active snapshot ' + archive.file + ' to '
          + active.file);
        return {stored: archiveMeta, paths: active, finished: false};
      } catch (error) {
        console.error('cannot move active snapshot ' + archive.file + ': '
          + error.message);
      }
    }
    return {stored: archiveMeta, paths: archive, finished: true};
  }
  return null;
}

function markCorrupt(paths) {
  if (!fs.existsSync(paths.file)) {
    clearMetaAt(paths);
    return;
  }
  var target = paths.corruptFile;
  if (fs.existsSync(target)) {
    target = paths.corruptFile + '.' + Date.now();
  }
  fs.renameSync(paths.file, target);
  clearMetaAt(paths);
  console.log('moved corrupt ' + paths.file + ' to ' + target);
}

// Removes temporary files left behind by a previous receiver process. Files
// belonging to the current process are in-flight uploads and are kept.
function cleanupTemp(paths) {
  var prefix = path.basename(paths.file) + '.tmp.';
  var names;
  try {
    names = fs.readdirSync(paths.dir);
  } catch (error) {
    return;
  }
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!name.startsWith(prefix)) continue;
    var pid = parseInt(name.slice(prefix.length), 10);
    if (pid === process.pid) continue;
    try {
      fs.rmSync(path.join(paths.dir, name), {force: true});
    } catch (error) {}
  }
}

function abortStream(conn, stream) {
  if (stream.fd != null) {
    try { fs.closeSync(stream.fd); } catch (error) {}
    stream.fd = null;
  }
  if (stream.tmpPath) {
    try { fs.rmSync(stream.tmpPath, {force: true}); } catch (error) {}
  }
  conn.streams.delete(stream.meta.id);
}

function send(conn, message) {
  if (conn.ws.readyState === conn.ws.OPEN) {
    conn.ws.send(JSON.stringify(message));
  }
}

// High-volume per-stream lines (state replies, stored, in sync) are only shown
// when receiver_debug is on.
function debugLog(message) {
  if (debug) console.log(message);
}

function fail(conn, stream, reason) {
  var id = stream ? stream.meta.id : null;
  console.log('error for stream ' + id + ': ' + reason);
  if (stream) abortStream(conn, stream);
  send(conn, {type: 'error', id: id, message: reason, retryable: false});
}

function handleAnnounce(conn, message) {
  var error = validate(message);
  if (error) {
    send(conn, {type: 'error', id: message.id, message: error,
      retryable: false});
    return;
  }
  if (conn.streams.has(message.id)) {
    send(conn, {type: 'error', id: message.id, message: 'duplicate stream id',
      retryable: false});
    return;
  }
  var hostkeyError = checkHostkey(message);
  if (hostkeyError) {
    send(conn, {type: 'error', id: message.id, message: hostkeyError,
      retryable: false});
    return;
  }

  var stream = {
    meta: {
      id: message.id,
      hostname: message.hostname,
      username: message.username,
      session: message.session,
      kind: message.kind,
      size: message.size,
      sha256: message.sha256,
      startdate: message.startdate != null
        ? Number(message.startdate) : Date.now() / 1000,
      finished: message.finished === true
    },
    offset: Number.isInteger(message.offset) && message.offset > 0
      ? message.offset : 0,
    storedSize: 0,
    phase: 'announced',
    mode: null,
    received: 0,
    hash: crypto.createHash('sha256'),
    fd: null,
    tmpPath: null
  };
  var paths;
  try {
    paths = targetPaths(stream.meta);
    fs.mkdirSync(paths.dir, {recursive: true});
    stream.paths = paths;
    cleanupTemp(paths);
    cleanupTemp(activePaths(stream.meta));
    cleanupTemp(archivePaths(stream.meta));
  } catch (error) {
    send(conn, {type: 'error', id: message.id, message: error.message,
      retryable: false});
    return;
  }
  conn.streams.set(message.id, stream);

  var found = findStored(stream.meta);
  if (found) {
    stream.storedSize = found.stored.size;
    // The announce carries the size and hash the uploader wants to send, so a
    // full match is confirmed in this single reply and no data is transferred.
    var same = found.stored.size === stream.meta.size
      && found.stored.sha256 === stream.meta.sha256
      && !(stream.meta.finished === true && found.finished !== true);
    if (same) {
      conn.streams.delete(message.id);
      send(conn, {type: 'state', id: message.id, exists: true,
        size: found.stored.size, sha256: found.stored.sha256,
        finished: found.finished, synced: true});
      debugLog('state for ' + message.hostname + '/' + message.username + '/'
        + message.session + ': in sync');
      return;
    }
    // The uploader announced a file pointer (offset): the bytes it believes we
    // already hold. When our stored size equals it, the uploader sends only the
    // tail and we append it to the stored prefix. Append is the default and
    // needs no confirmation: in non-verbose mode we stay silent and only react
    // on end. A stored size that differs from the pointer is the go-wrong
    // signal, so we report our real size and the uploader uploads in full.
    var append = stream.meta.finished === false
      && found.finished === false
      && stream.offset > 0
      && found.stored.size === stream.offset;
    if (append) {
      stream.mode = 'append';
      if (!verbose) {
        debugLog('state for ' + message.hostname + '/' + message.username + '/'
          + message.session + ': append at ' + found.stored.size + ' bytes');
        return;
      }
    }
    send(conn, {type: 'state', id: message.id, exists: true,
      size: found.stored.size, sha256: found.stored.sha256,
      finished: found.finished});
    var label = append
      ? 'append at ' + found.stored.size + ' bytes'
      : 'exists (' + found.stored.size + ' bytes'
        + (found.finished ? ', finished)' : ', active)');
    debugLog('state for ' + message.hostname + '/' + message.username + '/'
      + message.session + ': ' + label);
  } else {
    send(conn, {type: 'state', id: message.id, exists: false});
    debugLog('state for ' + message.hostname + '/' + message.username + '/'
      + message.session + ': empty');
  }
}

function openTemp(stream) {
  stream.tmpPath = stream.paths.file + '.tmp.' + process.pid + '.'
    + stream.meta.id;
  stream.fd = fs.openSync(stream.tmpPath, 'w');
  // An append continues the stored prefix: copy it into the temporary file and
  // hash it, so the appended tail forms the complete file that is verified
  // against the announced sha256. The prefix is streamed to keep memory flat.
  if (stream.mode == 'append') {
    var inFd = fs.openSync(stream.paths.file, 'r');
    try {
      var buffer = Buffer.alloc(64 * 1024);
      var read;
      while ((read = fs.readSync(inFd, buffer, 0, buffer.length, null)) > 0) {
        fs.writeSync(stream.fd, buffer, 0, read);
        stream.hash.update(buffer.subarray(0, read));
        stream.received += read;
      }
    } catch (error) {
      try { fs.closeSync(inFd); } catch (ignored) {}
      throw error;
    }
    fs.closeSync(inFd);
  }
}

function handleData(conn, stream, data) {
  if (stream.received + data.length > stream.meta.size) {
    fail(conn, stream, 'received more than the announced size');
    return;
  }
  try {
    if (stream.fd == null) openTemp(stream);
    fs.writeSync(stream.fd, data);
  } catch (error) {
    fail(conn, stream, 'cannot write temporary file: ' + error.message);
    return;
  }
  stream.hash.update(data);
  stream.received += data.length;
  if (stream.phase == 'announced') stream.phase = 'data';
}

function handleEnd(conn, stream) {
  var digest = stream.hash.digest('hex');
  var append = stream.mode == 'append';
  // A full-mode tail we could not append (pointer not honored), or an append
  // whose prefix turned out stale, is reported as go-wrong: we send our real
  // size and keep the stream so the following replace resets it for a full
  // upload.
  if ((append && digest != stream.meta.sha256)
      || (!append && stream.received < stream.meta.size)) {
    send(conn, {type: 'state', id: stream.meta.id, exists: true,
      size: stream.storedSize, sha256: stream.meta.sha256,
      finished: stream.meta.finished});
    resetForReplace(stream);
    debugLog('report size for ' + stream.meta.hostname + '/'
      + stream.meta.username + '/' + stream.meta.session + ': '
      + stream.storedSize + ' bytes');
    return;
  }
  if (stream.received != stream.meta.size) {
    fail(conn, stream, 'size mismatch, received ' + stream.received
      + ' of ' + stream.meta.size);
    return;
  }
  if (digest != stream.meta.sha256) {
    fail(conn, stream, 'sha256 mismatch');
    return;
  }
  if (stream.fd != null) {
    try { fs.closeSync(stream.fd); } catch (error) {}
    stream.fd = null;
  }
  var paths = stream.paths || targetPaths(stream.meta);
  try {
    if (stream.tmpPath) {
      fs.renameSync(stream.tmpPath, paths.file);
      stream.tmpPath = null;
    } else {
      fs.writeFileSync(paths.file, Buffer.alloc(0));
    }
    saveMetaAt(paths, {
      hostname: stream.meta.hostname,
      username: stream.meta.username,
      session: stream.meta.session,
      kind: stream.meta.kind,
      size: stream.meta.size,
      sha256: digest,
      startdate: stream.meta.startdate,
      finished: stream.meta.finished === true,
      time: Date.now() / 1000
    });
    if (stream.meta.finished === true) {
      var active = activePaths(stream.meta);
      if (active.file !== paths.file) {
        removeStoredAt(active);
        console.log('archived ' + stream.meta.hostname + '/'
          + stream.meta.username + '/' + stream.meta.session);
      }
    }
  } catch (error) {
    fail(conn, stream, 'cannot store file: ' + error.message);
    return;
  }
  conn.streams.delete(stream.meta.id);
  send(conn, {type: 'ok', id: stream.meta.id});
  debugLog('stored ' + stream.meta.hostname + '/' + stream.meta.username
    + '/' + stream.meta.session + ' (' + stream.meta.size + ' bytes)');
}

function handleSynced(conn, stream) {
  var found = findStored(stream.meta);
  if (!found || found.stored.sha256 != stream.meta.sha256) {
    fail(conn, stream, 'cannot confirm, remote state changed');
    return;
  }
  if (stream.meta.finished === true && !found.finished) {
    fail(conn, stream, 'cannot confirm, remote state changed');
    return;
  }
  conn.streams.delete(stream.meta.id);
  send(conn, {type: 'ok', id: stream.meta.id});
  debugLog('in sync ' + stream.meta.hostname + '/' + stream.meta.username
    + '/' + stream.meta.session);
}

// A replace/corrupt after a go-wrong tail: discard the partial temporary file
// the tail was written to and restart the stream as a clean full upload.
function resetForReplace(stream) {
  if (stream.fd != null) {
    try { fs.closeSync(stream.fd); } catch (error) {}
    stream.fd = null;
  }
  if (stream.tmpPath) {
    try { fs.rmSync(stream.tmpPath, {force: true}); } catch (error) {}
    stream.tmpPath = null;
  }
  stream.mode = null;
  stream.received = 0;
  stream.hash = crypto.createHash('sha256');
  stream.phase = 'data';
}

function handleCorrupt(conn, stream) {
  try {
    markCorrupt(stream.paths || targetPaths(stream.meta));
  } catch (error) {
    fail(conn, stream, 'cannot mark corrupt: ' + error.message);
    return;
  }
  resetForReplace(stream);
}

var PRUNE_MAX_SESSIONS = 100000;
var LIST_KEY_CAP = 200000;

// Appends the tailer record (c:5, same shape as server.js) to a log that is
// archived by pruning, with a note marking it as a deleted session. The
// payload records the size and SHA-256 of the file without the tailer.
// Empty logs get no tailer (same rule as server.js write_tailer). Returns
// the final size and SHA-256 of the complete archived file.
function appendDeletedTailer(file) {
  var stat = fs.statSync(file);
  var size = stat.size;
  var endtime = Date.now() / 1000;
  if (size === 0) {
    return {size: 0, sha256: sha256hex(Buffer.alloc(0))};
  }
  var hash = crypto.createHash('sha256');
  var fd = fs.openSync(file, 'r');
  try {
    var buffer = Buffer.alloc(256 * 1024);
    var offset = 0;
    while (offset < size) {
      var read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset),
        offset);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally { fs.closeSync(fd); }
  var contentSha256 = hash.copy().digest('hex');
  var tail = {t: endtime, c: 5, d: JSON.stringify({
    size: size,
    sha256: contentSha256,
    endtime: endtime,
    note: 'deleted session'
  })};
  var tailText = JSON.stringify(tail) + '\n';
  fs.appendFileSync(file, tailText);
  hash.update(Buffer.from(tailText, 'utf8'));
  return {size: size + Buffer.byteLength(tailText), sha256: hash.digest('hex')};
}

// Moves a pruned active copy into the archive layout, appends the deleted-
// session tailer and updates the meta. When the final copy is already
// archived, the active copy is stale and is discarded. Returns true when a
// copy was archived, false when it was discarded.
function archiveDeletedCopy(stored, paths) {
  var meta = {
    hostname: stored.hostname,
    username: stored.username,
    session: stored.session,
    kind: stored.kind || 'log',
    startdate: stored.startdate
  };
  var archive = archivePaths(meta);
  var existing = loadMetaAt(archive);
  if (existing && existing.finished === true && archive.file !== paths.file) {
    removeStoredAt(paths);
    return false;
  }
  if (archive.file !== paths.file) {
    fs.mkdirSync(archive.dir, {recursive: true});
    fs.renameSync(paths.file, archive.file);
  }
  var final = appendDeletedTailer(archive.file);
  saveMetaAt(archive, {
    hostname: meta.hostname,
    username: meta.username,
    session: meta.session,
    kind: meta.kind,
    size: final.size,
    sha256: final.sha256,
    startdate: meta.startdate,
    finished: true,
    time: Date.now() / 1000
  });
  if (archive.metaFile !== paths.metaFile) clearMetaAt(paths);
  return true;
}

// Prunes active copies of a host whose (username, session) key is in the
// action set. mode 'delete' prunes exactly the listed sessions (gone
// signal), mode 'keep' prunes every active copy of the host not listed
// (full list sync). Pruned copies are archived with a deleted-session
// tailer, never deleted. Finished archives are final records and are never
// touched.
function pruneActiveCopies(hostname, keys, mode) {
  var pruned = 0;
  function walk(dir) {
    var items;
    try {
      items = fs.readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      if (!item.isFile() || !item.name.endsWith(META_SUFFIX)) continue;
      var stored;
      try {
        stored = JSON.parse(fs.readFileSync(full, 'utf-8'));
      } catch (error) {
        continue;
      }
      if (stored.hostname !== hostname || stored.finished === true) continue;
      var key = stored.username + ':' + stored.session;
      if ((mode == 'keep') === keys.has(key)) continue;
      var file = full.slice(0, -META_SUFFIX.length);
      var paths = {file: file, metaFile: full};
      try {
        if (!fs.existsSync(file)) {
          clearMetaAt(paths);
          continue;
        }
        if (archiveDeletedCopy(stored, paths)) {
          console.log('archived deleted session ' + file);
          pruned++;
        }
      } catch (error) {
        console.error('cannot archive ' + file + ': ' + error.message);
      }
    }
  }
  walk(dataDir);
  return pruned;
}

// gone/list: the uploader reports sessions it no longer has locally, so
// active snapshots of cleaned-up sessions do not linger as strays. A list
// may arrive in chunks; the keys accumulate on the connection until the
// chunk with last:true triggers the prune. An empty list is ignored: a
// scan that finds nothing (unmounted session_dir, config change) must not
// archive every active copy of the host as deleted.
function handlePrune(conn, message) {
  if (!HOSTNAME_RE.test(message.hostname || '')) return;
  var hostkeyError = checkHostkey(message);
  if (hostkeyError) {
    console.log('prune from ' + message.hostname + ' rejected: ' + hostkeyError);
    return;
  }
  var entries = message.type == 'gone'
    ? [{username: message.username, session: message.session}]
    : message.sessions;
  if (!Array.isArray(entries) || entries.length > PRUNE_MAX_SESSIONS) return;
  var keys = new Set();
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {};
    if (!USERNAME_RE.test(entry.username || '')
        || !SESSION_RE.test(entry.session || '')) {
      if (conn.listKeys) { conn.listHost = null; conn.listKeys = null; }
      return;
    }
    keys.add(entry.username + ':' + entry.session);
  }
  if (message.type == 'gone') {
    var removed = pruneActiveCopies(message.hostname, keys, 'delete');
    console.log('prune gone from ' + message.hostname + ': '
      + removed + ' active copy/copies archived as deleted');
    return;
  }
  if (conn.listHost !== message.hostname) {
    conn.listHost = message.hostname;
    conn.listKeys = new Set();
  }
  keys.forEach(function(key) { conn.listKeys.add(key); });
  if (conn.listKeys.size > LIST_KEY_CAP) {
    console.log('prune list from ' + message.hostname + ': too many entries, ignored');
    conn.listHost = null;
    conn.listKeys = null;
    return;
  }
  if (message.last !== true) return;
  keys = conn.listKeys;
  conn.listHost = null;
  conn.listKeys = null;
  if (keys.size === 0) {
    console.log('prune list from ' + message.hostname + ': empty list, nothing pruned');
    return;
  }
  var archived = pruneActiveCopies(message.hostname, keys, 'keep');
  console.log('prune list from ' + message.hostname + ': '
    + archived + ' active copy/copies archived as deleted');
}

function handleText(conn, raw) {
  var message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    send(conn, {type: 'error', id: null, message: 'invalid json',
      retryable: false});
    return;
  }
  if (message.type == 'upload') {
    handleAnnounce(conn, message);
    return;
  }
  if (message.type == 'gone' || message.type == 'list') {
    handlePrune(conn, message);
    return;
  }
  if (message.id == null) return;
  var stream = conn.streams.get(message.id);
  if (!stream) return;
  switch (message.type) {
    case 'synced': handleSynced(conn, stream); break;
    case 'corrupt': handleCorrupt(conn, stream); break;
    case 'replace': resetForReplace(stream); break;
    case 'end': handleEnd(conn, stream); break;
    default: break;
  }
}

function handleBinary(conn, data) {
  if (data.length < 4) return;
  var id = data.readUInt32BE(0);
  var stream = conn.streams.get(id);
  if (!stream) return;
  handleData(conn, stream, data.subarray(4));
}

function handleConnection(ws, request) {
  var remote = request && request.socket
    ? request.socket.remoteAddress : 'unknown';
  var conn = {ws: ws, streams: new Map()};
  console.log('connection from ' + remote);
  ws.on('message', function(data, isBinary) {
    if (isBinary) {
      handleBinary(conn, Buffer.isBuffer(data) ? data : Buffer.from(data));
    } else {
      handleText(conn, Buffer.isBuffer(data) ? data.toString()
        : String(data));
    }
  });
  ws.on('close', function() {
    for (var stream of conn.streams.values()) {
      abortStream(conn, stream);
    }
    conn.streams.clear();
    console.log('connection from ' + remote + ' closed');
  });
  ws.on('error', function(error) {
    console.error('websocket error: ' + error.message);
  });
}

var httpServer = http.createServer(function(request, response) {
  response.statusCode = 404;
  response.end('');
});

var httpsServer = null;
var sslOptions = null;
try {
  sslOptions = loadSslOptions(config, {baseDir: __dirname});
} catch (error) {
  console.error('ssl configuration error: ' + error.message);
  process.exit(1);
}
if (sslOptions) {
  httpsServer = https.createServer(sslOptions, function(request, response) {
    response.statusCode = 404;
    response.end('');
  });
  console.log('https enabled using ' + sslOptions.certFile
    + (sslOptions.selfSigned ? ' (self-signed)' : ''));
}

var allowHttp = allowPlaintext(config);
if (!httpsServer && !allowHttp) {
  console.error('plain http is disabled but https is not enabled, '
    + 'there is nothing to serve');
  process.exit(1);
}

var server;
if (httpsServer && allowHttp) {
  server = net.createServer(function(socket) {
    socket.once('data', function(chunk) {
      socket.pause();
      socket.unshift(chunk);
      if (chunk[0] === 0x16) {
        httpsServer.emit('connection', socket);
      } else {
        httpServer.emit('connection', socket);
        socket.resume();
      }
    });
  });
} else if (httpsServer) {
  server = httpsServer;
} else {
  server = httpServer;
}

// In combined ws/wss mode the net server forwards the socket to the http or
// https server, so upgrade events happen on those servers, not on the net
// server. Handle upgrades on both and let ws complete the handshake.
var wss = new WebSocketServer({noServer: true, maxPayload: MAX_PAYLOAD});
wss.on('connection', handleConnection);
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, function(ws) {
    wss.emit('connection', ws, request);
  });
}
httpServer.on('upgrade', handleUpgrade);
if (httpsServer) httpsServer.on('upgrade', handleUpgrade);

server.listen(port, function() {
  console.log('receiver listening on port ' + port
    + (httpsServer ? (allowHttp ? ' (ws and wss)' : ' (wss only)') : ' (ws)')
    + '.');
});
