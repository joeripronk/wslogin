#!/usr/bin/env node
'use strict';

// Session listing, playback streaming and checkpoint caching for wslogin-server.js.
//
// Logs written by wslogin-server.js are JSON lines: {"t":<epoch seconds>,"d":"...","c":N}
// where c=0 is a command (resize), c=1 terminal output, c=2 user input and c=3
// the exit status. The playback backend turns these logs into an NDJSON stream
// that the browser can apply to xterm.js. Checkpoints (rendered terminal state
// at a byte offset) are cached on disk so seeking does not replay from the
// start of a large session.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { render: renderTemplate, placeholders: templatePlaceholders,
  match: matchTemplate, isSafeRelative } = require('./template');
const { parseCookieHeader } = require('./auth');

const CACHE_VERSION = 4;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 60000;
const DEFAULT_CHECKPOINT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHECKPOINTS = 500;
const DEFAULT_IDLE_SKIP_SECONDS = 10;
const ACTIVITY_BUCKET_SECONDS = 1;
const ACTIVITY_BINS = 600;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const OSC_TITLE_RE = /\x1b\][012];([^\x07]*?)(?:\x07|\x1b\\)/g;
const PASSWORD_PROMPT_RE = /(?:password|passphrase|passwort|wachtwoord)[^\r\n:]{0,80}:\s*$/i;
const FOLLOW_POLL_MS = 100;
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const LOGIN_COOKIE = 'wslogin_playback';
const LOGIN_SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_SESSIONS = 1000;
const LOGIN_MAX_BODY = 8 * 1024;
const LOGIN_TOKEN_RE = /^[0-9a-f]{64}$/;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function configInt(config, name, fallback) {
  if (!(name in config)) return fallback;
  var value = parseInt(config[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function configBool(config, name, fallback) {
  if (!(name in config)) return fallback;
  var value = String(config[name]).toLowerCase();
  return !(value == '0' || value == 'false' || value == 'no' || value == 'off');
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function sendJson(response, status, value) {
  var body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function safeStaticPath(baseDir, relative) {
  var decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch (error) {
    return null;
  }
  var resolved = path.resolve(baseDir, '.' + path.sep + decoded);
  var root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Serves a file from baseDir. Used for the bundled viewer assets.
 */
function serveStatic(response, baseDir, relative) {
  var file = safeStaticPath(baseDir, relative);
  if (!file) {
    response.statusCode = 400;
    response.end('bad path');
    return;
  }
  fs.stat(file, function(error, stat) {
    if (error || !stat.isFile()) {
      response.statusCode = 404;
      response.end('');
      return;
    }
    var type = MIME_TYPES[path.extname(file).toLowerCase()]
      || 'application/octet-stream';
    response.setHeader('Content-Type', type);
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Length', stat.size);
    var stream = fs.createReadStream(file);
    stream.on('error', function() {
      if (!response.headersSent) response.statusCode = 500;
      response.end('');
    });
    stream.pipe(response);
  });
}

function terminalAt(checkpoint) {
  var terminal = new Terminal({
    allowProposedApi: true,
    cols: checkpoint.cols || 80,
    rows: checkpoint.rows || 24,
    scrollback: 2000
  });
  terminal.resize(checkpoint.cols || 80, checkpoint.rows || 24);
  if (checkpoint.serialized) terminal.write(checkpoint.serialized);
  return terminal;
}

function flushTerminal(terminal) {
  return new Promise(function(resolve) {
    terminal.write('', resolve);
  });
}

// The visible screen of a checkpoint, without its scrollback: a thumbnail
// renders the checkpoint's serialized state (which carries the full
// history for reconnects) into a headless terminal and serializes the
// viewport only.
async function thumbnailScreen(checkpoint) {
  var terminal = terminalAt(checkpoint);
  var serialize = new SerializeAddon();
  terminal.loadAddon(serialize);
  await flushTerminal(terminal);
  var s = serialize.serialize({scrollback:0});
  terminal.dispose();
  return s;
}

function parseRecord(line) {
  try {
    return JSON.parse(line.toString('utf-8'));
  } catch (error) {
    return null;
  }
}

function applyRecord(terminal, record) {
  if (!record || typeof record != 'object') return false;
  if (record.c === 1 && typeof record.d == 'string') {
    terminal.write(record.d);
    return false;
  }
  if (record.c === 0 && typeof record.d == 'string') {
    try {
      var command = JSON.parse(record.d);
      if (command.cmd == 'resize'
          && Number.isInteger(command.cols) && Number.isInteger(command.rows)
          && command.cols > 0 && command.rows > 0) {
        terminal.resize(command.cols, command.rows);
        return true;
      }
    } catch (error) {}
  }
  return false;
}

/**
 * Walks a file from start to end and calls onLine(line, nextOffset) for every
 * complete line. When final is true a trailing line without a newline is also
 * returned. The callback may be async; it is awaited so the terminal backlog
 * does not grow without bound.
 */
async function readLines(file, start, end, final, onLine) {
  if (end <= start) return start;
  var stream = fs.createReadStream(file, {
    start: start,
    end: end - 1,
    highWaterMark: 256 * 1024
  });
  var base = start;
  var pending = Buffer.alloc(0);
  for await (var chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    var index;
    while ((index = pending.indexOf(10)) >= 0) {
      var line = pending.subarray(0, index);
      var next = base + index + 1;
      await onLine(line, next);
      pending = pending.subarray(index + 1);
      base = next;
    }
  }
  if (pending.length > 0 && final) {
    var offset = base + pending.length;
    await onLine(pending, offset);
    base = offset;
  }
  return base;
}

function createPlayback(config, options) {
  options = options || {};
  var baseDir = options.baseDir || __dirname;
  var enabled = configBool(config, 'playback_enabled', true);
  var sessionDir = config.playback_session_dir
    ? path.resolve(baseDir, String(config.playback_session_dir))
    : (config.session_dir
      ? path.resolve(baseDir, String(config.session_dir))
      : path.join(baseDir, 'sessions'));
  var sessionTemplate = config.playback_session_template
    ? String(config.playback_session_template)
    : (config.session_template
      ? String(config.session_template)
      : '<username>/<session>.json');
  var archiveDir = config.playback_archive_dir
    ? path.resolve(baseDir, String(config.playback_archive_dir))
    : null;
  var archiveTemplate = config.playback_archive_template
    ? String(config.playback_archive_template)
    : '<%date YYYY-mm-dd>/<hostname>/<username>/<session>.json';
  var activeDir = config.playback_active_dir
    ? path.resolve(baseDir, String(config.playback_active_dir))
    : null;
  var activeTemplate = config.playback_active_template
    ? String(config.playback_active_template)
    : '<hostname>/<username>/<session>.json';
  var cacheDir = config.playback_cache_dir
    ? path.resolve(baseDir, String(config.playback_cache_dir))
    : path.join(baseDir, 'playback-cache');
  var wwwDir = config.playback_www_dir
    ? path.resolve(baseDir, String(config.playback_www_dir))
    : path.join(baseDir, 'sudovideo');
  var checkpointIntervalMs = Math.max(1000, configInt(config,
    'playback_checkpoint_interval_ms', DEFAULT_CHECKPOINT_INTERVAL_MS));
  var checkpointBytes = Math.max(64 * 1024, configInt(config,
    'playback_checkpoint_bytes', DEFAULT_CHECKPOINT_BYTES));
  var maxCheckpoints = Math.max(4, configInt(config,
    'playback_max_checkpoints', DEFAULT_MAX_CHECKPOINTS));
  var idleSkipSeconds = Math.max(0, configInt(config,
    'playback_idle_skip_seconds', DEFAULT_IDLE_SKIP_SECONDS));
  var idleSkipEnabled = idleSkipSeconds > 0
    && configBool(config, 'playback_idle_skip_enabled', true);
  var idleVideoDelaySeconds = Math.max(0, configInt(config,
    'playback_idle_video_delay_seconds', 5));
  var idleOverlayDelaySeconds = Math.max(0, Math.min(idleVideoDelaySeconds,
    configInt(config, 'playback_idle_overlay_delay_seconds', 1)));
  var idleAutoSkipSeconds = Math.max(0, configInt(config,
    'playback_idle_auto_skip_seconds', 10));
  var idleShowVideoSeconds = Math.max(0, configInt(config,
    'playback_idle_skip_seconds_show_video', 600));
  var idleMovieAutoSkipSeconds = Math.max(0, configInt(config,
    'playback_idle_movie_auto_skip_seconds', 0));
  var idleVideo = config.playback_idle_video
    ? String(config.playback_idle_video) : 'onehour.mp4';
  if (!isSafeRelative(idleVideo)) {
    throw new Error('playback_idle_video must be a relative path inside '
      + 'playback_www_dir: ' + idleVideo);
  }
  idleVideo = path.normalize(idleVideo).split(path.sep).join('/');
  var authRequired = configBool(config, 'playback_auth', true);
  var authService = config.playback_auth_service
    ? String(config.playback_auth_service) : 'sshd';
  var cookieSecure = configBool(config, 'playback_cookie_secure', true);
  var authenticate = options.authenticate || null;
  var sso = options.sso || null;
  var isActive = options.isActive || null;

  var templateNames = templatePlaceholders(sessionTemplate);
  templateNames.delete('username');
  templateNames.delete('session');
  if (templateNames.size > 0) {
    throw new Error('playback_session_template may only use <username> and '
      + '<session>: ' + sessionTemplate);
  }
  if (!sessionTemplate.endsWith('.json')) {
    throw new Error('playback_session_template must end in .json: '
      + sessionTemplate);
  }
  if (archiveDir) {
    var archiveNames = templatePlaceholders(archiveTemplate);
    archiveNames.delete('username');
    archiveNames.delete('session');
    archiveNames.delete('hostname');
    archiveNames.delete('date');
    if (archiveNames.size > 0) {
      throw new Error('playback_archive_template may only use <hostname>, '
        + '<username>, <session> and <%date FORMAT>: ' + archiveTemplate);
    }
    if (templatePlaceholders(archiveTemplate).has('hostname') == false) {
      throw new Error('playback_archive_template must contain <hostname>: '
        + archiveTemplate);
    }
    if (!archiveTemplate.endsWith('.json')) {
      throw new Error('playback_archive_template must end in .json: '
        + archiveTemplate);
    }
  }
  if (activeDir) {
    var activeNames = templatePlaceholders(activeTemplate);
    activeNames.delete('username');
    activeNames.delete('session');
    activeNames.delete('hostname');
    if (activeNames.size > 0) {
      throw new Error('playback_active_template may only use <hostname>, '
        + '<username> and <session>: ' + activeTemplate);
    }
    if (!activeTemplate.endsWith('.json')) {
      throw new Error('playback_active_template must end in .json: '
        + activeTemplate);
    }
  }

  var cacheStates = new Map();
  var metaCache = new Map();
  var loginSessions = new Map();
  // purge expired login sessions periodically: createLoginSession only
  // prunes when the map is over the limit, so below the limit expired
  // entries would accumulate indefinitely
  setInterval(function() {
    var nowms = Date.now();
    loginSessions.forEach(function(value, key) {
      if (value.expires <= nowms) loginSessions.delete(key);
    });
  }, 60000).unref();

  function log(message) {
    console.log('[playback] ' + message);
  }

  function cacheFileFor(file) {
    return path.join(cacheDir,
      crypto.createHash('sha256').update(file).digest('hex') + '.json');
  }

  function loadDiskCache(file) {
    var cacheFile = cacheFileFor(file);
    try {
      var data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (data && data.version === CACHE_VERSION && data.file === file
          && Array.isArray(data.checkpoints)) {
        data.tail = null;
        return data;
      }
    } catch (error) {}
    return null;
  }

  function saveDiskCache(file, data) {
    try {
      fs.mkdirSync(cacheDir, {recursive: true});
      var copy = {
        version: CACHE_VERSION,
        file: file,
        size: data.size,
        mtimeMs: data.mtimeMs,
        offset: data.offset,
        startdate: data.startdate,
        lastT: data.lastT,
        cols: data.cols,
        rows: data.rows,
      checkpoints: data.checkpoints,
      activity: data.activity,
      activityPasswordPrompt: data.activityPasswordPrompt,
      activityPromptTail: data.activityPromptTail,
      titleSeconds: data.titleSeconds,
      currentTitle: data.currentTitle,
      currentTitleT: data.currentTitleT
    };
      var tmp = cacheFileFor(file) + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(copy));
      fs.renameSync(tmp, cacheFileFor(file));
    } catch (error) {
      log('cannot write cache for ' + file + ': ' + error.message);
    }
  }

  function thinCheckpoints(checkpoints) {
    while (checkpoints.length > maxCheckpoints) {
      var kept = [];
      for (var i = 0; i < checkpoints.length; i++) {
        if (i % 2 == 0) kept.push(checkpoints[i]);
      }
      if (kept.length == checkpoints.length) break;
      checkpoints = kept;
    }
    return checkpoints;
  }

  function emptyActivity() {
    return {
      bucketSeconds: ACTIVITY_BUCKET_SECONDS,
      start: null,
      output: [],
      input: [],
      hidden: []
    };
  }

  function ensureActivity(activity) {
    if (!activity || !Array.isArray(activity.output)
        || !Array.isArray(activity.input)
        || !Array.isArray(activity.hidden)) {
      return emptyActivity();
    }
    if (!Number.isFinite(activity.bucketSeconds)
        || activity.bucketSeconds <= 0) {
      activity.bucketSeconds = ACTIVITY_BUCKET_SECONDS;
    }
    return activity;
  }

  function growActivity(values, index) {
    while (values.length <= index) values.push(0);
  }

  function addActivity(data, record, hiddenInput) {
    if (!Number.isFinite(record.t) || record.t <= 0) return;
    var activity = data.activity || (data.activity = emptyActivity());
    if (activity.start == null) activity.start = record.t;
    var index = Math.floor((record.t - activity.start)
      / activity.bucketSeconds);
    if (index < 0) index = 0;
    if (record.c == 1) {
      growActivity(activity.output, index);
      activity.output[index] += Buffer.byteLength(String(record.d || ''), 'utf8');
    } else if (record.c == 2) {
      if (hiddenInput) {
        growActivity(activity.hidden, index);
        activity.hidden[index] += 1;
      } else {
        growActivity(activity.input, index);
        activity.input[index] += 1;
      }
    }
  }

function stripAnsi(value) {
  return String(value || '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '');
}

function extractTitles(text) {
  var titles = [];
  OSC_TITLE_RE.lastIndex = 0;
  var found;
  while ((found = OSC_TITLE_RE.exec(String(text || '')))) {
    var title = found[1].replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (title) titles.push(title.slice(0, 128));
  }
  return titles;
}

function addTitleSpan(titles, title, start, end) {
  if (!title || !Number.isFinite(start) || !Number.isFinite(end)
      || end <= start) return;
  titles[title] = (titles[title] || 0) + (end - start);
}

function titleDescription(titles, lastTitle) {
  var ranked = Object.keys(titles || {})
    .map(function(title) { return {title: title, seconds: titles[title]}; })
    .filter(function(item) { return item.title && item.seconds >= 1; })
    .sort(function(a, b) { return b.seconds - a.seconds; });
  var parts = ranked.slice(0, 3).map(function(item) { return item.title; });
  if (lastTitle && parts.indexOf(lastTitle) == -1) parts.push(lastTitle);
  return parts.join(' | ');
}

  function updatePasswordPrompt(data, value) {
    var text = stripAnsi((data.activityPromptTail || '') + String(value || ''))
      .replace(/\r\n?/g, '\n');
    var line = text.split('\n').pop() || '';
    data.activityPromptTail = line.slice(-256);
    data.activityPasswordPrompt = PASSWORD_PROMPT_RE.test(
      line.replace(/\s+$/, ''));
  }

  function normalizeActivity(activity, start, end) {
    if (!activity || !Number.isFinite(start) || !Number.isFinite(end)
        || end <= start) return null;
    var source = ensureActivity(activity);
    var sourceStart = Number.isFinite(source.start) ? source.start : start;
    var bucketSeconds = source.bucketSeconds;
    var span = end - start;
    var output = new Array(ACTIVITY_BINS).fill(0);
    var input = new Array(ACTIVITY_BINS).fill(0);
    var hidden = new Array(ACTIVITY_BINS).fill(0);
    var maxLength = Math.max(source.output.length, source.input.length,
      source.hidden.length);
    for (var bin = 0; bin < ACTIVITY_BINS; bin++) {
      var binStart = start + span * bin / ACTIVITY_BINS;
      var binEnd = start + span * (bin + 1) / ACTIVITY_BINS;
      var first = Math.floor((binStart - sourceStart) / bucketSeconds);
      var last = Math.ceil((binEnd - sourceStart) / bucketSeconds) - 1;
      if (first < 0) first = 0;
      if (last < first) last = first;
      if (first >= maxLength) continue;
      if (last >= maxLength) last = maxLength - 1;
      for (var index = first; index <= last; index++) {
        var bucketStart = sourceStart + index * bucketSeconds;
        var bucketEnd = bucketStart + bucketSeconds;
        var overlap = Math.min(binEnd, bucketEnd)
          - Math.max(binStart, bucketStart);
        if (overlap <= 0) continue;
        var fraction = overlap / bucketSeconds;
        if (index < source.output.length) {
          output[bin] += (source.output[index] || 0) * fraction;
        }
        if (index < source.input.length) {
          input[bin] += (source.input[index] || 0) * fraction;
        }
        if (index < source.hidden.length) {
          hidden[bin] += (source.hidden[index] || 0) * fraction;
        }
      }
    }
    function normalize(values) {
      var maximum = 0;
      for (var i = 0; i < values.length; i++) {
        if (values[i] > maximum) maximum = values[i];
      }
      if (maximum <= 0) return values;
      return values.map(function(value) {
        return Math.round(value / maximum * 100);
      });
    }
    return {
      start: start,
      end: end,
      bins: ACTIVITY_BINS,
      output: normalize(output),
      input: normalize(input),
      hidden: normalize(hidden)
    };
  }

  function lastCheckpointBefore(data, time) {
    var found = null;
    for (var i = 0; i < data.checkpoints.length; i++) {
      var checkpoint = data.checkpoints[i];
      if (checkpoint.t <= time) found = checkpoint;
      else break;
    }
    return found;
  }

  // Returns a terminal restored to data.offset (the end of the cached data),
  // either from the in-memory tail or from the last checkpoint plus replay.
  async function restoreTerminal(file, data) {
    var base = data.tail && data.tail.offset <= data.offset
      ? data.tail
      : lastCheckpointBefore(data, Infinity);
    var terminal;
    var start;
    if (base && base.serialized) {
      terminal = terminalAt(base);
      start = base.offset;
    } else {
      terminal = terminalAt({cols: 80, rows: 24});
      start = 0;
    }
    if (start < data.offset) {
      await readLines(file, start, data.offset, false, async function(line) {
        applyRecord(terminal, parseRecord(line));
      });
      await flushTerminal(terminal);
    }
    return {terminal: terminal, offset: start};
  }

  function addTitleTitles(data, record) {
    if (record.c != 1 || !Number.isFinite(record.t)) return;
    var titles = extractTitles(record.d);
    for (var i = 0; i < titles.length; i++) {
      if (data.currentTitle != null) {
        addTitleSpan(data.titleSeconds, data.currentTitle,
          data.currentTitleT, record.t);
      }
      data.currentTitle = titles[i];
      data.currentTitleT = record.t;
    }
  }

  async function buildCache(file, username, session, stat, existing) {
    var data = existing || {
      version: CACHE_VERSION,
      file: file,
      username: username,
      session: session,
      offset: 0,
      size: 0,
      mtimeMs: 0,
      startdate: null,
      lastT: null,
      cols: 80,
      rows: 24,
      checkpoints: [],
      tail: null,
      activity: emptyActivity(),
      activityPasswordPrompt: false,
      activityPromptTail: '',
      titleSeconds: {},
      currentTitle: null,
      currentTitleT: null
    };
    var terminal = terminalAt({cols: 80, rows: 24});
    var serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    var lastCheckpointOffset = 0;
    var lastCheckpointTime = null;
    // The replay terminal starts at the 80x24 default. Serializing a checkpoint
    // before the session's first resize record wraps wide output at 80 columns
    // and corrupts the lines, so only checkpoint once the real size is known.
    var seenResize = false;
    var final = isFinishedFile(file);
    data.checkpoints = [];
    data.startdate = null;
    data.lastT = null;
    data.offset = 0;
    data.activity = emptyActivity();
    data.activityPasswordPrompt = false;
    data.activityPromptTail = '';
    data.titleSeconds = {};
    data.currentTitle = null;
    data.currentTitleT = null;

    await readLines(file, 0, stat.size, final, async function(line, next) {
      data.offset = next;
      var record = parseRecord(line);
      if (!record) return;
      if (Number.isFinite(record.t) && record.t > 0) {
        if (data.startdate == null) data.startdate = record.t;
        data.lastT = record.t;
      }
      if (record.c == 1) updatePasswordPrompt(data, record.d);
      addTitleTitles(data, record);
      var hiddenInput = record.c == 2
        && (record.h === 1 || record.hidden === true
          || data.activityPasswordPrompt);
      addActivity(data, record, hiddenInput);
      if (hiddenInput && /[\r\n]/.test(String(record.d || ''))) {
        data.activityPasswordPrompt = false;
        data.activityPromptTail = '';
      }
      if (applyRecord(terminal, record)) seenResize = true;
      var dueByTime = Number.isFinite(record.t)
        && (lastCheckpointTime == null
          || (record.t - lastCheckpointTime) * 1000 >= checkpointIntervalMs);
      var dueByBytes = next - lastCheckpointOffset >= checkpointBytes;
      if ((dueByTime || dueByBytes) && seenResize) {
        await flushTerminal(terminal);
        var t = Number.isFinite(record.t) ? record.t : data.lastT;
        if (t != null) {
          data.checkpoints.push({
            t: t,
            offset: next,
            cols: terminal.cols,
            rows: terminal.rows,
            title: data.currentTitle,
            serialized: serialize.serialize()
          });
          lastCheckpointOffset = next;
          lastCheckpointTime = t;
        }
      }
    });
    await flushTerminal(terminal);
    if (data.currentTitle != null) {
      addTitleSpan(data.titleSeconds, data.currentTitle,
        data.currentTitleT, data.lastT);
    }
    data.checkpoints = thinCheckpoints(data.checkpoints);
    data.size = stat.size;
    data.mtimeMs = stat.mtimeMs;
    data.cols = terminal.cols;
    data.rows = terminal.rows;
    data.tail = {
      offset: data.offset,
      t: data.lastT,
      cols: terminal.cols,
      rows: terminal.rows,
      title: data.currentTitle,
      serialized: serialize.serialize()
    };
    return data;
  }

  async function appendCache(file, data, stat) {
    var restored = await restoreTerminal(file, data);
    var terminal = restored.terminal;
    var serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    var checkpoints = data.checkpoints || [];
    var last = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
    var lastCheckpointOffset = last ? last.offset : restored.offset;
    var lastCheckpointTime = last ? last.t : null;
    // The restored terminal is already at the session's real size (from the
    // tail or a checkpoint), so appends can checkpoint right away.
    var seenResize = true;
    var final = isFinishedFile(file);
    data.offset = restored.offset;
    data.activity = ensureActivity(data.activity);
    data.activityPasswordPrompt = !!data.activityPasswordPrompt;
    data.activityPromptTail = String(data.activityPromptTail || '');
    if (!data.titleSeconds || typeof data.titleSeconds != 'object') {
      data.titleSeconds = {};
    }
    data.currentTitle = typeof data.currentTitle == 'string'
      ? data.currentTitle : null;
    data.currentTitleT = Number.isFinite(data.currentTitleT)
      ? data.currentTitleT : data.startdate;

    await readLines(file, restored.offset, stat.size, final,
      async function(line, next) {
        data.offset = next;
        var record = parseRecord(line);
        if (!record) return;
        if (Number.isFinite(record.t) && record.t > 0) {
          if (data.startdate == null) data.startdate = record.t;
          data.lastT = record.t;
        }
        if (record.c == 1) updatePasswordPrompt(data, record.d);
        addTitleTitles(data, record);
        var hiddenInput = record.c == 2
          && (record.h === 1 || record.hidden === true
            || data.activityPasswordPrompt);
        addActivity(data, record, hiddenInput);
        if (hiddenInput && /[\r\n]/.test(String(record.d || ''))) {
          data.activityPasswordPrompt = false;
          data.activityPromptTail = '';
        }
        if (applyRecord(terminal, record)) seenResize = true;
        var dueByTime = Number.isFinite(record.t)
          && (lastCheckpointTime == null
            || (record.t - lastCheckpointTime) * 1000 >= checkpointIntervalMs);
        var dueByBytes = next - lastCheckpointOffset >= checkpointBytes;
        if ((dueByTime || dueByBytes) && seenResize) {
          await flushTerminal(terminal);
          var t = Number.isFinite(record.t) ? record.t : data.lastT;
          if (t != null) {
            checkpoints.push({
              t: t,
              offset: next,
              cols: terminal.cols,
              rows: terminal.rows,
              title: data.currentTitle,
              serialized: serialize.serialize()
            });
            lastCheckpointOffset = next;
            lastCheckpointTime = t;
          }
        }
      });
    await flushTerminal(terminal);
    if (data.currentTitle != null) {
      addTitleSpan(data.titleSeconds, data.currentTitle,
        data.currentTitleT, data.lastT);
    }
    data.checkpoints = thinCheckpoints(checkpoints);
    data.size = stat.size;
    data.mtimeMs = stat.mtimeMs;
    data.cols = terminal.cols;
    data.rows = terminal.rows;
    data.tail = {
      offset: data.offset,
      t: data.lastT,
      cols: terminal.cols,
      rows: terminal.rows,
      title: data.currentTitle,
      serialized: serialize.serialize()
    };
    return data;
  }

  async function ensureCache(file, username, session) {
    var state = cacheStates.get(file);
    if (!state) {
      state = {data: null, running: null};
      cacheStates.set(file, state);
    }
    if (state.running) return state.running;
    state.running = (async function() {
      var stat = await fs.promises.stat(file);
      var data = state.data || loadDiskCache(file);
      if (data && (data.version !== CACHE_VERSION || stat.size < data.offset)) {
        data = null;
      }
      if (data && stat.size === data.offset && stat.mtimeMs === data.mtimeMs) {
        return data;
      }
      if (data) {
        data = await appendCache(file, data, stat);
      } else {
        data = await buildCache(file, username, session, stat, null);
      }
      state.data = data;
      saveDiskCache(file, data);
      return data;
    })();
    try {
      return await state.running;
    } finally {
      state.running = null;
    }
  }

  function isFinishedFile(file) {
    return file.endsWith('.done') || file.endsWith('.uploaded');
  }

  // The first line of a session log is a header record (c=4) whose payload
  // carries the viewonly and share links of the session.
  async function readSessionMeta(file) {
    var handle = null;
    try {
      handle = await fs.promises.open(file, 'r');
      var buffer = Buffer.alloc(8192);
      var result = await handle.read(buffer, 0, buffer.length, 0);
      var line = buffer.toString('utf-8', 0, result.bytesRead).split('\n')[0];
      var record = JSON.parse(line);
      if (record && record.c === 4) {
        var meta = JSON.parse(record.d);
        if (meta && typeof meta == 'object') return meta;
      }
    } catch (error) {
    } finally {
      if (handle) {
        try { await handle.close(); } catch (error) {}
      }
    }
    return {};
  }

  function isSafeSessionName(username, session) {
    return USERNAME_RE.test(username || '')
      && SESSION_NAME_RE.test(session || '')
      && session.indexOf('/') == -1;
  }

  function findLocalFile(username, session) {
    var relative = renderTemplate(sessionTemplate,
      {username: username, session: session});
    if (!isSafeRelative(relative)) return null;
    var base = path.join(sessionDir, relative);
    var candidates = [base, base + '.done', base + '.uploaded'];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (fs.statSync(candidates[i]).isFile()) {
          return {
            file: candidates[i],
            relative: relative,
            hostname: options.hostname || require('os').hostname(),
            source: 'local'
          };
        }
      } catch (error) {}
    }
    return null;
  }

  async function listFiles(root, template, names, source, defaultHostname) {
    var entries = [];
    async function walk(dir, relative) {
      var items;
      try {
        items = await fs.promises.readdir(dir, {withFileTypes: true});
      } catch (error) {
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
        if (item.name.endsWith('.meta.json')) continue;
        var finished = source == 'archive'
          || item.name.endsWith('.done')
          || item.name.endsWith('.uploaded');
        var activeRel = finished
          ? rel.replace(/\.(done|uploaded)$/, '')
          : rel;
        if (!activeRel.endsWith('.json')) continue;
        if (activeRel.endsWith('.checkpoint.json')) continue;
        var values = matchTemplate(template, activeRel, names);
        if (!values) continue;
        entries.push({
          username: values.username,
          session: values.session,
          hostname: values.hostname || defaultHostname,
          file: path.join(dir, item.name),
          finished: finished,
          source: source
        });
      }
    }
    await walk(root, '');
    return entries;
  }

  async function listLocalFiles() {
    return listFiles(sessionDir, sessionTemplate, ['username', 'session'],
      'local', options.hostname || require('os').hostname());
  }

  async function listActiveFiles() {
    if (!activeDir) return [];
    return listFiles(activeDir, activeTemplate,
      ['hostname', 'username', 'session'], 'active', null);
  }

  async function listArchiveFiles() {
    if (!archiveDir) return [];
    return listFiles(archiveDir, archiveTemplate,
      ['hostname', 'username', 'session'], 'archive', null);
  }

  async function pickBest(matches) {
    var best = matches[0];
    var bestStat = null;
    try {
      bestStat = await fs.promises.stat(best.file);
    } catch (error) {}
    for (var i = 1; i < matches.length; i++) {
      try {
        var stat = await fs.promises.stat(matches[i].file);
        if (!bestStat || stat.mtimeMs > bestStat.mtimeMs) {
          best = matches[i];
          bestStat = stat;
        }
      } catch (error) {}
    }
    return best;
  }

  function filterMatches(entries, username, session, hostname) {
    return entries.filter(function(entry) {
      return entry.username == username && entry.session == session
        && (!hostname || entry.hostname == hostname);
    });
  }

  async function findSessionFile(username, session, hostname) {
    if (!isSafeSessionName(username, session)) return null;
    var local = findLocalFile(username, session);
    if (local && (!hostname || hostname == local.hostname)) return local;
    var activeMatches = filterMatches(await listActiveFiles(),
      username, session, hostname);
    if (activeMatches.length) return await pickBest(activeMatches);
    var archiveMatches = filterMatches(await listArchiveFiles(),
      username, session, hostname);
    if (!archiveMatches.length) return null;
    return await pickBest(archiveMatches);
  }

  async function listSessionFiles() {
    var local = await listLocalFiles();
    var active = await listActiveFiles();
    var archive = await listArchiveFiles();
    return local.concat(active, archive);
  }

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

  async function readLastDate(file) {
    var handle = null;
    try {
      var stat = await fs.promises.stat(file);
      var length = Math.min(stat.size, 256 * 1024);
      handle = await fs.promises.open(file, 'r');
      var buffer = Buffer.alloc(length);
      var result = await handle.read(buffer, 0, length, stat.size - length);
      var lines = buffer.toString('utf-8', 0, result.bytesRead)
        .replace(/\n+$/, '').split('\n');
      for (var i = lines.length - 1; i >= 0; i--) {
        try {
          var record = JSON.parse(lines[i]);
          if (Number.isFinite(record.t) && record.t > 0) return record.t;
        } catch (error) {}
      }
    } catch (error) {
    } finally {
      if (handle) {
        try { await handle.close(); } catch (error) {}
      }
    }
    try {
      var info = await fs.promises.stat(file);
      return info.mtimeMs / 1000;
    } catch (error) {
      return Date.now() / 1000;
    }
  }

  async function scanTitles(file) {
    var titles = {};
    var current = null;
    var currentT = null;
    var lastT = null;
    var stat = await fs.promises.stat(file);
    await readLines(file, 0, stat.size, isFinishedFile(file),
      async function(line) {
        var record = parseRecord(line);
        if (!record) return;
        if (Number.isFinite(record.t) && record.t > 0) lastT = record.t;
        if (record.c == 1 && Number.isFinite(record.t)) {
          var found = extractTitles(record.d);
          for (var i = 0; i < found.length; i++) {
            if (current != null) addTitleSpan(titles, current, currentT, record.t);
            current = found[i];
            currentT = record.t;
          }
        }
      });
    if (current != null) addTitleSpan(titles, current, currentT, lastT);
    return {titles: titles, lastTitle: current};
  }

  async function describe(entry, stat) {
    var key = entry.file + ':' + stat.size + ':' + stat.mtimeMs;
    var cached = metaCache.get(entry.file);
    if (cached && cached.key === key) return cached.value;
    var state = cacheStates.get(entry.file);
    var metadata = state && state.data ? state.data : null;
    // Sessions played back earlier have a disk cache with checkpoints and
    // titles; loading it here lets the list advertise checkpoint counts (and
    // thumbnail slots) without building anything. Never-played sessions have
    // no cache file and stay at zero, so listing never triggers a cache pass.
    if (!metadata) metadata = loadDiskCache(entry.file);
    var startdate = metadata && metadata.startdate != null
      ? metadata.startdate : await readStartDate(entry.file);
    var enddate = metadata && metadata.lastT != null
      ? metadata.lastT : await readLastDate(entry.file);
    // No staleness check: a session that is not finished is listed as
    // active (exact on wslogin-server.js hosts through isActive). Disconnections
    // are discovered by the tailer when the event stream is processed.
    var active = entry.finished ? false
      : (isActive ? !!isActive(entry.username, entry.session) : true);
    var titleInfo = metadata && metadata.titleSeconds
      ? {titles: metadata.titleSeconds, lastTitle: metadata.currentTitle}
      : await scanTitles(entry.file);
    var extra = await readSessionMeta(entry.file);
    var value = {
      username: entry.username,
      session: entry.session,
      hostname: entry.hostname || options.hostname || require('os').hostname(),
      source: entry.source || 'local',
      size: stat.size,
      mtime: stat.mtimeMs / 1000,
      startdate: startdate,
      enddate: enddate,
      duration: Math.max(0, (enddate - startdate) * 1000),
      cols: metadata ? metadata.cols : null,
      rows: metadata ? metadata.rows : null,
      checkpoints: metadata ? metadata.checkpoints.length : 0,
      activity: metadata
        ? normalizeActivity(metadata.activity, startdate, enddate) : null,
      description: titleDescription(titleInfo.titles, titleInfo.lastTitle),
      active: active,
      finished: entry.finished,
      viewid: entry.finished ? null
        : (typeof extra.viewid == 'string' ? extra.viewid : null),
      shareid: entry.finished ? null
        : (typeof extra.shareid == 'string' ? extra.shareid : null),
      viewurl: entry.finished ? null
        : (typeof extra.viewurl == 'string' ? extra.viewurl : null),
      shareurl: entry.finished ? null
        : (typeof extra.shareurl == 'string' ? extra.shareurl : null)
    };
    metaCache.set(entry.file, {key: key, value: value});
    return value;
  }

  async function listSessions() {
    var entries = await listSessionFiles();
    var merged = new Map();
    for (var i = 0; i < entries.length; i++) {
      var stat;
      try {
        stat = await fs.promises.stat(entries[i].file);
      } catch (error) {
        continue;
      }
      var value = await describe(entries[i], stat);
      var key = value.hostname + '/' + value.username + '/' + value.session;
      var old = merged.get(key);
      if (!old
          || (value.active && !(old.active && old.source == 'local'))
          || (!old.active && old.source != 'archive'
            && value.source == 'archive')) {
        merged.set(key, value);
      }
    }
    var result = Array.from(merged.values());
    result.sort(function(a, b) { return b.startdate - a.startdate; });
    return result;
  }

  function checkLoginCookie(request) {
    var cookies = parseCookieHeader(request.headers.cookie);
    var token = cookies[LOGIN_COOKIE];
    if (!token || !LOGIN_TOKEN_RE.test(token)) return false;
    var hit = loginSessions.get(token);
    if (hit && hit.expires > Date.now()) return true;
    if (hit) loginSessions.delete(token);
    return false;
  }

  // Authentication for the API: login page session cookie first, then the
  // auth server session cookie (auth.ini). SSO is only used when there is no
  // valid session cookie; a successful sso login issues a session cookie so
  // later requests authenticate via the cookie and not sso again. Resolves to
  // true (already authed), a Set-Cookie value (sso login, set it), or false.
  function checkAuth(request) {
    if (!authRequired) return Promise.resolve(true);
    if (checkLoginCookie(request)) return Promise.resolve(true);
    if (!sso) return Promise.resolve(false);
    return new Promise(function(resolve) {
      try {
        sso.user(request, function(username) {
          if (!username) {
            resolve(false);
            return;
          }
          resolve(createLoginSession(username, false));
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  function createLoginSession(username, remember) {
    var token = crypto.randomBytes(32).toString('hex');
    var expires = Date.now() + (remember ? LOGIN_REMEMBER_MS : LOGIN_SESSION_MS);
    loginSessions.set(token, {username: username, expires: expires});
    if (loginSessions.size > LOGIN_MAX_SESSIONS) {
      var nowms = Date.now();
      loginSessions.forEach(function(value, key) {
        if (value.expires <= nowms) loginSessions.delete(key);
      });
      while (loginSessions.size >= LOGIN_MAX_SESSIONS) {
        var oldest = loginSessions.keys().next().value;
        loginSessions.delete(oldest);
      }
    }
    var cookie = LOGIN_COOKIE + '=' + token
      + '; Path=/; HttpOnly; SameSite=Lax'
      + '; Max-Age=' + Math.max(1, Math.floor((expires - Date.now()) / 1000));
    if (cookieSecure) cookie += '; Secure';
    return cookie;
  }

  async function handleLogin(request, response) {
    if (!authenticate) {
      sendJson(response, 503, {error: 'login is not available'});
      return;
    }
    var body = '';
    var size = 0;
    var overflow = false;
    request.on('data', function(chunk) {
      size += chunk.length;
      if (size > LOGIN_MAX_BODY) {
        overflow = true;
        request.destroy();
        return;
      }
      body += chunk;
    });
    await new Promise(function(resolve) {
      function done() {
        request.removeListener('end', done);
        request.removeListener('close', done);
        resolve();
      }
      request.on('end', done);
      request.on('close', done);
    });
    if (response.writableEnded) return;
    if (overflow) {
      sendJson(response, 400, {error: 'bad request'});
      return;
    }
    var username = '';
    var password = '';
    var remember = false;
    try {
      var data = JSON.parse(body);
      username = String(data.username || '');
      password = String(data.password || '');
      remember = data.remember === true;
    } catch (error) {
      sendJson(response, 400, {error: 'bad request'});
      return;
    }
    if (!USERNAME_RE.test(username)) {
      sendJson(response, 401, {error: 'authentication failed'});
      return;
    }
    try {
      authenticate(username, password, function(error) {
        if (response.writableEnded) return;
        if (error) {
          log('login failed for ' + username);
          sendJson(response, 401, {error: 'authentication failed'});
          return;
        }
        log('login for ' + username);
        response.setHeader('Set-Cookie', createLoginSession(username, remember));
        sendJson(response, 200, {ok: true, username: username});
      });
    } catch (error) {
      sendJson(response, 500, {error: 'authentication failed'});
    }
  }

  function rejectAuth(response) {
    response.statusCode = 401;
    sendJson(response, 401, {error: 'authentication required'});
  }

  async function writeLine(response, value) {
    if (response.destroyed || response.writableEnded) return false;
    var ok = response.write(JSON.stringify(value) + '\n');
    if (ok) return true;
    await new Promise(function(resolve) {
      function done() {
        response.removeListener('drain', done);
        response.removeListener('close', done);
        resolve();
      }
      response.once('drain', done);
      response.once('close', done);
    });
    return !response.destroyed && !response.writableEnded;
  }

  async function streamEvents(request, response, file, metadata, url) {
    var from = Number(url.searchParams.get('from'));
    if (!Number.isFinite(from) || from < 0) from = 0;
    var follow = url.searchParams.get('follow') == '1';
    var data = await ensureCache(file, metadata.username, metadata.session);
    var startOffset = 0;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    if (typeof response.flushHeaders == 'function') response.flushHeaders();

    var checkpoint = from > 0 ? lastCheckpointBefore(data, from) : null;
    if (checkpoint) {
      startOffset = checkpoint.offset;
      await writeLine(response, {
        type: 'checkpoint',
        t: checkpoint.t,
        offset: checkpoint.offset,
        cols: checkpoint.cols,
        rows: checkpoint.rows,
        title: checkpoint.title,
        serialized: checkpoint.serialized,
        activity: metadata.activity
      });
    } else {
      await writeLine(response, {
        type: 'start',
        t: metadata.startdate,
        cols: data.cols,
        rows: data.rows,
        from: from,
        activity: metadata.activity
      });
    }

    var finished = isFinishedFile(file);
    var offset = startOffset;
    var remainder = Buffer.alloc(0);
    var closed = false;
    request.on('close', function() { closed = true; });

    async function emit(line, next) {
      var record = parseRecord(line);
      if (!record) return true;
      return writeLine(response, {
        o: next,
        t: record.t,
        d: record.d,
        c: record.c
      });
    }

    async function readTo(size, final) {
      if (size <= offset + remainder.length) {
        if (final && remainder.length > 0) {
          var rest = remainder;
          remainder = Buffer.alloc(0);
          var restOffset = offset + rest.length;
          offset = restOffset;
          await emit(rest, restOffset);
        }
        return;
      }
      var readStart = offset + remainder.length;
      var stream = fs.createReadStream(file, {
        start: readStart,
        end: size - 1,
        highWaterMark: 256 * 1024
      });
      var base = offset;
      var pending = remainder;
      remainder = Buffer.alloc(0);
      for await (var chunk of stream) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        var index;
        while ((index = pending.indexOf(10)) >= 0) {
          var line = pending.subarray(0, index);
          var next = base + index + 1;
          if (!(await emit(line, next))) return;
          pending = pending.subarray(index + 1);
          base = next;
        }
      }
      offset = base;
      remainder = pending;
      if (final && remainder.length > 0) {
        var tail = remainder;
        remainder = Buffer.alloc(0);
        var tailOffset = offset + tail.length;
        offset = tailOffset;
        await emit(tail, tailOffset);
      }
    }

    var stat = await fs.promises.stat(file);
    await readTo(stat.size, finished);
    if (!follow || finished) {
      await writeLine(response, {
        type: 'end',
        duration: metadata.duration,
        offset: offset
      });
      response.end();
      return;
    }

    var lastSize = stat.size;
    try {
      while (!closed) {
        await delay(FOLLOW_POLL_MS);
        if (response.destroyed || response.writableEnded) break;
        try {
          stat = await fs.promises.stat(file);
        } catch (error) {
          await writeLine(response, {type: 'renamed'});
          break;
        }
        if (stat.size < offset + remainder.length) {
          await writeLine(response, {type: 'reset'});
          break;
        }
        if (stat.size > lastSize) {
          lastSize = stat.size;
          await readTo(stat.size, false);
        }
      }
    } finally {
      if (!response.writableEnded) {
        await writeLine(response, {type: 'end', offset: offset});
        response.end();
      }
    }
  }

  async function handle(request, response, url) {
    if (!enabled) {
      response.statusCode = 404;
      response.end('');
      return;
    }
    var pathname = url.pathname;
    if (pathname == '/api/playback/login' && request.method == 'POST') {
      await handleLogin(request, response);
      return;
    }
    if (pathname == '/api/playback' || pathname == '/api/playback/') {
      sendJson(response, 200, {
        enabled: true,
        endpoints: ['sessions', 'session', 'events', 'thumbnail', 'download',
          'login'],
        auth: authRequired,
        sso: !!sso,
        idle_skip_enabled: idleSkipEnabled,
        idle_skip_seconds: idleSkipSeconds,
        idle_video: idleVideo,
        idle_video_delay_seconds: idleVideoDelaySeconds,
        idle_overlay_delay_seconds: idleOverlayDelaySeconds,
        idle_auto_skip_seconds: idleAutoSkipSeconds,
        idle_movie_auto_skip_seconds: idleMovieAutoSkipSeconds,
        idle_skip_seconds_show_video: idleShowVideoSeconds
      });
      return;
    }
    if (!pathname.startsWith('/api/playback/')) {
      response.statusCode = 404;
      response.end('');
      return;
    }
    var authenticated = await checkAuth(request);
    if (typeof authenticated == 'string') {
      // sso login succeeded: issue the session cookie so the next request
      // authenticates via the cookie instead of running sso again.
      response.setHeader('Set-Cookie', authenticated);
    } else if (authenticated !== true) {
      rejectAuth(response);
      return;
    }
    try {
      if (pathname == '/api/playback/sessions' && request.method == 'GET') {
        sendJson(response, 200, {sessions: await listSessions()});
        return;
      }
      // Thumbnail: the rendered screen of the newest checkpoint of a session,
      // requested lazily by the session list. The checkpoint cache is built on
      // demand, so an unlisted thumbnail costs one cache pass of the log.
      if (pathname == '/api/playback/thumbnail' && request.method == 'GET') {
        var thumbUser = url.searchParams.get('u') || '';
        var thumbSession = url.searchParams.get('s') || '';
        var thumbHost = url.searchParams.get('h') || '';
        var thumbFound = await findSessionFile(thumbUser, thumbSession, thumbHost);
        if (!thumbFound) {
          sendJson(response, 404, {error: 'session not found'});
          return;
        }
        var thumbData = await ensureCache(thumbFound.file, thumbUser, thumbSession);
        var thumb = thumbData.tail
          || (thumbData.checkpoints.length
            ? thumbData.checkpoints[thumbData.checkpoints.length - 1] : null);
        if (!thumb || !thumb.serialized) {
          sendJson(response, 200, {empty: true});
          return;
        }
        sendJson(response, 200, {
          t: thumb.t,
          cols: thumb.cols,
          rows: thumb.rows,
          title: thumb.title,
          serialized: await thumbnailScreen(thumb)
        });
        return;
      }
      if ((pathname == '/api/playback/session'
          || pathname == '/api/playback/events'
          || pathname == '/api/playback/download')
          && request.method == 'GET') {
        var username = url.searchParams.get('u') || '';
        var session = url.searchParams.get('s') || '';
        var hostname = url.searchParams.get('h') || '';
        var found = await findSessionFile(username, session, hostname);
        if (!found) {
          sendJson(response, 404, {error: 'session not found'});
          return;
        }
        var stat = await fs.promises.stat(found.file);
        await ensureCache(found.file, username, session);
        metaCache.delete(found.file);
        var metadata = await describe({
          username: username,
          session: session,
          hostname: found.hostname,
          source: found.source,
          file: found.file,
          finished: found.source == 'archive'
            || isFinishedFile(found.file)
        }, stat);
        if (pathname == '/api/playback/session') {
          sendJson(response, 200, metadata);
          return;
        }
        if (pathname == '/api/playback/download') {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/x-ndjson');
          response.setHeader('Content-Disposition', 'attachment; filename="'
            + username + '-' + session + '.json"');
          response.setHeader('Content-Length', stat.size);
          fs.createReadStream(found.file).pipe(response);
          return;
        }
        await streamEvents(request, response, found.file, metadata, url);
        return;
      }
      sendJson(response, 404, {error: 'not found'});
    } catch (error) {
      log('request failed: ' + error.message);
      if (!response.headersSent) {
        sendJson(response, 500, {error: error.message});
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  }

  return {
    enabled: enabled,
    sessionDir: sessionDir,
    sessionTemplate: sessionTemplate,
    cacheDir: cacheDir,
    wwwDir: wwwDir,
    authRequired: authRequired,
    idleSkipEnabled: idleSkipEnabled,
    idleSkipSeconds: idleSkipSeconds,
    idleVideo: idleVideo,
    idleVideoDelaySeconds: idleVideoDelaySeconds,
    idleOverlayDelaySeconds: idleOverlayDelaySeconds,
    idleAutoSkipSeconds: idleAutoSkipSeconds,
    idleMovieAutoSkipSeconds: idleMovieAutoSkipSeconds,
    idleShowVideoSeconds: idleShowVideoSeconds,
    handle: handle,
    serveStatic: function(response, relative) {
      serveStatic(response, wwwDir, relative);
    },
    close: function() {}
  };
}

module.exports = {
  createPlayback: createPlayback,
  serveStatic: serveStatic
};
