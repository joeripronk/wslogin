#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { match: matchTemplate } = require('./template');

const MAX_ATTEMPTS = 5;
const UPLOAD_TIMEOUT_MS = 300000;
const CHUNK_SIZE = 128 * 1024;
const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_CONNECTIONS = 4;
const RETRY_BASE_MS = 1000;
const LOG_SUFFIX = '.json';
const CHECKPOINT_LOG_SUFFIX = '.checkpoint.json';
const FINISHED_SUFFIX = '.done';
const UPLOADED_SUFFIX = '.uploaded';

function configBool(config, name, fallback) {
  if (!(name in config)) return fallback;
  var value = String(config[name]).toLowerCase();
  return !(value == '0' || value == 'false' || value == 'no' || value == 'off');
}

function configInt(config, name, fallback) {
  if (!(name in config)) return fallback;
  var value = parseInt(config[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function websocketUrl(url) {
  var target = new URL(url);
  if (target.protocol == 'http:') target.protocol = 'ws:';
  else if (target.protocol == 'https:') target.protocol = 'wss:';
  if (target.protocol != 'ws:' && target.protocol != 'wss:') {
    throw new Error('unsupported protocol ' + target.protocol);
  }
  return target;
}

// Hashes a snapshot of the file. Active logs keep growing while they are read,
// so the size is fixed up front and only those bytes are hashed. The uploaded
// snapshot is therefore always a consistent prefix of the log.
async function hashFileStream(file) {
  var stat = await fs.promises.stat(file);
  var size = stat.size;
  var hash = crypto.createHash('sha256');
  var read = 0;
  if (size > 0) {
    var stream = fs.createReadStream(file, {start: 0, end: size - 1});
    await new Promise(function(resolve, reject) {
      stream.on('data', function(chunk) {
        var remaining = size - read;
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        if (chunk.length > 0) {
          hash.update(chunk);
          read += chunk.length;
        }
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  }
  return {size: read, sha256: hash.digest('hex')};
}

// Session logs are JSON lines; the first record's timestamp is the start time.
// Fall back to the file modification time when it cannot be read.
async function readStartDate(file) {
  var handle = null;
  try {
    handle = await fs.promises.open(file, 'r');
    var buffer = Buffer.alloc(4096);
    var result = await handle.read(buffer, 0, buffer.length, 0);
    var line = buffer.toString('utf-8', 0, result.bytesRead).split('\n')[0];
    var record = JSON.parse(line);
    if (Number.isFinite(record.t) && record.t > 0) return record.t;
  } catch (error) {
  } finally {
    if (handle) {
      try { await handle.close(); } catch (error) {}
    }
  }
  try {
    var stat = await fs.promises.stat(file);
    return stat.mtimeMs / 1000;
  } catch (error) {
    return Date.now() / 1000;
  }
}

/**
 * Multiplexes uploads over one or more WebSocket connections. Several streams
 * (files) can be interleaved on a single connection. When a connection cannot
 * keep up with the receiver (its send buffer stays above the high water mark)
 * it is marked saturated and additional connections are opened, up to
 * maxConnections, so uploads are spread out.
 */
function createTransport(target, ca, identity, maxConnections, highWaterMark) {
  var lowWaterMark = Math.max(1, Math.floor(highWaterMark / 4));
  var connections = [];
  var pending = [];
  var connecting = 0;
  var nextStreamId = 1;
  var closed = false;

  function sendMessage(conn, message) {
    return new Promise(function(resolve, reject) {
      conn.ws.send(JSON.stringify(message), function(error) {
        if (error) reject(error); else resolve();
      });
    });
  }

  // Binary frames are prefixed with the 4 byte big endian stream id so several
  // interleaved streams can share one socket.
  function sendChunk(conn, id, data) {
    return new Promise(function(resolve, reject) {
      var frame = Buffer.allocUnsafe(4 + data.length);
      frame.writeUInt32BE(id >>> 0, 0);
      data.copy(frame, 4);
      conn.ws.send(frame, {binary: true}, function(error) {
        if (error) reject(error); else resolve();
      });
    });
  }

  function makeError(message) {
    var error = new Error(message.message || message.error || 'upload rejected');
    error.retryable = message.retryable !== false;
    return error;
  }

  function clearStreamTimer(stream) {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
  }

  function armStreamTimer(conn, stream) {
    clearStreamTimer(stream);
    stream.timer = setTimeout(function() {
      failStream(conn, stream, new Error('upload timed out'));
    }, UPLOAD_TIMEOUT_MS);
    if (stream.timer.unref) stream.timer.unref();
  }

  function failStream(conn, stream, error) {
    if (stream.settled) return;
    conn.streams.delete(stream.id);
    stream.settled = true;
    clearStreamTimer(stream);
    if (stream.reader && stream.reader.return) {
      try { stream.reader.return(); } catch (ignored) {}
    }
    if (error.retryable !== false) error.retryable = true;
    stream.reject(error);
    schedulePending();
  }

  function failConnection(conn, error) {
    if (conn.dead) return;
    conn.dead = true;
    conn.open = false;
    if (conn.monitor) clearInterval(conn.monitor);
    var index = connections.indexOf(conn);
    if (index >= 0) connections.splice(index, 1);
    var failure = error || new Error('connection closed');
    failure.retryable = true;
    var streams = Array.from(conn.streams.values());
    conn.streams.clear();
    for (var i = 0; i < streams.length; i++) {
      var stream = streams[i];
      if (stream.settled) continue;
      stream.settled = true;
      clearStreamTimer(stream);
      if (stream.reader && stream.reader.return) {
        try { stream.reader.return(); } catch (ignored) {}
      }
      stream.reject(failure);
    }
    if (!closed) schedulePending();
  }

  // The server tells us the state of the file it already has for a stream.
  // When it matches the local file we tell the server it is in sync. When it
  // differs the existing copy is marked corrupt and the file is uploaded again.
  function handleState(conn, stream, message) {
    if (stream.phase != 'announce') return;
    armStreamTimer(conn, stream);
    var same = message.exists === true
      && message.size === stream.size
      && message.sha256 === stream.sha256;
    if (same) {
      stream.phase = 'synced';
      sendMessage(conn, {type: 'synced', id: stream.id}).catch(function(error) {
        failStream(conn, stream, error);
      });
      return;
    }
    if (message.exists === true) {
      // A finished log must never change, so a difference means the stored copy
      // is suspect and is kept as .corrupt. An active log is a moving snapshot:
      // replace the previous copy in place. A finished upload usually follows an
      // active snapshot of the same session, which is only a prefix of the
      // final log and must be replaced rather than kept as corrupt.
      var replace = stream.job.finished === false || message.finished !== true;
      stream.phase = replace ? 'replace' : 'corrupt';
      sendMessage(conn, {type: replace ? 'replace' : 'corrupt', id: stream.id})
        .then(function() {
          stream.phase = 'streaming';
          pump(conn);
        }, function(error) {
          failStream(conn, stream, error);
        });
      return;
    }
    stream.phase = 'streaming';
    pump(conn);
  }

  function handleMessage(conn, data) {
    var message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      return;
    }
    if (message.id == null) {
      if (message.type == 'error') failConnection(conn, makeError(message));
      return;
    }
    var stream = conn.streams.get(message.id);
    if (!stream || stream.settled) return;
    if (message.type == 'state') {
      handleState(conn, stream, message);
      return;
    }
    if (message.type != 'ok' && message.type != 'error') return;
    conn.streams.delete(message.id);
    stream.settled = true;
    clearStreamTimer(stream);
    if (message.type == 'ok') {
      stream.resolve();
    } else {
      stream.reject(makeError(message));
    }
    schedulePending();
  }

  function connect() {
    connecting++;
    return new Promise(function(resolve, reject) {
      var socketOptions = {handshakeTimeout: 30000, maxPayload: 64 * 1024};
      if (target.protocol == 'wss:' && ca) socketOptions.ca = ca;
      var ws = new WebSocket(target.toString(), socketOptions);
      var conn = {
        ws: ws,
        streams: new Map(),
        open: false,
        dead: false,
        saturated: false,
        pumpRunning: false
      };
      var opened = false;
      var released = false;
      function release() {
        if (released) return;
        released = true;
        connecting--;
      }
      ws.on('open', function() {
        release();
        opened = true;
        conn.open = true;
        connections.push(conn);
        // Watch the send buffer so a slow receiver is detected even while a
        // send is waiting, and extra connections can be opened.
        conn.monitor = setInterval(function() {
          if (conn.dead) return;
          if (conn.ws.bufferedAmount > highWaterMark) {
            if (!conn.saturated) {
              conn.saturated = true;
              maybeConnect();
            }
          } else if (conn.saturated
              && conn.ws.bufferedAmount < lowWaterMark) {
            conn.saturated = false;
            schedulePending();
          }
        }, 50);
        if (conn.monitor.unref) conn.monitor.unref();
        resolve(conn);
        schedulePending();
      });
      ws.on('error', function(error) {
        if (!opened) { release(); reject(error); return; }
        failConnection(conn, error);
      });
      ws.on('close', function() {
        if (!opened) {
          release();
          reject(new Error('connection closed during handshake'));
          return;
        }
        failConnection(conn, new Error('connection closed'));
      });
      ws.on('message', function(data, isBinary) {
        if (!isBinary) handleMessage(conn, data);
      });
    });
  }

  async function pump(conn) {
    if (conn.pumpRunning || conn.dead) return;
    conn.pumpRunning = true;
    try {
      while (!closed && conn.open && conn.streams.size > 0) {
        if (conn.ws.bufferedAmount > highWaterMark) {
          if (!conn.saturated) {
            conn.saturated = true;
            maybeConnect();
          }
          await delay(2);
          continue;
        }
        if (conn.saturated && conn.ws.bufferedAmount < lowWaterMark) {
          conn.saturated = false;
          schedulePending();
        }
        var ids = Array.from(conn.streams.keys());
        var progressed = false;
        var readable = false;
        for (var i = 0; i < ids.length; i++) {
          var stream = conn.streams.get(ids[i]);
          if (!stream || stream.settled || stream.phase != 'streaming') continue;
          readable = true;
          if (conn.ws.bufferedAmount > highWaterMark) {
            if (!conn.saturated) {
              conn.saturated = true;
              maybeConnect();
            }
            break;
          }
          if (stream.size == 0) {
            stream.phase = 'waitingEnd';
            try {
              await sendMessage(conn, {type: 'end', id: stream.id});
            } catch (error) {
              failStream(conn, stream, error);
            }
            continue;
          }
          if (!stream.reader) {
            stream.reader = fs.createReadStream(stream.job.file, {
              start: 0,
              end: stream.size - 1,
              highWaterMark: CHUNK_SIZE
            })[Symbol.asyncIterator]();
          }
          var result;
          try {
            result = await stream.reader.next();
          } catch (error) {
            failStream(conn, stream, error);
            continue;
          }
          if (result.done) {
            stream.phase = 'waitingEnd';
            try {
              await sendMessage(conn, {type: 'end', id: stream.id});
            } catch (error) {
              failStream(conn, stream, error);
            }
            continue;
          }
          try {
            await sendChunk(conn, stream.id, result.value);
          } catch (error) {
            failStream(conn, stream, error);
            continue;
          }
          armStreamTimer(conn, stream);
          progressed = true;
        }
        if (!readable) break;
        if (!progressed) await delay(2);
      }
    } finally {
      conn.pumpRunning = false;
    }
  }

  async function attach(conn, stream) {
    conn.streams.set(stream.id, stream);
    armStreamTimer(conn, stream);
    try {
      await sendMessage(conn, stream.announce());
    } catch (error) {
      failStream(conn, stream, error);
      return;
    }
    pump(conn);
  }

  function hasLiveConnection() {
    for (var i = 0; i < connections.length; i++) {
      if (connections[i].open && !connections[i].dead) return true;
    }
    return false;
  }

  function pickConnection() {
    var best = null;
    for (var i = 0; i < connections.length; i++) {
      var conn = connections[i];
      if (!conn.open || conn.dead || conn.saturated) continue;
      if (!best || conn.streams.size < best.streams.size) best = conn;
    }
    return best;
  }

  function rejectPending(error) {
    error.retryable = true;
    var waiting = pending.splice(0);
    for (var i = 0; i < waiting.length; i++) {
      if (waiting[i].settled) continue;
      waiting[i].settled = true;
      waiting[i].reject(error);
    }
  }

  function maybeConnect() {
    if (closed) return;
    if (connections.length + connecting >= maxConnections) return;
    if (connections.length + connecting === 0) {
      connect().catch(function(error) {
        if (connections.length === 0 && connecting === 0) rejectPending(error);
      });
      return;
    }
    // wait for connections that are still being established
    if (!hasLiveConnection()) return;
    // every live connection is saturated: open another one
    var saturated = true;
    for (var i = 0; i < connections.length; i++) {
      var conn = connections[i];
      if (conn.open && !conn.dead && !conn.saturated) { saturated = false; break; }
    }
    if (!saturated) return;
    connect().catch(function(error) {
      if (connections.length === 0 && connecting === 0) rejectPending(error);
    });
  }

  function schedulePending() {
    if (closed) return;
    while (pending.length > 0) {
      var stream = pending.shift();
      if (stream.settled) continue;
      var conn = pickConnection();
      if (conn) {
        attach(conn, stream);
        continue;
      }
      pending.unshift(stream);
      maybeConnect();
      return;
    }
  }

  function send(job, info) {
    return new Promise(function(resolve, reject) {
      if (closed) {
        var error = new Error('uploader is closed');
        error.retryable = false;
        reject(error);
        return;
      }
      var stream = {
        id: nextStreamId++,
        job: job,
        size: info.size,
        sha256: info.sha256,
        resolve: resolve,
        reject: reject,
        settled: false,
        phase: 'announce',
        reader: null,
        announce: function() {
          return {
            type: 'upload',
            id: this.id,
            hostname: identity.hostname,
            hostkey: identity.hostkey || undefined,
            username: job.username,
            session: job.sessioncookie,
            kind: job.kind,
            size: info.size,
            sha256: info.sha256,
            startdate: info.startdate,
            finished: job.finished !== false
          };
        }
      };
      var conn = pickConnection();
      if (conn) {
        attach(conn, stream);
      } else {
        pending.push(stream);
        maybeConnect();
      }
    });
  }

  function close() {
    closed = true;
    var error = new Error('uploader is closed');
    error.retryable = false;
    var waiting = pending.splice(0);
    for (var i = 0; i < waiting.length; i++) {
      if (waiting[i].settled) continue;
      waiting[i].settled = true;
      waiting[i].reject(error);
    }
    var list = connections.splice(0);
    for (var j = 0; j < list.length; j++) {
      var conn = list[j];
      conn.dead = true;
      conn.open = false;
      if (conn.monitor) clearInterval(conn.monitor);
      try { conn.ws.close(); } catch (ignored) {}
    }
  }

  return {
    send: send,
    close: close,
    connectionCount: function() { return connections.length; }
  };
}

/**
 * Uploads session logs to a remote receiver: active logs as periodic snapshots
 * and finished logs as their final copy. The remote server is identified by
 * hostname and an optional hostkey. Checkpoints stay local. See RECEIVER.md for
 * the protocol.
 */
function createUploader(config, options) {
  options = options || {};
  var baseDir = options.baseDir || __dirname;

  var enabled = configBool(config, 'upload_enabled', false);
  var url = config.upload_url ? String(config.upload_url) : '';
  var hostname = config.upload_hostname
    ? String(config.upload_hostname)
    : os.hostname();
  var hostkey = config.upload_hostkey ? String(config.upload_hostkey) : '';
  var maxConnections = Math.max(1, configInt(config, 'upload_connections',
    DEFAULT_CONNECTIONS));
  var highWaterMark = Math.max(64 * 1024, configInt(config,
    'upload_high_water_bytes', DEFAULT_HIGH_WATER_MARK));
  var target = null;
  var ca = null;

  if (enabled) {
    try {
      target = websocketUrl(url);
    } catch (error) {
      throw new Error('invalid upload_url "' + url + '": ' + error.message);
    }
    if (config.upload_ca) {
      var caPath = path.resolve(baseDir, String(config.upload_ca));
      ca = fs.readFileSync(caPath);
    }
  }

  var transport = enabled
    ? createTransport(target, ca, {hostname: hostname, hostkey: hostkey},
        maxConnections, highWaterMark)
    : null;

  var state = {
    active: 0,
    stopped: false,
    queue: [],
    uploaded: {},
    idleWaiters: []
  };

  function log(message) {
    console.log('[uploader] ' + message);
  }

  function notifyIdle() {
    if (state.active > 0 || state.queue.length > 0) return;
    var waiters = state.idleWaiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i]();
  }

  function uploaded(job) {
    if (!job.onUploaded) return;
    try {
      job.onUploaded(job.file);
    } catch (error) {
      console.error('[uploader] upload callback failed: ' + error.message);
    }
  }

  async function runJob(job) {
    var key = job.kind + ':' + job.username + ':' + job.sessioncookie;
    var success = false;
    try {
      var info;
      try {
        info = await hashFileStream(job.file);
      } catch (error) {
        if (error.code == 'ENOENT') {
          log('skipping missing ' + job.file);
          return;
        }
        throw error;
      }
      info.startdate = await readStartDate(job.file);
      if (state.uploaded[key] == info.sha256) {
        uploaded(job);
        success = true;
        return;
      }

      for (var attempt = 0; ; attempt++) {
        try {
          await transport.send(job, info);
          state.uploaded[key] = info.sha256;
          log('uploaded ' + job.kind + ' for ' + job.username + '/'
            + job.sessioncookie + ' (' + info.size + ' bytes)');
          uploaded(job);
          success = true;
          return;
        } catch (error) {
          if (error.retryable === false) {
            log('upload rejected for ' + job.kind + ' ' + job.username + '/'
              + job.sessioncookie + ': ' + error.message);
            return;
          }
          if (attempt + 1 >= MAX_ATTEMPTS) {
            console.error('[uploader] giving up on ' + job.kind + ' for '
              + job.username + '/' + job.sessioncookie + ': ' + error.message);
            return;
          }
          var wait = RETRY_BASE_MS * Math.pow(2, attempt);
          log(job.kind + ' upload failed (' + error.message + '), retrying in '
            + wait + 'ms');
          await delay(wait);
        }
      }
    } finally {
      if (job.onDone) {
        try {
          job.onDone(job.file, success);
        } catch (error) {
          console.error('[uploader] done callback failed: ' + error.message);
        }
      }
    }
  }

  function pump() {
    while (!state.stopped && state.active < maxConnections
        && state.queue.length > 0) {
      var job = state.queue.shift();
      state.active++;
      runJob(job).catch(function(error) {
        console.error('[uploader] unexpected error: ' + error.message);
      }).then(function() {
        state.active--;
        notifyIdle();
        pump();
      });
    }
    notifyIdle();
  }

  function enqueue(job) {
    if (!enabled || !job.file || state.stopped) return;
    state.queue.push(job);
    pump();
  }

  return {
    enabled: enabled,
    hostname: hostname,
    hasHostkey: !!hostkey,
    maxConnections: maxConnections,
    upload_log: function(username, sessioncookie, file, finished, onUploaded,
      onDone) {
      enqueue({kind: 'log', username: username, sessioncookie: sessioncookie,
        file: file, finished: finished !== false, onUploaded: onUploaded,
        onDone: onDone});
    },
    idle: function() {
      if (state.active == 0 && state.queue.length == 0) return Promise.resolve();
      return new Promise(function(resolve) { state.idleWaiters.push(resolve); });
    },
    close: function() {
      state.stopped = true;
      if (transport) transport.close();
    }
  };
}

function resolveSessionDir(config) {
  return config.session_dir
    ? path.resolve(__dirname, config.session_dir)
    : path.join(__dirname, 'sessions');
}

/**
 * Lists the session logs in session_dir. Active logs are uploaded as
 * snapshots; once server.js renames a log to <sessioncookie>.json.done its
 * final copy is uploaded. Checkpoints stay on the wslogin host.
 */
async function listSessionFiles(sessionDir, template) {
  template = template || '<username>/<session>.json';
  var entries = [];
  async function walk(dir, relative) {
    var items;
    try {
      items = await fs.promises.readdir(dir, {withFileTypes: true});
    } catch (error) {
      if (relative == '' && error.code == 'ENOENT') return;
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var rel = relative ? relative + '/' + item.name : item.name;
      if (item.isDirectory()) {
        await walk(path.join(dir, item.name), rel);
        continue;
      }
      if (!item.isFile()) continue;
      var finished = item.name.endsWith(FINISHED_SUFFIX);
      var activeRel = finished
        ? rel.slice(0, -FINISHED_SUFFIX.length) : rel;
      if (!activeRel.endsWith(LOG_SUFFIX)) continue;
      if (activeRel.endsWith(CHECKPOINT_LOG_SUFFIX)) continue;
      var values = matchTemplate(template, activeRel, ['username', 'session']);
      if (!values) continue;
      entries.push({
        kind: 'log',
        username: values.username,
        sessioncookie: values.session,
        file: path.join(dir, item.name),
        finished: finished
      });
    }
  }
  await walk(sessionDir, '');
  return entries;
}

/**
 * Scans session_dir and uploads active and finished session logs. Runs as its
 * own process so uploads can never interfere with server.js.
 */
async function run(config, options) {
  options = options || {};
  var uploader = createUploader(config, {baseDir: __dirname});
  if (!uploader.enabled) {
    console.log('uploads are disabled (upload_enabled=false)');
    return 0;
  }

  var sessionDir = resolveSessionDir(config);
  var sessionTemplate = config.session_template
    ? String(config.session_template)
    : '<username>/<session>.json';
  var interval = Math.max(1, configInt(config, 'upload_interval_seconds', 60));
  var uploadActive = configBool(config, 'upload_active_enabled', true);
  var removeUploaded = configBool(config, 'upload_remove_uploaded', false);
  var activeInterval = Math.max(1,
    configInt(config, 'upload_active_interval_seconds', 1));
  var debounceMs = Math.max(50,
    configInt(config, 'upload_watch_debounce_ms', 500));
  var seen = new Map();
  var lastActive = new Map();
  var busy = new Set();
  var pending = new Map();
  var stopping = false;
  var timer = null;
  var scanTimer = null;
  var watcher = null;
  var scanning = false;
  var scanAgain = false;

  console.log('uploading active and finished sessions matching '
    + sessionTemplate + ' from ' + sessionDir + ' to ' + config.upload_url
    + ' as host ' + uploader.hostname
    + (uploader.hasHostkey ? ' with hostkey' : ' without hostkey')
    + ' (up to ' + uploader.maxConnections + ' connections)');
  if (!uploadActive) {
    console.log('uploading active sessions is disabled '
      + '(upload_active_enabled=false)');
  }

  function markUploaded(file) {
    if (!file.endsWith(FINISHED_SUFFIX)) return;
    if (removeUploaded) {
      var checkpointFile = file.slice(0,
        -FINISHED_SUFFIX.length - LOG_SUFFIX.length) + CHECKPOINT_LOG_SUFFIX;
      [file, checkpointFile].forEach(function(target) {
        fs.promises.unlink(target).catch(function(error) {
          if (error.code != 'ENOENT') {
            console.error('[uploader] cannot remove ' + target + ': '
              + error.message);
          }
        });
      });
      return;
    }
    var uploadedFile = file.slice(0, -FINISHED_SUFFIX.length) + UPLOADED_SUFFIX;
    fs.promises.rename(file, uploadedFile).catch(function(error) {
      console.error('[uploader] cannot mark ' + file + ' as uploaded: '
        + error.message);
    });
  }

  // Uploads of one session are serialized so a slow snapshot can never
  // overwrite a newer one on the receiver. When the log changes while an
  // upload is running, only the latest entry is kept and uploaded afterwards.
  function sessionKey(entry) {
    return entry.kind + ':' + entry.username + ':' + entry.sessioncookie;
  }

  function scheduleUpload(entry) {
    if (stopping) return;
    var key = sessionKey(entry);
    if (busy.has(key)) {
      pending.set(key, entry);
      return;
    }
    busy.add(key);
    uploader.upload_log(entry.username, entry.sessioncookie, entry.file,
      entry.finished, markUploaded, function(file, success) {
        busy.delete(key);
        if (!success && entry.finished) {
          // Let the next scan retry a finished log that failed to upload.
          seen.delete(file);
        }
        var next = pending.get(key);
        if (!next) return;
        pending.delete(key);
        scheduleUpload(next);
      });
  }

  async function scan() {
    if (stopping) return;
    if (scanning) {
      scanAgain = true;
      return;
    }
    scanning = true;
    try {
      var entries;
      try {
        entries = await listSessionFiles(sessionDir, sessionTemplate);
      } catch (error) {
        console.error('[uploader] cannot read ' + sessionDir + ': '
          + error.message);
        return;
      }
      var present = new Set();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        present.add(entry.file);
        var stat;
        try {
          stat = await fs.promises.stat(entry.file);
        } catch (error) {
          continue;
        }
        var stamp = stat.size + ':' + stat.mtimeMs;
        if (seen.get(entry.file) == stamp) continue;
        if (!entry.finished) {
          if (!uploadActive) continue;
          var last = lastActive.get(entry.file) || 0;
          if (Date.now() - last < activeInterval * 1000) continue;
          lastActive.set(entry.file, Date.now());
        }
        seen.set(entry.file, stamp);
        scheduleUpload(entry);
      }
      seen.forEach(function(value, file) {
        if (!present.has(file)) seen.delete(file);
      });
      lastActive.forEach(function(value, file) {
        if (!present.has(file)) lastActive.delete(file);
      });
    } finally {
      scanning = false;
      if (scanAgain && !stopping) {
        scanAgain = false;
        requestScan(0);
      }
    }
  }

  // Coalesce a burst of filesystem events into one scan. Events that arrive
  // while a scan is already scheduled are ignored, so a session producing
  // output continuously is still scanned at a bounded rate.
  function requestScan(delay) {
    if (stopping || scanTimer) return;
    scanTimer = setTimeout(function() {
      scanTimer = null;
      scan().catch(function(error) {
        console.error('[uploader] scan failed: ' + error.message);
      });
    }, delay);
  }

  function closeWatcher() {
    if (!watcher) return;
    var current = watcher;
    watcher = null;
    try { current.close(); } catch (ignored) {}
  }

  function startWatcher() {
    if (stopping || watcher) return;
    try {
      watcher = fs.watch(sessionDir, {recursive: true}, function() {
        requestScan(debounceMs);
      });
      watcher.on('error', function(error) {
        console.error('[uploader] file monitor failed: ' + error.message);
        closeWatcher();
      });
      console.log('monitoring ' + sessionDir + ' for changes');
    } catch (error) {
      watcher = null;
      console.error('[uploader] cannot monitor ' + sessionDir + ': '
        + error.message + ' (falling back to a scan every ' + interval + 's)');
    }
  }

  // The interval is a safety net for missed filesystem events; normal uploads
  // are triggered by the file monitor.
  function schedule() {
    if (stopping) return;
    timer = setTimeout(function() {
      timer = null;
      if (!watcher) startWatcher();
      scan().then(function() {
        schedule();
      }, function(error) {
        console.error('[uploader] scan failed: ' + error.message);
        schedule();
      });
    }, interval * 1000);
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (scanTimer) clearTimeout(scanTimer);
    closeWatcher();
    pending.clear();
    uploader.idle().then(function() {
      uploader.close();
      process.exit(0);
    });
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await scan();
  if (options.once) {
    await uploader.idle();
    uploader.close();
    return 0;
  }
  startWatcher();
  schedule();
  return new Promise(function() {});
}

module.exports = {
  createUploader: createUploader,
  listSessionFiles: listSessionFiles,
  resolveSessionDir: resolveSessionDir,
  run: run
};

if (require.main === module) {
  var ini = require('ini');
  var configPath = process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini';
  if (!fs.existsSync(configPath)) {
    console.error('configuration file not found: ' + configPath);
    process.exit(1);
  }
  var config = ini.parse(fs.readFileSync(configPath, 'utf-8', true));
  console.log('using configuration file ' + configPath);
  var once = process.argv.indexOf('--once') != -1;
  run(config, {once: once}).then(function(code) {
    if (once) process.exit(code);
  }, function(error) {
    console.error('[uploader] ' + error.message);
    process.exit(1);
  });
}
