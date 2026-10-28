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
// registry: $XDG_RUNTIME_DIR/termd/<id>.sock + <id>.meta; list scans it.
// clients speak the wslogin framing: '\x01' + raw data, '\x00' + JSON.
// daemon speaks: '\x00' resize, '\x01' snapshot/output, '\x00' b64, '\x00' exit.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SCROLLBACK = 10000;
const VERSION = '0.1.0';

function now() { return Date.now() / 1000; }
function runtimeDir() { return process.env.XDG_RUNTIME_DIR || '/tmp'; }
function regDir() { return process.env.TERMD_DIR || path.join(runtimeDir(), 'termd'); }
function sockPath(id) { return path.join(regDir(), id + '.sock'); }
function metaPath(id) { return path.join(regDir(), id + '.meta'); }
function logPath(id) { return process.env.TERMD_LOG || path.join(regDir(), 'sess-' + id + '.jsonl'); }

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

// ---------------------------------------------------------------- session daemon

function runSession(cols, rows) {
  if (!validSize(cols, rows)) { cols = 80; rows = 24; }
  fs.mkdirSync(regDir(), { recursive: true, mode: 0o700 });
  var id = crypto.randomUUID();
  var shell = process.env.SHELL || '/bin/bash';
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
  fs.writeFileSync(metaPath(id), JSON.stringify({ id: id, cols: cols, rows: rows, start: now(), shell: shell }));
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
    cwd: process.env.HOME || '/', encoding: null, env: process.env
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
  wss.on('connection', function (ws, req) {
    var cred = null;
    try { cred = req.socket.getPeerCredentials(); } catch (e) {}
    if (cred && cred.uid !== 0 && cred.uid !== process.getuid()) {
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

function connectSock(id, cb) {
  var tries = 0;
  var attempt = function () {
    var ws = new WebSocket('ws+unix://' + sockPath(id));
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

function probe(id, cb) {
  var ws = new WebSocket('ws+unix://' + sockPath(id));
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

function registryIds(cb) {
  var ids = [];
  try {
    for (const f of fs.readdirSync(regDir())) {
      if (f.endsWith('.sock')) ids.push(f.slice(0, -5));
    }
  } catch (e) {}
  cb(ids);
}

function collectList(cb) {
  registryIds(function (ids) {
    var found = [];
    var pending = ids.length;
    if (pending === 0) { cb(found); return; }
    ids.forEach(function (id) {
      probe(id, function (info) {
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
        (s.title ? '  ' + s.title : ''));
    }
    console.log(out.length ? out.join('\n') : 'no sessions');
  });
}

function clientKill(id) {
  connectSock(id, function (e, ws) {
    if (!ws) { console.log('no such session: ' + id); process.exit(1); }
    ws.send('\x00' + JSON.stringify({ cmd: 'kill' }));
    ws.on('message', function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 1000);
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

function clientNew() {
  var cols = process.stdout.columns || 80, rows = process.stdout.rows || 24;
  var child = spawn(process.execPath, [__filename, 'session', String(cols), String(rows)],
    { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  var tries = 0;
  var attachNew = function () {
    registryIds(function (ids) {
      var fresh = ids.filter(function (id) {
        try { return fs.statSync(metaPath(id)).mtimeMs > Date.now() - 10000; } catch (e) { return false; }
      });
      if (fresh.length === 0 && tries++ < 20) { setTimeout(attachNew, 250); return; }
      if (fresh.length === 0) { console.log('session daemon did not start'); process.exit(1); }
      connectSock(fresh[0], function (e, ws) {
        if (!ws) { console.log('cannot attach to new session: ' + (e ? e.message : '')); process.exit(1); }
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
    connectSock(sessId, function (e, ws) {
      if (!ws) { console.log('session is gone (' + sessId + ')'); process.exit(1); }
      bridge(ws, view === true);
      ws.send('\x00' + JSON.stringify({ cmd: 'attach', id: sessId, view: view === true }));
    });
  };
  if (id) { start(id); return; }
  collectList(function (list) { pickSession(list, start); });
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
    '  kill <id>   kill a session\n' +
    '  daemon      alias for new (compat)\n' +
    '\n' +
    'Ctrl-] detaches; the session keeps running and is reattached on the next run.\n' +
    'view: Ctrl-C exits, arrows/PageUp/PageDown scroll, Home/End jump to top/bottom.\n' +
    'one detached daemon per session, registry: ' + regDir());
}

function main() {
  var cmd = process.argv[2];
  if (!cmd) {
    collectList(function (list) {
      var free = list.filter(function (s) { return !s.owner; });
      if (list.length > 0 && free.length > 0) clientAttach(free[0].id, false);
      else clientNew();
    });
    return;
  }
  switch (cmd) {
    case 'session': runSession(parseInt(process.argv[3], 10) || 80, parseInt(process.argv[4], 10) || 24); break;
    case 'daemon': clientNew(); break;
    case 'new': clientNew(); break;
    case 'attach': clientAttach(process.argv[3], false); break;
    case 'view': clientAttach(process.argv[3], true); break;
    case 'list': clientList(); break;
    case 'kill': if (!process.argv[3]) { usage(); process.exit(2); } clientKill(process.argv[3]); break;
    case '-h': case '--help': case 'help': usage(); break;
    default: console.log('termd: unknown command ' + cmd); usage(); process.exit(2);
  }
}

main();
