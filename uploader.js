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
const MAX_UPLOADED_TRACKED = 10000;
const MIN_ACTIVE_SNAPSHOT_MS = 250;

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

// Session meta (viewid/share links) travels inside the log as its header
// record; the whole file is uploaded, so nothing extra is announced.
/**
 * Multiplexes uploads over one or more WebSocket connections. Several streams
 * (files) can be interleaved on a single connection. When a connection cannot
 * keep up with the receiver (its send buffer stays above the high water mark)
 * it is marked saturated and additional connections are opened, up to
 * maxConnections, so uploads are spread out.
 */
function createTransport(target, ca, identity, maxConnections, highWaterMark,
  onReconnect, onDisconnect, verbose) {
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
    if (!closed) {
      schedulePending();
      // The last live connection is gone: the receiver's state is unknown
      // again, so drop the local belief and let the caller rescan. The
      // resulting uploads reconnect and re-announce every present log.
      if (!hasLiveConnection() && onDisconnect) {
        try { onDisconnect(); } catch (ignored) {}
      }
      ensureConnection();
    }
  }

  // The server reports the state of the file it already has for a stream. The
  // announce carries our size, hash and file pointer (offset). A full match is
  // confirmed with synced:true (no data, no second roundtrip). When the stored
  // size equals our pointer the server appends the tail we stream. When it
  // cannot honor the pointer it reports its real size (the go-wrong signal) and
  // we upload in full. In non-verbose mode the server is silent for the normal
  // append, so we stream the tail optimistically and react to a go-wrong report
  // arriving from the announce or from end.
  function handleState(conn, stream, message) {
    if (stream.settled || stream.phase == 'reset') return;
    if (message.synced === true) {
      conn.streams.delete(stream.id);
      stream.settled = true;
      stream.phase = 'synced';
      clearStreamTimer(stream);
      stream.resolve();
      schedulePending();
      return;
    }
    var replace = stream.job.finished === false || message.finished !== true;
    // Non-verbose optimistic append: the server is silent when it appends, so
    // any state that arrives after we started streaming the tail is a go-wrong
    // report. Re-send the whole file in full.
    if (stream.phase == 'streaming' || stream.phase == 'waitingEnd') {
      resetToFull(conn, stream, replace);
      return;
    }
    var goWrong = message.exists === false
      || (message.exists === true && message.size !== stream.offset);
    if (goWrong) {
      resetToFull(conn, stream, replace);
      return;
    }
    // exists and size equals our pointer: append. Verbose confirms it here;
    // non-verbose is silent and is already streaming the tail.
    if (stream.phase == 'announce') {
      armStreamTimer(conn, stream);
      stream.start = stream.offset;
      stream.phase = 'streaming';
      pump(conn);
    }
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
        // A connection opened when none was live is a (re)connect: the local
        // view of what the receiver already has is no longer trusted, so the
        // caller resyncs it and re-announces every present log.
        var firstLive = !hasLiveConnection();
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
        if (firstLive && onReconnect) {
          try { onReconnect(); } catch (ignored) {}
        }
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
          if (stream.size - (stream.start || 0) == 0) {
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
              start: stream.start || 0,
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
    // Non-verbose: the receiver is silent when it can append, so start the tail
    // right away. A go-wrong state (from the announce or from end) resets us to
    // a full upload. Verbose: wait for the state reply before sending anything.
    if (!verbose && stream.offset > 0) {
      stream.start = stream.offset;
      stream.phase = 'streaming';
    }
    pump(conn);
  }

  // A go-wrong report (pointer not honored): stop the optimistic tail, tell the
  // server to reset, and re-send the whole file from the start.
  function resetToFull(conn, stream, replace) {
    if (stream.reader && stream.reader.return) {
      try { stream.reader.return(); } catch (ignored) {}
    }
    stream.reader = null;
    stream.start = 0;
    stream.phase = 'reset';
    sendMessage(conn, {type: replace ? 'replace' : 'corrupt', id: stream.id})
      .then(function() {
        stream.phase = 'streaming';
        armStreamTimer(conn, stream);
        pump(conn);
      }, function(error) {
        failStream(conn, stream, error);
      });
  }

  function hasLiveConnection() {
    for (var i = 0; i < connections.length; i++) {
      if (connections[i].open && !connections[i].dead) return true;
    }
    return false;
  }

  // After the last live connection is lost the uploader stays connected to the
  // receiver even while idle, so a dropped link is noticed and re-established
  // and the reconnect resyncs the receiver's state.
  function ensureConnection() {
    if (closed || hasLiveConnection() || connecting > 0) return;
    connect().catch(function(error) {
      if (connections.length === 0 && connecting === 0) rejectPending(error);
    });
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
        offset: info.offset || 0,
        start: 0,
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
            offset: info.offset || 0,
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
  var debug = configBool(config, 'upload_debug', false);
  var verbose = configBool(config, 'upload_append_verbose', false);
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
      try {
        ca = fs.readFileSync(caPath);
      } catch (error) {
        throw new Error('cannot read upload_ca "' + caPath + '": '
          + error.message);
      }
    }
  }

  function resync() {
    // The receiver's state is unknown again: forget what we thought it had and
    // let the caller rescan, so every present log is re-announced and the
    // receiver's true state is re-synced.
    state.uploaded = new Map();
    if (options.onReconnect) {
      try { options.onReconnect(); } catch (ignored) {}
    }
  }

  var transport = enabled
    ? createTransport(target, ca, {hostname: hostname, hostkey: hostkey},
        maxConnections, highWaterMark, resync, resync, verbose)
    : null;

  var state = {
    active: 0,
    stopped: false,
    queue: [],
    uploaded: new Map(),
    idleWaiters: []
  };

  function log(message) {
    console.log('[uploader] ' + message);
  }

  // High-volume per-upload lines are only shown when upload_debug is on.
  function debugLog(message) {
    if (debug) console.log('[uploader] ' + message);
  }

  function notifyIdle() {
    if (state.active > 0 || state.queue.length > 0) return;
    var waiters = state.idleWaiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i]();
  }

  function callUploaded(job) {
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
          debugLog('skipping missing ' + job.file);
          return;
        }
        throw error;
      }
      info.startdate = await readStartDate(job.file);
      var stored = state.uploaded.get(key);
      if (stored && stored.sha256 === info.sha256) {
        callUploaded(job);
        success = true;
        return;
      }
      // File pointer: the number of bytes the receiver is known to hold. An
      // active log only grows, so the last snapshot is a prefix of this file
      // and only the tail after the pointer has to be sent. The receiver
      // appends that tail by default; it only reports back (its real size) when
      // the pointer cannot be honored, which makes us upload in full. A
      // finished log is the final copy and is always sent in full.
      var pointer = 0;
      if (stored && job.finished === false && stored.offset <= info.size) {
        pointer = stored.offset;
      }
      info.offset = pointer;

      for (var attempt = 0; ; attempt++) {
        try {
          await transport.send(job, info);
          state.uploaded.set(key, {offset: info.size, sha256: info.sha256});
          if (state.uploaded.size > MAX_UPLOADED_TRACKED) {
            state.uploaded.delete(state.uploaded.keys().next().value);
          }
          debugLog('uploaded ' + job.kind + ' for ' + job.username + '/'
            + job.sessioncookie + ' (' + info.size + ' bytes)');
          callUploaded(job);
          success = true;
          return;
        } catch (error) {
          if (state.stopped) return; // shutting down, fail quietly
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
          debugLog(job.kind + ' upload failed (' + error.message
            + '), retrying in ' + wait + 'ms');
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
      // Queued jobs are dropped; idle must not block on them. Their onDone
      // callbacks are not called and run() keeps its busy keys set.
      state.queue.length = 0;
      notifyIdle();
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
      if (activeRel.endsWith('.meta.json')) continue;
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
  var uploader = createUploader(config, {
    baseDir: __dirname,
    onReconnect: function() {
      // After a reconnect the receiver's state is unknown again: drop the
      // local scan cache and rescan so every present log is re-announced.
      seen.clear();
      requestScan(0);
    }
  });
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
  var seen = new Map();
  var busy = new Set();
  var pending = new Map();
  var lastActiveScheduled = new Map();
  var retryTimers = new Map();
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
    var wait = 0;
    if (!entry.finished) {
      // Floor the snapshot rate of chatty sessions so a continuous stream of
      // filesystem events does not turn into a continuous full-file upload.
      // The entry is kept in pending and retried when the floor expires, so
      // no change is ever dropped.
      var last = lastActiveScheduled.get(key) || 0;
      var nowms = Date.now();
      if (nowms - last < MIN_ACTIVE_SNAPSHOT_MS) {
        wait = MIN_ACTIVE_SNAPSHOT_MS - (nowms - last);
      }
    }
    if (wait > 0) {
      pending.set(key, entry);
      if (!retryTimers.has(key)) {
        var timer = setTimeout(function() {
          retryTimers.delete(key);
          var next = pending.get(key);
          if (next) {
            pending.delete(key);
            scheduleUpload(next);
          }
        }, wait);
        if (timer.unref) timer.unref();
        retryTimers.set(key, timer);
      }
      return;
    }
    if (!entry.finished) lastActiveScheduled.set(key, Date.now());
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
      var presentKeys = new Set();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        present.add(entry.file);
        presentKeys.add(sessionKey(entry));
        var stat;
        try {
          stat = await fs.promises.stat(entry.file);
        } catch (error) {
          continue;
        }
        var stamp = stat.size + ':' + stat.mtimeMs;
        if (seen.get(entry.file) == stamp) continue;
        if (!entry.finished && !uploadActive) continue;
        seen.set(entry.file, stamp);
        scheduleUpload(entry);
      }
      seen.forEach(function(value, file) {
        if (!present.has(file)) seen.delete(file);
      });
      lastActiveScheduled.forEach(function(value, key) {
        if (!presentKeys.has(key)) lastActiveScheduled.delete(key);
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
  // while a scan is running are picked up by a follow-up scan, so a snapshot
  // is taken as soon as the log is ready (data has arrived) and the previous
  // upload of that session has finished.
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
        requestScan(0);
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
    retryTimers.forEach(function(timer) { clearTimeout(timer); });
    retryTimers.clear();
    // Close the transport first so in-flight uploads fail fast instead of
    // waiting for their stream timeouts.
    uploader.close();
    uploader.idle().then(function() {
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
