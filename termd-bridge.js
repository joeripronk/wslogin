'use strict';

// termd-bridge.js - wslogin side of termd (github.com/joeripronk/termd).
//
// In termd mode wslogin-server is a thin proxy: a per-session termd
// daemon (spawned as the session user) owns the shell pty, the terminal
// model and the recording; wslogin authenticates browser clients and
// relays frames between the websocket and the daemon's unix socket.
// termdLink returns a node-pty compatible adapter so wire_session works
// unchanged: file=false (the daemon logs).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

var deps = null;

function init(d) {
  deps = d;
}

function termdDir(username) {
  return path.join(deps.termdBase, username);
}

function termdSockPath(username, id) {
  return path.join(termdDir(username), id + '.sock');
}

// Directory layout: the base is owned by
// the service user with the session user ACL-granted +wx, the per-user
// directory is created by (and owned by) the user and inherits the
// default ACL that keeps the service user in.
function ensureTermdDir(username) {
  var base = deps.termdBase;
  try { fs.mkdirSync(base, { recursive: true, mode: 0o755 }); } catch (e) {}
  var bacl = deps.spawnSync('setfacl', ['-d', '-m', 'u:' + deps.wsloginUser + ':rwx', base]);
  if (bacl.status !== 0) {
    console.error('setfacl defaults on ' + base + ' for ' + deps.wsloginUser + ' failed: ' + bacl.stderr);
  }
  // '+wx' (add entry, keep mask) is rejected as EINVAL by setfacl 2.3.x on
  // tmpfs; set the entry and the mask explicitly so the session user can
  // create and traverse his socket dir
  var uacl = deps.spawnSync('setfacl', ['-m', 'u:' + username + ':rwx,m::rwx', base]);
  if (uacl.status !== 0) console.error('setfacl ' + base + ' for ' + username + ' failed: ' + uacl.stderr);
  var mk = deps.runAs(username, ['mkdir', '-p', termdDir(username)]);
  if (mk.status !== 0) console.error('mkdir ' + termdDir(username) + ' as ' + username + ' failed: ' + mk.stderr);
}

function termdSpawn(username, sessioncookie, cols, rows, meta, cb) {
  ensureTermdDir(username);
  var u = deps.lookupUser(username);
  if (!u) { cb(new Error('user ' + username + ' not found')); return; }
  var logfile = deps.sessionLogPath(username, sessioncookie);
  fs.mkdirSync(path.dirname(logfile), { recursive: true });
  var dacl = deps.spawnSync('setfacl', ['-m', 'u:' + username + ':rwx', path.dirname(logfile)]);
  if (dacl.status !== 0) console.error('setfacl log dir for ' + username + ' failed: ' + dacl.stderr);
  var dfacl = deps.spawnSync('setfacl', ['-d', '-m', 'u:' + deps.wsloginUser + ':rw', path.dirname(logfile)]);
  if (dfacl.status !== 0) console.error('setfacl default acl on log dir for ' + username + ' failed: ' + dfacl.stderr);
  var prefix = deps.userRunPrefix(username);
  var args = ['env',
    'HOME=' + u.home, 'USER=' + username, 'LOGNAME=' + username,
    'SHELL=' + (u.shell || '/bin/bash'), 'PATH=/usr/local/bin:/usr/bin:/bin',
    'LANG=en_US.UTF-8', 'COLORTERM=truecolor',
    'TERMD_DIR=' + termdDir(username),
    'TERMD_LOG=' + logfile,
    'TERMD_COOKIE=' + sessioncookie];
  if (meta.viewid) args.push('VIEWID=' + meta.viewid);
  if (meta.viewurl) args.push('VIEWURL=' + meta.viewurl);
  if (meta.shareid) args.push('SHAREID=' + meta.shareid);
  if (meta.shareurl) args.push('SHAREURL=' + meta.shareurl);
  args.push(deps.nodeCommand, deps.termdCommand, 'session', String(cols), String(rows));
  var child = spawn(prefix[0], prefix.slice(1).concat(args), { detached: true, stdio: 'ignore', cwd: '/' });
  child.unref();
  // Identify the daemon by its own log header (c:4 carries the cookie it
  // was spawned with and its socket path): scanning the registry by mtime
  // is racy, socket connects update the mtime and concurrent spawns are
  // indistinguishable. The daemon writes the header before it listens.
  var header = function () {
    var d;
    try {
      var line = fs.readFileSync(logfile, 'utf8').split('\n')[0];
      d = JSON.parse(line);
    } catch (e) { return null; }
    if (!d || d.c !== 4) return null;
    try {
      var m = JSON.parse(d.d);
      if (m.sessioncookie !== sessioncookie || !m.termd) return null;
      return path.basename(String(m.termd)).replace(/\.sock$/, '');
    } catch (e) { return null; }
  };
  var tries = 0;
  var poll = function () {
    var id = header();
    if (id) { cb(null, id); return; }
    if (tries++ > 50) { cb(new Error('termd daemon did not write its log header')); return; }
    setTimeout(poll, 200);
  };
  setTimeout(poll, 200);
}

function probeSock(sockPath, cb) {
  var ws = new WebSocket('ws+unix://' + sockPath);
  var done = false;
  var finish = function (info) { if (done) return; done = true; try { ws.close(); } catch (e) {} cb(info); };
  var timer = setTimeout(function () { finish(null); }, 1000);
  ws.on('open', function () {
    ws.on('message', function (raw) {
      var m = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (String.fromCharCode(m[0]) !== '\x00') return;
      var j;
      try { j = JSON.parse(m.slice(1).toString('utf8')); } catch (e) { return; }
      if (j.cmd === 'sessions' && j.list && j.list.length) { clearTimeout(timer); finish(j.list[0]); }
    });
    ws.send('\x00' + JSON.stringify({ cmd: 'list' }));
  });
  ws.on('error', function () { clearTimeout(timer); finish(null); });
}

function termdList(username, cb) {
  var ids = [];
  try {
    for (const f of fs.readdirSync(termdDir(username))) {
      if (f.endsWith('.sock')) ids.push(f.slice(0, -5));
    }
  } catch (e) { cb([]); return; }
  var out = [];
  var pending = ids.length;
  if (pending === 0) { cb(out); return; }
  ids.forEach(function (id) {
    probeSock(termdSockPath(username, id), function (info) {
      if (info) out.push(info);
      if (--pending === 0) cb(out);
    });
  });
}

// The rendered screen of a daemon (picker snapshots): attach read-only,
// collect the snapshot frames, settle when the frames stop arriving.
function termdSnapshot(username, id, cb) {
  var ws = new WebSocket('ws+unix://' + termdSockPath(username, id));
  var snap = '';
  var cols = 80, rows = 24;
  var done = false;
  var settle = null;
  var finish = function () {
    if (done) return;
    done = true;
    if (settle) clearTimeout(settle);
    try { ws.close(); } catch (e) {}
    cb(snap ? { serialized: snap, cols: cols, rows: rows } : null);
  };
  var timer = setTimeout(finish, 2000);
  ws.on('open', function () { ws.send('\x00' + JSON.stringify({ cmd: 'attach', id: id, view: true })); });
  ws.on('message', function (raw) {
    var m = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    var kind = String.fromCharCode(m[0]);
    var body = m.slice(1).toString('utf8');
    if (kind === '\x01') {
      snap += body;
      if (settle) clearTimeout(settle);
      settle = setTimeout(function () { clearTimeout(timer); finish(); }, 250);
      return;
    }
    try {
      var j = JSON.parse(body);
      if (j.cmd === 'attached') { cols = j.cols; rows = j.rows; }
    } catch (e) {}
  });
  ws.on('error', function () { clearTimeout(timer); finish(); });
  ws.on('close', function () { if (settle) clearTimeout(settle); settle = setTimeout(function () { clearTimeout(timer); finish(); }, 250); });
}

// node-pty compatible adapter over the daemon socket. wire_session uses
// .on('data'|'resize'|'exit'), .write(), .resize(), .kill(), .cols/.rows,
// .main and .file (false: the daemon writes the session log itself).
function termdLink(username, id, view) {
  var link = new EventEmitter();
  link.cols = 80;
  link.rows = 24;
  link.main = false;
  link.file = false;
  link.termd = id;
  var ws = new WebSocket('ws+unix://' + termdSockPath(username, id));
  var opened = false;
  var pendingResize = null;
  ws.on('open', function () {
    opened = true;
    ws.send('\x00' + JSON.stringify({ cmd: 'attach', id: id, view: view === true }));
    if (pendingResize) {
      ws.send('\x00' + JSON.stringify({ cmd: 'resize', cols: pendingResize[0], rows: pendingResize[1] }));
      pendingResize = null;
    }
  });
  ws.on('message', function (raw) {
    var m = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    var kind = String.fromCharCode(m[0]);
    var body = m.slice(1);
    if (kind === '\x01') { link.emit('data', body); return; }
    var j;
    try { j = JSON.parse(body.toString('utf8')); } catch (e) { return; }
    if (j.cmd === 'resize') {
      link.cols = j.cols; link.rows = j.rows;
      link.emit('resize');
    } else if (j.cmd === 'exit') {
      link.exitCode = j.status;
      link.emit('exit', j.status);
    }
  });
  ws.on('close', function () { link.dead = true; link.emit('linkclose'); });
  ws.on('error', function (e) {
    if (!opened) link.emit('linkerror', e);
  });
  link.write = function (s) { if (ws.readyState === 1) ws.send('\x01' + s); };
  link.resize = function (c, r) {
    if (ws.readyState === 1) ws.send('\x00' + JSON.stringify({ cmd: 'resize', cols: c, rows: r }));
    else if (!opened) pendingResize = [c, r];
  };
  link.kill = function () { if (ws.readyState === 1) ws.send('\x00' + JSON.stringify({ cmd: 'kill' })); };
  link.close = function () { try { ws.close(); } catch (e) {} };
  return link;
}

module.exports = {
  init: init,
  ensureTermdDir: ensureTermdDir,
  termdSpawn: termdSpawn,
  termdList: termdList,
  termdSnapshot: termdSnapshot,
  termdLink: termdLink,
  probeSock: probeSock,
  termdSockPath: termdSockPath
};
