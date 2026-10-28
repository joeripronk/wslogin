#!/usr/bin/env node
'use strict';

// termd - reattachable terminal daemon with integrated recording.
//
// One daemon per session, no central daemon (no SPOF): the CLI spawns a
// detached session daemon per shell; it owns the pty and an authoritative
// @xterm/headless model (screen + scrollback), records every raw byte to
// a wslogin compatible JSONL log, and streams to any number of clients.
// Attaching gets a serialized snapshot (scrollback + screen) followed by
// the live stream, so reconnect is native: the daemon's memory is the
// history.
//
// registry: <termd_dir>/<user> when wslogin is installed (CLI daemons
// then register in wslogin's registry and show in the browser picker),
// else $XDG_RUNTIME_DIR/termd; termd_dir from /etc/wslogin/config.ini,
// default /run/wslogin/termd. The client scans both dirs.
// clients speak the wslogin framing: '\x01' + raw data, '\x00' + JSON.
// daemon speaks: '\x00' resize, '\x01' snapshot/output, '\x00' b64, '\x00' exit.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
// ws, node-pty and xterm are required lazily (in the daemon and the
// client paths that need them) so that `termd ping` can run and report
// a missing module instead of the script dying at startup

const SCROLLBACK = 10000;
const VERSION = '0.1.0';

function now() { return Date.now() / 1000; }
function runtimeDir() { return process.env.XDG_RUNTIME_DIR || '/tmp'; }
// registry: wslogin installed -> <termd_dir>/<user> (termd_dir from
// /etc/wslogin/config.ini, default /run/wslogin/termd), so CLI daemons
// register in the same registry wslogin lists and the browser picker
// shows them; else $XDG_RUNTIME_DIR/termd. The client scans both.
function regDir() {
  if (process.env.TERMD_DIR) return process.env.TERMD_DIR;
  var w = wsloginRegDir();
  if (w && canWriteWsloginBase(w)) return w;
  return path.join(runtimeDir(), 'termd');
}
function sockPath(id) { return path.join(regDir(), id + '.sock'); }
function metaPath(id) { return path.join(regDir(), id + '.meta'); }
function logPath(id) { return process.env.TERMD_LOG || path.join(regDir(), 'sess-' + id + '.jsonl'); }

// registry dir of the wslogin-started sessions of the current user:
// <termd_dir>/<user> with termd_dir from the wslogin config (readable
// only for root in the default install; fall back to the server default)
var wsloginRegDirCache = null;
function wsloginRegDir() {
  if (wsloginRegDirCache !== null) return wsloginRegDirCache;
  var base = '/run/wslogin/termd';
  try {
    var conf = fs.readFileSync(process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini', 'utf8');
    var m = conf.match(/^\s*termd_dir\s*=\s*(.+)$/m);
    if (m) base = path.resolve(m[1].trim());
  } catch (e) {}
  var user;
  // the real uid, not $USER: $USER is user-controlled and would let a
  // user register daemons in another user's registry dir
  try { user = os.userInfo().username; } catch (e) { user = process.env.USER; }
  wsloginRegDirCache = user ? path.join(base, user) : null;
  return wsloginRegDirCache;
}

// the wslogin registry is usable only when the base exists and the
// current user has write access (the ACL entry ensureTermdDir sets);
// a user who never had a wslogin session falls back to the XDG dir
function canWriteWsloginBase(w) {
  var base = path.dirname(w);
  try { fs.accessSync(base, fs.constants.W_OK | fs.constants.X_OK); } catch (e) { return false; }
  return true;
}

// the registries the client scans: its own dir plus the wslogin dir
function regDirs() {
  var dirs = [regDir()];
  var w = wsloginRegDir();
  if (w && w !== regDir()) dirs.push(w);
  return dirs;
}
function sockOf(entry) { return path.join(entry.dir, entry.id + '.sock'); }
function metaOf(entry) { return path.join(entry.dir, entry.id + '.meta'); }

var MOUSE_SEQ_RE = /\x1b\[<[\d;?]*[Mm]|\x1b\[M[\x20-\x7f]{3}/g;

function stripMouseSeq(s) { return s.replace(MOUSE_SEQ_RE, ''); }

function trailingMouseSeq(s) {
  var i = s.lastIndexOf('\x1b');
  if (i < 0) return -1;
  var tail = s.slice(i);
  if (/^\x1b(\[<[\d;?]*|\[)?$/.test(tail) || /^\x1b\[M[\x20-\x7f]{0,2}$/.test(tail)) return i;
  return -1;
}

function validSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 4000 && rows >= 1 && rows <= 1000;
}

// is this path termd itself? (the passwd shell field is the termd
// binary, so $SHELL is termd when the daemon looks for the real shell)
function isTermdPath(p) {
  var base = path.basename(p);
  if (base === 'termd' || base === 'termd.js') return true;
  try { return fs.realpathSync(p) === fs.realpathSync(__filename); } catch (e) { return false; }
}

// the real shell a session runs: TERMD_SHELL (set by the login shell
// mode, from the optional shell argument in the passwd field), else
// $SHELL, and /bin/bash when $SHELL is termd itself (recursion guard)
function realShell() {
  var sh = process.env.TERMD_SHELL || process.env.SHELL || '/bin/bash';
  if (isTermdPath(sh)) sh = '/bin/bash';
  return sh;
}

// ---------------------------------------------------------------- session daemon

function runSession(cols, rows) {
  var pty = require('node-pty');
  var WebSocket = require('ws');
  var { Terminal } = require('@xterm/headless');
  var { SerializeAddon } = require('@xterm/addon-serialize');
  if (!validSize(cols, rows)) { cols = 80; rows = 24; }
  // 0750 (not 0700): in the wslogin registry the per-user dir inherits
  // the base's default ACL for the service user, and a 0700 mkdir would
  // set the ACL mask to --- and mask that entry away; 0750 keeps the
  // mask at r-x (traverse + readdir is all wslogin needs on the dir)
  // and keeps the dir closed to other users, who could otherwise read
  // the session meta and the sess-<id>.jsonl recording in it
  fs.mkdirSync(regDir(), { recursive: true, mode: 0o750 });
  var id = crypto.randomUUID();
  var shell = realShell();
  var session = {
    id: id, cols: cols, rows: rows, shell: shell,
    connections: Object.create(null), owner: null,
    title: '', dying: false
  };
  var nextIndex = 0;

  var term = new Terminal({ allowProposedApi: true, cols: cols, rows: rows, scrollback: SCROLLBACK });
  var ser = new SerializeAddon();
  term.loadAddon(ser);
  term.onTitleChange(function (t) { session.title = t; });
  session.term = term; session.ser = ser;

  var logfile = logPath(id);
  // 0600: the meta and the recording are readable only by the session
  // user (the wslogin service user gets in through the ACLs on the dirs)
  fs.writeFileSync(metaPath(id), JSON.stringify({ id: id, cols: cols, rows: rows, start: now(), shell: shell }), { mode: 0o600 });
  fs.writeFileSync(logfile, '', { mode: 0o600, flag: 'a' });
  var header = {
    username: os.userInfo().username, sessioncookie: process.env.TERMD_COOKIE || id,
    cols: cols, rows: rows, starttime: now(), shell: shell, termd: sockPath(id) };
  if (process.env.VIEWID) header.viewid = process.env.VIEWID;
  if (process.env.VIEWURL) header.viewurl = process.env.VIEWURL;
  if (process.env.SHAREID) header.shareid = process.env.SHAREID;
  if (process.env.SHAREURL) header.shareurl = process.env.SHAREURL;
  appendLog({ t: now(), d: JSON.stringify(header), c: 4 });

  function appendLog(log) {
    try { fs.appendFileSync(logfile, JSON.stringify(log) + '\n'); } catch (e) {}
  }

  function serializeSession() {
    var { isCursorHidden } = term._core._inputHandler._coreService;
    return ser.serialize() + (isCursorHidden ? '\x1b[?25l' : '\x1b[?25h');
  }

  function broadcast(data) {
    for (const key in session.connections) {
      try { session.connections[key].ws.send(data); } catch (e) {}
    }
  }

  function sendSnapshot(conn) {
    conn.ws.send('\x00' + JSON.stringify({ cmd: 'attached', id: id, cols: session.cols, rows: session.rows }));
    conn.ws.send('\x00' + JSON.stringify({ cmd: 'resize', cols: session.cols, rows: session.rows }));
    conn.ws.send('\x01' + serializeSession());
  }

  function info() {
    return { id: id, cols: session.cols, rows: session.rows, title: session.title,
      owner: session.owner ? true : false, conns: Object.keys(session.connections).length };
  }

  function applyResize(c, r) {
    if (!validSize(c, r)) return;
    if (c === session.cols && r === session.rows) return;
    session.cols = c; session.rows = r;
    try { session.pty.resize(c, r); } catch (e) {}
    term.resize(c, r);
    appendLog({ t: now(), d: JSON.stringify({ cmd: 'resize', cols: c, rows: r }), c: 0 });
    broadcast('\x00' + JSON.stringify({ cmd: 'resize', cols: c, rows: r }));
  }

  function detachConn(conn) {
    delete session.connections[conn.index];
    if (session.owner === conn) session.owner = null;
    conn.session = null; conn.owner = false;
  }

  function cleanup() {
    try { fs.unlinkSync(sockPath(id)); } catch (e) {}
    try { fs.unlinkSync(metaPath(id)); } catch (e) {}
    process.exit(0);
  }

  session.pty = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color', cols: cols, rows: rows,
    cwd: process.env.HOME || '/', encoding: null,
    // TERMD_SESSION lets `termd list` inside the shell mark its own
    // session (the registry id; TERMD_COOKIE is wslogin's cookie for
    // wslogin-started daemons and differs from it)
    env: Object.assign({}, process.env, { TERMD_SESSION: id })
  });
  session.pty.on('data', function (data) {
    term.write(data);
    var text = data.toString('utf8');
    if (Buffer.compare(Buffer.from(text, 'utf8'), data) === 0) {
      appendLog({ t: now(), d: text, c: 1 });
      broadcast('\x01' + text);
    } else {
      var b = data.toString('base64');
      appendLog({ t: now(), d: JSON.stringify({ cmd: 'b64', data: b }), c: 0 });
      broadcast('\x00' + JSON.stringify({ cmd: 'b64', data: b }));
    }
  });
  session.pty.on('resize', function (size) {
    session.cols = size.cols; session.rows = size.rows;
  });
  session.pty.on('exit', function (e) {
    var code = (e && typeof e === 'object' && e.exitCode !== undefined) ? e.exitCode : e;
    appendLog({ t: now(), d: code, c: 3 });
    broadcast('\x00' + JSON.stringify({ cmd: 'exit', id: id, status: code }));
    setTimeout(cleanup, 200);
  });

  function onClient(conn, raw) {
    var buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    var kind = buf.length ? buf[0] : -1;
    if (kind === 1) {
      if (!conn.session || !conn.owner) return;
      var full = buf.slice(1).toString('utf8');
      if (conn.pending) { full = conn.pending + full; conn.pending = ''; }
      var logBody = full;
      var cut = trailingMouseSeq(full);
      if (cut >= 0) { conn.pending = full.slice(cut); logBody = full.slice(0, cut); }
      if (conn.pending.length > 32) { logBody += conn.pending; conn.pending = ''; }
      logBody = stripMouseSeq(logBody);
      if (logBody) appendLog({ t: now(), d: logBody, c: 2 });
      try { session.pty.write(buf.slice(1)); } catch (e) {}
      return;
    }
    if (kind !== 0) return;
    var m;
    try { m = JSON.parse(buf.slice(1).toString('utf8')); } catch (e) { return; }
    switch (m.cmd) {
      case 'attach': {
        session.connections[conn.index] = conn;
        conn.session = session;
        if (m.view !== true && !session.owner) { session.owner = conn; conn.owner = true; }
        sendSnapshot(conn);
        break;
      }
      case 'list':
        conn.ws.send('\x00' + JSON.stringify({ cmd: 'sessions', list: [info()] }));
        break;
      case 'kill':
        try { session.pty.kill(); } catch (e) {}
        conn.ws.send('\x00' + JSON.stringify({ cmd: 'killed', id: id }));
        break;
      case 'resize':
        if (conn.session && conn.owner) applyResize(m.cols, m.rows);
        break;
      case 'detach':
        detachConn(conn);
        conn.ws.send('\x00' + JSON.stringify({ cmd: 'detached' }));
        break;
      case 'bye':
        conn.ws.close();
        break;
    }
  }

  var server = http.createServer(function (req, res) { res.end('termd\n'); });
  var wss = new WebSocket.Server({ server: server });
  // the proxy user allowed on the socket: TERMD_PROXY_UID at spawn
  // (wslogin passes its own uid, see termd-bridge.js), else the owner of
  // the registry dir's parent (the wslogin base for CLI daemons started
  // in the wslogin registry, own uid for plain $XDG_RUNTIME_DIR/termd)
  var proxyUid = null;
  if (process.env.TERMD_PROXY_UID) {
    var n = Number(process.env.TERMD_PROXY_UID);
    proxyUid = Number.isInteger(n) ? n : null;
    if (proxyUid === null) {
      console.log('termd: ignoring non-numeric TERMD_PROXY_UID ' + process.env.TERMD_PROXY_UID);
    }
  } else {
    try { proxyUid = fs.statSync(path.dirname(regDir())).uid; }
    catch (e) { console.log('termd: cannot stat registry parent for proxy uid: ' + e.message); }
  }
  wss.on('connection', function (ws, req) {
    var cred = null;
    try { cred = req.socket.getPeerCredentials(); } catch (e) {}
    // root, the owning user and the proxy user may connect; the socket's
    // ACLs restrict who can reach it, this rejects the rest
    if (cred && cred.uid !== 0 && cred.uid !== process.getuid() && cred.uid !== proxyUid) {
      ws.close();
      return;
    }
    var conn = { ws: ws, index: ++nextIndex, session: null, owner: false, pending: '' };
    ws.on('message', function (raw) { onClient(conn, raw); });
    ws.on('error', function () {});
    ws.on('close', function () { detachConn(conn); });
  });

  var sock = sockPath(id);
  server.listen(sock, function () {
    // 0770 keeps the ACL mask effective so the inherited default ACL
    // entry for the wslogin service user (set by wslogin's ensureTermdDir)
    // stays able to connect; 0700 would mask it away
    fs.chmodSync(sock, 0o770);
  });
  server.on('error', function (e) { console.error('termd session: ' + e.message); process.exit(1); });
  process.on('SIGTERM', function () { try { session.pty.kill(); } catch (e) {} cleanup(); });
}

// ---------------------------------------------------------------- client

function connectSock(entry, cb) {
  var WebSocket = require('ws');
  var sock = sockOf(entry);
  var tries = 0;
  var attempt = function () {
    var ws = new WebSocket('ws+unix://' + sock);
    var done = false;
    ws.on('open', function () { done = true; cb(null, ws); });
    ws.on('error', function (e) {
      if (done) return;
      if ((e.code === 'ENOENT' || e.code === 'ECONNREFUSED') && tries++ < 25) {
        setTimeout(attempt, 200);
        return;
      }
      cb(e, null);
    });
  };
  attempt();
}

function probe(entry, cb) {
  var WebSocket = require('ws');
  var ws = new WebSocket('ws+unix://' + sockOf(entry));
  var done = false;
  var timer = setTimeout(function () { done = true; try { ws.close(); } catch (e) {} cb(null); }, 1000);
  ws.on('open', function () {
    ws.on('message', function (raw) {
      var m = Buffer.from(raw).toString('utf8');
      if (m.charAt(0) !== '\x00') return;
      var j;
      try { j = JSON.parse(m.slice(1)); } catch (err) { return; }
      if (j.cmd === 'sessions') { clearTimeout(timer); if (!done) { done = true; ws.close(); cb(j.list[0]); } }
    });
    ws.send('\x00' + JSON.stringify({ cmd: 'list' }));
  });
  ws.on('error', function () { clearTimeout(timer); if (!done) { done = true; cb(null); } });
}

function registryEntries(cb) {
  var entries = [];
  var seen = Object.create(null);
  for (const dir of regDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.sock')) {
          var id = f.slice(0, -5);
          if (!seen[id]) { seen[id] = true; entries.push({ dir: dir, id: id }); }
        }
      }
    } catch (e) {}
  }
  cb(entries);
}

// resolve an id given on the command line to its registry entry
function findEntry(id, cb) {
  registryEntries(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) { cb(entries[i]); return; }
    }
    cb(null);
  });
}

function collectList(cb) {
  registryEntries(function (entries) {
    var found = [];
    var pending = entries.length;
    if (pending === 0) { cb(found); return; }
    entries.forEach(function (entry) {
      probe(entry, function (info) {
        if (info) found.push(info);
        if (--pending === 0) { found.sort(function (a, b) { return a.id < b.id ? -1 : 1; }); cb(found); }
      });
    });
  });
}

function clientList() {
  collectList(function (found) {
    var out = [];
    for (var i = 0; i < found.length; i++) {
      var s = found[i];
      out.push(s.id + '  ' + s.cols + 'x' + s.rows + '  ' + (s.owner ? 'attached' : 'detached') +
        (s.title ? '  ' + s.title : '') +
        (s.id === process.env.TERMD_SESSION ? '  <- your session' : ''));
    }
    console.log(out.length ? out.join('\n') : 'no sessions');
  });
}

function clientKill(id) {
  findEntry(id, function (entry) {
    if (!entry) { console.log('no such session: ' + id); process.exit(1); }
    connectSock(entry, function (e, ws) {
      if (!ws) { console.log('no such session: ' + id); process.exit(1); }
      ws.send('\x00' + JSON.stringify({ cmd: 'kill' }));
      ws.on('message', function () { process.exit(0); });
      setTimeout(function () { process.exit(0); }, 1000);
    });
  });
}

function pickSession(list, cb) {
  if (list.length === 0) { cb(null); return; }
  var free = list.filter(function (s) { return !s.owner; });
  if (free.length === 1) { cb(free[0].id); return; }
  if (list.length === 1) { cb(list[0].id); return; }
  var candidates = free.length > 0 ? free : list;
  console.log('sessions:');
  for (var i = 0; i < candidates.length; i++) {
    console.log('  [' + (i + 1) + '] ' + candidates[i].id + '  ' + candidates[i].cols + 'x' + candidates[i].rows +
      (candidates[i].title ? '  ' + candidates[i].title : ''));
  }
  process.stdout.write('number: ');
  var buf = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', function (d) {
    var c = d.toString('utf8');
    if (c === '\u0003' || c === '\r' || c === '\n') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      var n = parseInt(buf, 10);
      cb(n >= 1 && n <= candidates.length ? candidates[n - 1].id : null);
      return;
    }
    if (c >= '0' && c <= '9') { buf += c; process.stdout.write(c); }
  });
}

var RESET_MODES = { 1000: 1, 1002: 1, 1003: 1, 1005: 1, 1006: 1, 1015: 1, 2004: 1 };
var activeModes = Object.create(null);

var viewTerm = null, viewOffset = 0;

function renderView() {
  var buf = viewTerm.buffer.active;
  var end = buf.length - viewOffset;
  var start = Math.max(0, end - viewTerm.rows);
  var lines = [];
  for (var i = start; i < end; i++) {
    var line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[H' + lines.join('\r\n') + '\x1b[?25h');
}

function viewScroll(delta) {
  if (!viewTerm) return;
  var maxOff = Math.max(0, viewTerm.buffer.active.length - viewTerm.rows);
  viewOffset = Math.min(maxOff, Math.max(0, viewOffset + delta));
  renderView();
}

function trackModes(s) {
  var re = /\x1b\[?(\d+(?:;\d+)*)[hl]/g, m;
  while ((m = re.exec(s))) {
    var on = m[2] === 'h';
    var parts = m[1].split(';');
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (RESET_MODES[n]) activeModes[n] = on;
    }
  }
}

function bridge(ws, view) {
  ws.on('message', function (raw) {
    var m = Buffer.from(raw).toString('utf8');
    if (m.charAt(0) === '\x01') {
      var out = m.slice(1);
      trackModes(out);
      if (view) {
        viewTerm.write(out, function () { if (viewOffset > 0) renderView(); });
        if (viewOffset === 0) process.stdout.write(out);
      } else {
        process.stdout.write(out);
      }
      return;
    }
    var j;
    try { j = JSON.parse(m.slice(1)); } catch (err) { return; }
    if (j.cmd === 'attached') {
      if (view) {
        var { Terminal } = require('@xterm/headless');
        viewTerm = new Terminal({ allowProposedApi: true, cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24, scrollback: SCROLLBACK });
      } else {
        ws.send('\x00' + JSON.stringify({ cmd: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
      }
      enterRaw(ws, view);
    } else if (j.cmd === 'b64') {
      var b = Buffer.from(j.data, 'base64');
      trackModes(b.toString('utf8'));
      if (view) {
        viewTerm.write(b, function () { if (viewOffset > 0) renderView(); });
        if (viewOffset === 0) process.stdout.write(b);
      } else {
        process.stdout.write(b);
      }
    } else if (j.cmd === 'exit') {
      process.stdout.write('\r\n[session exited with status ' + j.status + ']\r\n');
      cleanup(ws);
      process.exit(0);
    }
  });
}

function enterRaw(ws, view) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', function (d) {
    if (d.indexOf(0x1d) >= 0) {
      ws.send('\x00' + JSON.stringify({ cmd: 'detach' }));
      cleanup(ws);
      process.exit(0);
    }
    if (view) {
      if (d.indexOf(0x03) >= 0) {
        cleanup(ws);
        process.exit(0);
      }
      if (d.indexOf('\x1b[A') >= 0) viewScroll(1);
      else if (d.indexOf('\x1b[B') >= 0) viewScroll(-1);
      else if (d.indexOf('\x1b[5~') >= 0) viewScroll(process.stdout.rows || 24);
      else if (d.indexOf('\x1b[6~') >= 0) viewScroll(-(process.stdout.rows || 24));
      else if (d.indexOf('\x1b[1~') >= 0) viewScroll(1e9);
      else if (d.indexOf('\x1b[4~') >= 0) viewScroll(-1e9);
      return;
    }
    ws.send(Buffer.concat([Buffer.from('\x01'), d]));
  });
  process.stdout.on('resize', function () {
    if (view && viewTerm) {
      try { viewTerm.resize(process.stdout.columns || 80, process.stdout.rows || 24); } catch (e) {}
      if (viewOffset > 0) renderView();
      return;
    }
    ws.send('\x00' + JSON.stringify({ cmd: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
  });
  ws.on('close', function () { process.exit(0); });
}

function cleanup(ws) {
  try { process.stdin.setRawMode(false); } catch (e) {}
  process.stdin.pause();
  var off = '';
  for (var n in activeModes) { if (activeModes[n]) off += '\x1b[?' + n + 'l'; }
  if (off) process.stdout.write(off);
  try { ws.close(); } catch (e) {}
}

function fallbackShell(reason) {
  console.log('termd: ' + reason + '; falling back to a plain shell (no detach, no recording)');
  // realShell(): with termd as login shell $SHELL is termd itself,
  // spawning it here would loop back into clientNew
  var shell = realShell();
  var child = spawn(shell, ['-l'], { stdio: 'inherit', env: process.env });
  child.on('exit', function (code, sig) { process.exit(sig ? 1 : (code === null ? 1 : code)); });
  child.on('error', function (e) { console.log('termd: cannot start ' + shell + ': ' + e.message); process.exit(1); });
}

function clientNew() {
  var marker = 'cli-' + crypto.randomUUID();
  var cols = process.stdout.columns || 80, rows = process.stdout.rows || 24;
  var child = spawn(process.execPath, [__filename, 'session', String(cols), String(rows)],
    { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TERMD_COOKIE: marker }) });
  child.on('error', function (e) { fallbackShell('cannot spawn the session daemon: ' + e.message); });
  child.unref();
  var tries = 0;
  var attachNew = function () {
    registryEntries(function (entries) {
      var mine = entries.filter(function (entry) {
        // identify our own daemon by the cookie in its log header:
        // a wslogin session started in the same window would otherwise
        // pass the fresh-by-mtime filter
        var log = process.env.TERMD_LOG || path.join(entry.dir, 'sess-' + entry.id + '.jsonl');
        try {
          var d = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
          if (!d || d.c !== 4) return false;
          var m = JSON.parse(d.d);
          return m.sessioncookie === marker;
        } catch (e) { return false; }
      });
      if (mine.length === 0 && tries++ < 20) { setTimeout(attachNew, 250); return; }
      if (mine.length === 0) { fallbackShell('session daemon did not start (termd ping shows why)'); return; }
      connectSock(mine[0], function (e, ws) {
        if (!ws) { fallbackShell('cannot attach to the new session: ' + (e ? e.message : '')); return; }
        bridge(ws, false);
        ws.send('\x00' + JSON.stringify({ cmd: 'attach' }));
      });
    });
  };
  setTimeout(attachNew, 300);
}

function clientAttach(id, view) {
  var start = function (sessId) {
    if (!sessId) { console.log('no session to attach'); process.exit(1); }
    findEntry(sessId, function (entry) {
      if (!entry) { console.log('session is gone (' + sessId + ')'); process.exit(1); }
      connectSock(entry, function (e, ws) {
        if (!ws) { console.log('session is gone (' + sessId + ')'); process.exit(1); }
        bridge(ws, view === true);
        ws.send('\x00' + JSON.stringify({ cmd: 'attach', id: sessId, view: view === true }));
      });
    });
  };
  if (id) { start(id); return; }
  collectList(function (list) { pickSession(list, start); });
}

// end-to-end self test: spawn a daemon, find it by the cookie it writes
// to its log header (concurrent sessions cannot be confused), attach and
// kill it. Shows why it fails when it does: node, modules, registry dirs.
function clientPing() {
  var marker = 'ping-' + crypto.randomUUID();
  var logfile = path.join(runtimeDir(), marker + '.jsonl');
  // the killed daemon writes its exit record ~200ms after the killed
  // frame, recreating the log after a first unlink; clean up after that
  var cleanup = function () { try { fs.unlinkSync(logfile); } catch (e) {} };
  var cleanupLater = function () { setTimeout(cleanup, 1500); };
  var pingEntry = null;
  var fail = function (msg) {
    cleanup();
    console.log('termd ping: FAIL - ' + msg);
    console.log('node ' + process.version + ' (' + process.execPath + ')');
    try {
      require('node-pty'); require('ws');
      require('@xterm/headless'); require('@xterm/addon-serialize');
      console.log('modules ok');
    } catch (e) { console.log('module check: ' + e.message); }
    console.log('registries: ' + regDirs().join(', '));
    var done = function () { process.exit(1); };
    // best effort: do not leave a daemon we started running as a ghost
    if (pingEntry) {
      try {
        var WS = require('ws');
        var killws = new WS('ws+unix://' + sockOf(pingEntry));
        var t = setTimeout(function () { try { killws.close(); } catch (e) {} done(); }, 1000);
        killws.on('open', function () { killws.send('\x00' + JSON.stringify({ cmd: 'kill' })); });
        killws.on('message', function () { clearTimeout(t); try { killws.close(); } catch (e) {} done(); });
        killws.on('error', function () { clearTimeout(t); done(); });
      } catch (e) { done(); }
    } else { done(); }
  };
  var child = spawn(process.execPath, [__filename, 'session', '40', '10'],
    { detached: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { TERMD_COOKIE: marker, TERMD_LOG: logfile }) });
  child.on('error', function (e) { fail('cannot spawn the session daemon: ' + e.message); });
  child.unref();
  var tries = 0;
  var poll = function () {
    var d = null;
    try { d = JSON.parse(fs.readFileSync(logfile, 'utf8').split('\n')[0]); } catch (e) {}
    if (!d || d.c !== 4) {
      if (tries++ < 40) { setTimeout(poll, 250); return; }
      fail('daemon did not write its log header');
      return;
    }
    var m;
    try { m = JSON.parse(d.d); } catch (e) {}
    if (!m || m.sessioncookie !== marker || !m.termd) { fail('log header has no ping cookie'); return; }
    var entry = { dir: path.dirname(String(m.termd)), id: path.basename(String(m.termd), '.sock') };
    pingEntry = entry;
    connectSock(entry, function (e, ws) {
      if (!ws) { fail('socket connect failed: ' + (e ? e.message : '')); return; }
      var timer = setTimeout(function () { fail('daemon did not answer'); }, 10000);
      ws.on('message', function (raw) {
        var s = Buffer.from(raw).toString('utf8');
        if (s.charAt(0) !== '\x00') return;
        var j;
        try { j = JSON.parse(s.slice(1)); } catch (e) { return; }
        if (j.cmd === 'attached') ws.send('\x00' + JSON.stringify({ cmd: 'kill' }));
        else if (j.cmd === 'killed') {
          clearTimeout(timer);
          cleanup();
          cleanupLater();
          try { ws.close(); } catch (e) {}
          console.log('termd ping: ok (daemon ' + entry.id + ' in ' + entry.dir +
            ': pty, registry, socket and framing work)');
        }
      });
      ws.on('error', function (e) { clearTimeout(timer); fail('socket error: ' + e.message); });
      ws.send('\x00' + JSON.stringify({ cmd: 'attach' }));
    });
  };
  setTimeout(poll, 250);
}

function usage() {
  console.log(
    'termd ' + VERSION + ' - reattachable terminal daemon with recording\n' +
    '\n' +
    'usage: termd [command]\n' +
    '  (no args)   new session, or attach a detached one when any exist\n' +
    '  new         always start a new session\n' +
    '  attach [id] attach a session (picker when no id)\n' +
    '  view <id>   attach read-only\n' +
    '  list        list sessions\n' +
    '  ping        check that a session daemon runs (self test)\n' +
    '  kill <id>   kill a session\n' +
    '  daemon      alias for new (compat)\n' +
    '\n' +
    'Ctrl-] detaches; the session keeps running and is reattached on the next run.\n' +
    'view: Ctrl-C exits, arrows/PageUp/PageDown scroll, Home/End jump to top/bottom.\n' +
    'login shell: set the passwd shell to /usr/local/bin/termd (optionally\n' +
    '"termd /bin/zsh" for a non-default session shell); ssh/getty/su logins then\n' +
    'attach a detached session or start a new one, and scp/sftp/rsync/su -c\n' +
    'keep working through a direct shell exec.\n' +
    'one detached daemon per session, registries: ' + regDirs().join(', '));
}

// direct shell exec for the non-interactive invocations a login shell
// must serve: sshd runs the passwd shell field with -c for scp, sftp,
// rsync, git, and su -c runs the shell with -c too
function execShell(shell, args) {
  var child = spawn(shell, args, { stdio: 'inherit', env: process.env });
  child.on('exit', function (code, sig) { process.exit(sig ? 1 : (code === null ? 1 : code)); });
  child.on('error', function (e) { console.log('termd: cannot run ' + shell + ': ' + e.message); process.exit(1); });
}

var KNOWN_CMDS = { new: 1, daemon: 1, attach: 1, view: 1, list: 1, ping: 1,
  kill: 1, session: 1, help: 1, '-h': 1, '--help': 1, '-c': 1 };

function main() {
  var argv = process.argv.slice(2);
  // passwd shell field: "/usr/local/bin/termd /bin/zsh" -> the first
  // argument is the real session shell (sshd passes the field's rest
  // through, so `termd /bin/zsh -c cmd` reaches scp/su -c too)
  var shellArg = null;
  if (argv[0] && argv[0].charAt(0) === '/' && argv[0] !== __filename && fs.existsSync(argv[0])) {
    shellArg = argv.shift();
  }
  var cmd = argv[0];
  // login shell mode: no command (ssh, getty, su) or a login convention
  // argument (-user from su -l, -l, -i): attach a detached session,
  // else start a new one. The daemon's argv0 is node, so a leading-dash
  // argv[0] is not visible here; the argument shape decides.
  var loginMode = (cmd === undefined ||
    (cmd.charAt(0) === '-' && !KNOWN_CMDS[cmd]));
  // the daemon starts its shell with its own environment, so a termd run
  // from inside a session has TERMD_SESSION (and, for wslogin daemons,
  // TERMD_COOKIE) set: a nested daemon would register in the outer
  // registry and append to the outer log, and an attach would feed the
  // session's output back into its own input.
  // 'session' itself stays allowed: it is the daemon command, which the
  // wslogin bridge starts with TERMD_COOKIE set
  var allowedInside = { session: 1, list: 1, ping: 1, kill: 1, '-h': 1, '--help': 1, help: 1 };
  if ((process.env.TERMD_SESSION || process.env.TERMD_COOKIE) &&
      (loginMode || !allowedInside[cmd])) {
    console.log('termd: refusing to run inside termd session ' +
      (process.env.TERMD_SESSION || process.env.TERMD_COOKIE) +
      '; detach with Ctrl-] first (list and kill are allowed)');
    process.exit(1);
  }
  if (loginMode) {
    if (shellArg) process.env.TERMD_SHELL = shellArg;
    collectList(function (list) {
      var free = list.filter(function (s) { return !s.owner; });
      if (list.length > 0 && free.length > 0) clientAttach(free[0].id, false);
      else clientNew();
    });
    return;
  }
  if (cmd === '-c') { execShell(shellArg || realShell(), ['-c'].concat(argv.slice(1))); return; }
  switch (cmd) {
    case 'session': runSession(parseInt(argv[1], 10) || 80, parseInt(argv[2], 10) || 24); break;
    case 'daemon': clientNew(); break;
    case 'new': clientNew(); break;
    case 'attach': clientAttach(argv[1], false); break;
    case 'view': clientAttach(argv[1], true); break;
    case 'list': clientList(); break;
    case 'ping': clientPing(); break;
    case 'kill': if (!argv[1]) { usage(); process.exit(2); } clientKill(argv[1]); break;
    case '-h': case '--help': case 'help': usage(); break;
    default: console.log('termd: unknown command ' + cmd); usage(); process.exit(2);
  }
}

main();
