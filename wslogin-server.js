process.title = 'wslogin';

var webSocketServer = require('websocket').server;
//const isValidUTF8 = require('utf-8-validate');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const pty = require('node-pty');
const { spawn, spawnSync } = require('child_process');
const { Terminal } =  require ("@xterm/headless");
//const { Terminal } =  require ("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { loadSslOptions, allowPlaintext } = require('./ssl');
const { render: renderTemplate, placeholders: templatePlaceholders,
  match: matchTemplate, isSafeRelative } = require('./template');
const { createPlayback } = require('./playback');
const { createSsoAuth, parseCookieHeader } = require('./auth');
const { v4: uuid_v4 } = require('uuid');
const userid = require('userid');
var pam = require('authenticate-pam');
// keep in sync with the browser terminal scrollback (www/wslogin.js) and
// the playback viewer (playback.js); tmux keeps no scrollback of its own
// (tmux.conf history-limit 0), wslogin's session log is the history
const SCROLLBACK = 2000;
function now() {
  return Date.now()/1000;
  //var hrTime = process.hrtime()
  //return (hrTime[0] * 1000000) + (hrTime[1] / 1000)
}

var ini = require('ini');
var configPath = process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini';
if (!fs.existsSync(configPath)) {
  console.error("configuration file not found: "+configPath);
  process.exit(1);
}
var config = ini.parse(fs.readFileSync(configPath, 'utf-8',true));
console.log("using configuration file "+configPath);
if ('cookie_dir' in config) {
  console.log("cookie_dir="+config.cookie_dir);
} else {
  console.log("no cookie_dir, local sessions disabled");
}

function configInt(name, fallback) {
  if (!(name in config)) return fallback;
  var value = parseInt(config[name], 10);
  return Number.isFinite(value) ? value : fallback;
}
function configBool(name, fallback) {
  if (!(name in config)) return fallback;
  var value = String(config[name]).toLowerCase();
  return !(value=='0' || value=='false' || value=='no' || value=='off');
}

var max_cols = configInt('max_cols', 1000);
var max_rows = configInt('max_rows', 500);
function validSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols >= 1 && rows >= 1 && cols <= max_cols && rows <= max_rows;
}

var checkpoint_enabled = configBool('checkpoint_enabled', true);
var checkpoint_interval_seconds = Math.max(0, configInt('checkpoint_interval_seconds', 3600));
var checkpoint_bytes = Math.max(0, configInt('checkpoint_bytes', 1024 * 1024));
if (checkpoint_interval_seconds==0 && checkpoint_bytes==0) {
  checkpoint_enabled=false;
}
console.log("checkpoints: enabled="+checkpoint_enabled
  +" interval="+checkpoint_interval_seconds+"s bytes="+checkpoint_bytes);

// Run each session shell under a per-session tmux server so it outlives a
// wslogin restart; on startup live sessions are re-attached (see resume_sessions).
var session_tmux = configBool('session_tmux', true);
console.log("session_tmux="+session_tmux);

// Addresses whose X-Forwarded-For header we trust to carry the real client
// address (reverse proxies, load balancers). Defaults to loopback.
var trusted_ips = String('trusted_ips' in config ? config.trusted_ips : '127.0.0.1,::1')
  .split(',')
  .map(function(entry) { return normalizeIp(entry.trim()); })
  .filter(function(entry) { return entry.length > 0; });
console.log("trusted_ips="+trusted_ips.join(','));

function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
function ipIsTrusted(ip) {
  return trusted_ips.indexOf(normalizeIp(ip)) !== -1;
}
// The real peer address: the X-Forwarded-For client when the socket comes
// from a trusted proxy, otherwise the socket address itself.
function clientIpOf(request) {
  var remote = normalizeIp(request.remoteAddress);
  var headers = request.headers || {};
  if (ipIsTrusted(remote) && headers['x-forwarded-for']) {
    var forwarded = String(headers['x-forwarded-for']).split(',')[0].trim();
    if (forwarded) return normalizeIp(forwarded);
  }
  return remote;
}

var secret_key_re = /(passphrase|password|secret)/i;
function redactConfig(cfg) {
  function redact(node) {
    if (node === null || typeof node != 'object') return node;
    if (Array.isArray(node)) return node.map(redact);
    var copy = {};
    for (const key in node) {
      copy[key] = (secret_key_re.test(key) && typeof node[key] == 'string' && node[key])
        ? '***' : redact(node[key]);
    }
    return copy;
  }
  return redact(cfg);
}

console.log(JSON.stringify(redactConfig(config)));
var shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

const webSocketsServerPort = configInt('port', 9022);
var session_dir = config.session_dir
  ? path.resolve(__dirname, config.session_dir)
  : path.join(__dirname, 'sessions');
console.log("session_dir="+session_dir);
// The active session layout, relative to session_dir. Only <username> and
// <session> are allowed here; uploader.js uses the same template.
var session_template = config.session_template
  ? String(config.session_template)
  : '<username>/<session>.json';
var session_template_names = templatePlaceholders(session_template);
session_template_names.delete('username');
session_template_names.delete('session');
if (session_template_names.size > 0) {
  console.error("session_template may only use <username> and <session>: "
    + session_template);
  process.exit(1);
}
if (!session_template.endsWith('.json')) {
  console.error("session_template must end in .json: "+session_template);
  process.exit(1);
}
console.log("session_template="+session_template);

// Run the server as an unprivileged service user (default: wslogin) when
// root starts it. The sudo setup is verified first: the user must exist,
// sudo must be installed, the user must be able to sudo (NOPASSWD) to every
// user except root, must be able to read /etc/shadow (PAM password login),
// and the port must be bindable unprivileged. When all checks pass the
// server hands itself over with sudo; otherwise it warns and keeps running
// as root. Set run_as_user=root in the config to disable this entirely.
var run_as_user = 'run_as_user' in config ? String(config.run_as_user).trim() : 'wslogin';
var sudoers_hint = run_as_user+" ALL=(ALL:!root) NOPASSWD: ALL\n      "+run_as_user+" ALL=(root) ALL\n      (the second line is required for sudo-rs, which ignores the !root exclusion)";
function sudoProbe(args) {
  return spawnSync('sudo', args, { encoding: 'utf8' });
}
function ensureWritableDirs(username) {
  var dirs = [__dirname, session_dir];
  if ('playback_cache_dir' in config) {
    dirs.push(path.resolve(__dirname, String(config.playback_cache_dir)));
  }
  dirs.forEach(function(dir) {
    spawnSync('mkdir', ['-p', dir]);
    var out = spawnSync('chown', ['-R', username+':', dir]);
    if (out.status !== 0) console.error("chown "+dir+" to "+username+" failed");
  });
  // the recursive chown above would strip the setuid helper; it must stay
  // root-owned with the setuid bit (see wslogin-run.c)
  var helper = path.join(__dirname, 'wslogin-run');
  if (fs.existsSync(helper)) {
    spawnSync('chown', ['root:root', helper]);
    spawnSync('chmod', ['4755', helper]);
  }
  if ('cookie_dir' in config) {
    // chown the cookie directory itself only: cookie files are created by
    // the users and their owner identifies the login; chowning them to the
    // service user would turn a later cookie login into a wslogin session
    spawnSync('mkdir', ['-p', String(config.cookie_dir)]);
    var cout = spawnSync('chown', [username+':', String(config.cookie_dir)]);
    if (cout.status !== 0) console.error("chown "+config.cookie_dir+" to "+username+" failed");
    spawnSync('chmod', ['1777', String(config.cookie_dir)]);
  }
}
function dropPrivileges(username) {
  var problems = [];
  var u = lookupUser(username);
  if (!u) {
    problems.push("user "+username+" does not exist; create it with: useradd --system --shell /usr/sbin/nologin "+username);
  }
  if (spawnSync('sh', ['-c', 'command -v sudo'], { encoding: 'utf8' }).status !== 0) {
    problems.push("sudo is not installed");
  }
  if (webSocketsServerPort < 1024) {
    problems.push("port "+webSocketsServerPort+" is privileged; use a port above 1024 or grant node CAP_NET_BIND_SERVICE: setcap cap_net_bind_service=+ep "+process.execPath);
  }
  if (problems.length === 0) {
    var probe = sudoProbe(['-u', username, 'sudo', '-n', '-u', username, 'id', '-u']);
    if (probe.status !== 0 || parseInt(probe.stdout, 10) !== u.uid) {
      problems.push("user "+username+" cannot sudo to normal users without a password; create /etc/sudoers.d/"+username+" with:\n      "+sudoers_hint);
    } else if (sudoProbe(['-u', username, 'sudo', '-n', '-u', 'root', 'id', '-u']).status === 0) {
      problems.push("user "+username+" can sudo to root; the sudoers rule must exclude root:\n      "+sudoers_hint);
    }
    if (sudoProbe(['-u', username, 'sh', '-c', 'test -r /etc/shadow']).status !== 0) {
      problems.push("user "+username+" cannot read /etc/shadow, PAM password logins will fail; add it to the shadow group: usermod -aG shadow "+username);
    }
  }
  if (problems.length > 0) {
    console.warn("sudo setup for user "+username+" is incomplete, running as root:");
    problems.forEach(function(problem) { console.warn("  - "+problem); });
    console.warn("fix the setup above to run wslogin as "+username+"; run_as_user=root silences this warning");
    return;
  }
  ensureWritableDirs(username);
  console.log("sudo setup for user "+username+" verified, handing over via sudo");
  // Detach the handover: sudo -b alone stays as the parent of the server
  // (it waits to relay the exit status). Running the server as
  // sh -c 'exec setsid ... &' inside sudo -b lets sudo exit immediately
  // and reparents the server to init, so no root-owned sudo stays in the
  // process list. sudo -b sends the child's stdio to /dev/null, so pipe
  // the output through systemd-cat to keep it in the journal (plain
  // /dev/null when systemd-cat is not installed).
  var cmd = ['env', 'WSLOGIN_CONFIG='+configPath, process.execPath]
    .concat(process.argv.slice(1)).map(shQuote).join(' ');
  var has_cat = spawnSync('sh', ['-c', 'command -v systemd-cat'], { encoding: 'utf8' }).status === 0;
  var redir = has_cat ? ' 2>&1 | systemd-cat -t wslogin' : ' >/dev/null 2>&1';
  var r = spawnSync('sudo', ['-b', '-u', username, 'sh', '-c',
    'setsid '+cmd+redir+' &'], { stdio: 'inherit', cwd: __dirname });
  process.exit(r.status === null ? 1 : r.status);
}
if (process.getuid() === 0 && run_as_user !== '' && run_as_user !== 'root') {
  dropPrivileges(run_as_user);
}

function session_log_path(username, sessioncookie) {
  var relative = renderTemplate(session_template,
    {username: username, session: sessioncookie});
  if (!isSafeRelative(relative)) {
    throw new Error("session_template produced unsafe path "+relative);
  }
  return path.join(session_dir, relative);
}
function session_checkpoint_path(username, sessioncookie) {
  var file = session_log_path(username, sessioncookie);
  return file.slice(0, -'.json'.length) + '.checkpoint.json';
}
// Per-session tmux server socket. The socket directory must be traversable
// by the wslogin service user (it removes stale sockets) and writable by
// the session user (the tmux server creates the socket and its lock file
// in it), so it lives under a server-wide base directory (default
// /run/wslogin/tmux): the base is owned by wslogin (mode 755) with the
// user ACL-granted (+wx), and <base>/<username> is created by and owned by
// the user, inheriting the default ACL that gives wslogin rwx. The shell
// lives in this tmux server, independent of the wslogin process, so a
// wslogin restart can find it again and re-attach.
var tmux_socket_dir = config.tmux_socket_dir
  ? path.resolve(String(config.tmux_socket_dir))
  : '/run/wslogin/tmux';
console.log("tmux_socket_dir="+tmux_socket_dir);
var WSLOGIN_USER = (process.userInfo && process.userInfo.username) || 'wslogin';
function lookupUser(username) {
  try {
    var lines = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].split(':');
      if (f[0] === username) {
        return { home: f[5] || ('/home/' + username), shell: f[6] || '/bin/bash',
          uid: parseInt(f[2], 10) };
      }
    }
  } catch (error) {}
  return null;
}
function session_tmux_dir(username) {
  return path.join(tmux_socket_dir, username);
}
function session_tmux_path(username, sessioncookie) {
  return path.join(session_tmux_dir(username), sessioncookie + '.tmux');
}
var tmux_conf = path.join(__dirname, 'tmux.conf');
// wslogin runs per-user commands (tmux server start, attach, queries) as
// the session user. node-pty attaches its direct child to the terminal, and
// only root can become another user: the child is the small setuid helper
// wslogin-run, which drops to the session user and execs the command as a
// single process, so no sudo stays in the process list for the lifetime of
// the view and no sudo/pam noise lands in the journal. Falls back to
// sudo -u when the helper is not installed. Defined here (before the
// startup scan) so the resume path uses it too.
var run_helper = fs.existsSync(path.join(__dirname, 'wslogin-run'))
  ? path.join(__dirname, 'wslogin-run') : null;
console.log("per-user helper: "+(run_helper ? run_helper : "sudo -u (wslogin-run not installed)"));
function user_run_prefix(username) {
  return run_helper ? [run_helper, username] : ['sudo', '-u', username];
}
// Run a command as the session user: wslogin-run helper when installed,
// sudo -u otherwise.
function run_as(username, args, options) {
  var prefix = user_run_prefix(username);
  return spawnSync(prefix[0], prefix.slice(1).concat(args), options);
}
// termd mode: sessions run in per-session termd daemons (pty owner,
// terminal model and recording live in the daemon); wslogin becomes the
// authenticating proxy between browser clients and daemon sockets.
var termd_enabled = configBool('termd', false);
var termd_base = config.termd_dir
  ? path.resolve(String(config.termd_dir))
  : '/run/wslogin/termd';
var termd_command = config.termd_command
  ? path.resolve(String(config.termd_command))
  : path.join(__dirname, 'termd.js');
var termd = require('./termd-bridge');
termd.init({
  termdBase: termd_base, termdCommand: termd_command, nodeCommand: process.execPath,
  wsloginUser: WSLOGIN_USER, runAs: run_as, spawnSync: spawnSync, lookupUser: lookupUser,
  userRunPrefix: user_run_prefix, sessionLogPath: session_log_path
});
if (termd_enabled) checkpoint_enabled = false;
console.log("termd mode: enabled=" + termd_enabled + " dir=" + termd_base + " command=" + termd_command);
// The tailer is the last record of a finished log (c=5). Its payload records
// the file size and SHA-256 of the log without the tailer itself plus the
// session end time, so a finished log can be verified without trusting the
// surrounding transport.
function file_sha256(file, size) {
  var hash = crypto.createHash('sha256');
  var fd = fs.openSync(file, 'r');
  try {
    var buffer = Buffer.alloc(256*1024);
    var offset = 0;
    while (offset < size) {
      var read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size-offset), offset);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function last_record_time(file, size) {
  var length = Math.min(size, 256*1024);
  var fd = fs.openSync(file, 'r');
  try {
    var buffer = Buffer.alloc(length);
    var read = fs.readSync(fd, buffer, 0, length, size-length);
    var lines = buffer.toString('utf-8', 0, read).replace(/\n+$/,'').split('\n');
    for (var i=lines.length-1; i>=0; i--) {
      try {
        var record = JSON.parse(lines[i]);
        if (record.c !== 5 && Number.isFinite(record.t) && record.t > 0) return record.t;
      } catch (error) {}
    }
  } finally { fs.closeSync(fd); }
  return null;
}
function has_tailer(file) {
  var stat;
  try { stat = fs.statSync(file); } catch (error) { return false; }
  if (stat.size === 0) return false;
  var length = Math.min(stat.size, 256*1024);
  var fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { return false; }
  try {
    var buffer = Buffer.alloc(length);
    var read = fs.readSync(fd, buffer, 0, length, stat.size-length);
    var lines = buffer.toString('utf-8', 0, read).replace(/\n+$/,'').split('\n');
    try {
      var record = JSON.parse(lines[lines.length-1]);
      return record.c === 5;
    } catch (error) { return false; }
  } finally { fs.closeSync(fd); }
}
function write_tailer(file) {
  var stat = fs.statSync(file);
  if (stat.size === 0) return;
  var endtime = last_record_time(file, stat.size);
  if (endtime == null) endtime = stat.mtimeMs/1000;
  var tail = {t:endtime, c:5, d:JSON.stringify({
    size:stat.size,
    sha256:file_sha256(file, stat.size),
    endtime:endtime
  })};
  fs.appendFileSync(file, JSON.stringify(tail)+'\n');
  console.log("added tailer to "+file);
}
// Renaming the log of an ended session signals uploader.js that the session is
// complete and can be uploaded. Checkpoints are not uploaded.
function finish_path(file) {
  try {
    if (fs.existsSync(file)) {
      if (!has_tailer(file)) write_tailer(file);
      fs.renameSync(file, file+'.done');
      console.log("marked "+file+" as finished");
    }
  } catch (error) {
    console.error("error marking "+file+" as finished: "+error.message);
  }
}
function finish_session(username, sessioncookie) {
  try {
    finish_path(session_log_path(username, sessioncookie));
  } catch (error) {
    console.error("error finishing session "+username+"/"+sessioncookie
      +": "+error.message);
  }
}

// Read the c:4 header record (first line) of a session log. Returns the meta
// object, or null when the log is empty/not a header.
function read_session_header(file) {
  var fd;
  try {
    fd = fs.openSync(file, 'r');
    var buf = Buffer.alloc(65536);
    var len = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
  } catch (error) {
    return null;
  }
  var nl = buf.indexOf(0x0a, 0, len);
  if (nl < 0) return null;
  try {
    var rec = JSON.parse(buf.slice(0, nl).toString('utf8'));
    if (rec && rec.c === 4) return JSON.parse(rec.d);
  } catch (error) {}
  return null;
}

// The session's current reconnect token, persisted outside the session
// log: the log (and its header) is uploaded to receivers, and the token
// is a credential. The sidecar file is server-owned, never uploaded
// (the uploader only picks up .json files), and lets browser and cli
// clients reconnect across a wslogin restart.
function save_reconnect_token(username, sessioncookie) {
  var session = sessions[username] && sessions[username][sessioncookie];
  if (!session || !session.reconnectid) return;
  try {
    fs.writeFileSync(session_log_path(username, sessioncookie) + '.reconnect',
      session.reconnectid, {mode: 0o600});
  } catch (error) {}
}

function read_reconnect_token(username, sessioncookie) {
  try {
    var token = fs.readFileSync(session_log_path(username, sessioncookie)
      + '.reconnect', 'utf-8').trim();
    return /^[0-9a-zA-Z-]+$/.test(token) ? token : null;
  } catch (error) {
    return null;
  }
}

function delete_reconnect_token(username, sessioncookie) {
  try {
    fs.rmSync(session_log_path(username, sessioncookie) + '.reconnect',
      {force: true});
  } catch (error) {}
}

// Rebuild a live session from its header meta after a wslogin restart. The
// tmux server (and the shell in it) survived; re-attach and restore the map
// entries so the user can reconnect.
function resume_session(meta) {
  var username = meta.username, sessioncookie = meta.sessioncookie;
  var cols = meta.cols || 80, rows = meta.rows || 24;
  // reconnectid is deliberately not stored in the session log header (the
  // header is uploaded with the log); the current token is kept in the
  // local sidecar file so reconnect tokens survive a restart
  var reconnectid = read_reconnect_token(username, sessioncookie)
    || meta.reconnectid || uuid_v4();
  sessions[username] = sessions[username] || {};
  sessions[username][sessioncookie] = {
    viewid: meta.viewid, shareid: meta.shareid,
    reconnectid: reconnectid, connections: {}
  };
  var session = sessions[username][sessioncookie];
  session.sessioncookie = sessioncookie;
  session.checkpoint_path = session_checkpoint_path(username, sessioncookie);
  var logfile = session_log_path(username, sessioncookie);
  try { session.logBytes = fs.statSync(logfile).size; } catch (error) { session.logBytes = 0; }
  session.mirror = create_mirror(cols, rows);
  reconnects[reconnectid] = {username: username, sessioncookie: sessioncookie};
  save_reconnect_token(username, sessioncookie);
  views[meta.viewid] = {sessioncookie: sessioncookie, username: username};
  shares[meta.shareid] = {sessioncookie: sessioncookie, username: username};
  var shellenv = { USER: username, VIEWID: meta.viewid, VIEWURL: meta.viewurl, SUDO_USER: username, LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' };
  session.pty = attach_tmux(username, sessioncookie, cols, rows, shellenv, meta.tmux);
  session.pty.file = fopen(logfile, 'a+');
  session.pty.main = false;
  wire_session(username, sessioncookie);
  console.log("resumed session "+sessioncookie+" for "+username+" tmux "+meta.tmux);
  if (checkpoint_enabled && session.mirror) {
    create_replayed_terminal(logfile, session.checkpoint_path).then(function(serial) {
      if (session.mirror) {
        session.mirror.terminal.resize(serial.cols, serial.rows);
        session.mirror.terminal.write(serial.s);
        // restore the window title the session had before the restart
        var title = extract_title(serial.s);
        if (title) session.mirror.title = title;
      }
    }).catch(function() {});
  }
}
// A termd session whose daemon is gone (killed via the termd CLI, daemon
// crash, exit while wslogin was down): nothing will ever deliver an exit
// frame for a detached session, so wslogin must drop the map entries
// itself once a probe shows the socket is dead.
function termd_cleanup_gone(username, sessioncookie) {
  var session = sessions[username] && sessions[username][sessioncookie];
  if (!session) return;
  for (const idx in session.connections) {
    try { session.connections[idx].close(); } catch (e) {}
  }
  finish_session(username, sessioncookie);
  if (session.viewid) delete views[session.viewid];
  if (session.shareid) delete shares[session.shareid];
  if (session.reconnectid) delete reconnects[session.reconnectid];
  delete_reconnect_token(username, sessioncookie);
  delete sessions[username][sessioncookie];
  if (Object.keys(sessions[username]).length === 0) delete sessions[username];
  console.log("termd session "+sessioncookie+" for "+username+" is gone, cleaned up");
  notifyPickers(username);
}

// Rebuild a live termd session from its log header after a wslogin
// restart: the daemon (shell, model, recording) survived; probe its socket
// and restore the map entries so the session shows up detached in the
// picker and a reconnect re-links it.
function termd_resume(meta) {
  termd.probeSock(meta.termd, function (info) {
    if (!info) {
      console.log("termd daemon for "+meta.sessioncookie+" is gone, log finished");
      finish_session(meta.username, meta.sessioncookie);
      return;
    }
    var username = meta.username, sessioncookie = meta.sessioncookie;
    var reconnectid = read_reconnect_token(username, sessioncookie)
      || meta.reconnectid || uuid_v4();
    sessions[username] = sessions[username] || {};
    sessions[username][sessioncookie] = {
      viewid: meta.viewid, shareid: meta.shareid,
      reconnectid: reconnectid, connections: {}
    };
    var session = sessions[username][sessioncookie];
    session.sessioncookie = sessioncookie;
    session.termd = path.basename(meta.termd).replace(/\.sock$/, '');
    session.cols = info.cols || meta.cols || 80;
    session.rows = info.rows || meta.rows || 24;
    session.pty = false;
    reconnects[reconnectid] = {username: username, sessioncookie: sessioncookie};
    save_reconnect_token(username, sessioncookie);
    if (meta.viewid) views[meta.viewid] = {sessioncookie: sessioncookie, username: username};
    if (meta.shareid) shares[meta.shareid] = {sessioncookie: sessioncookie, username: username};
    console.log("resumed termd session "+sessioncookie+" for "+username+" sock "+meta.termd);
    notifyPickers(username);
  });
}

// Link wslogin to a detached termd session (owner or viewer, by view).
// The daemon sends attached+resize+snapshot on link; wire_session
// relays them to the connections (the reconnecting client is paused and
// gets them through its sendbuffer, drained by termd_replay).
function termd_reattach(username, sessioncookie, cols, rows, view, connection) {
  var session = sessions[username][sessioncookie];
  var link = termd.termdLink(username, session.termd, view === true);
  link.main = false;
  link.on('linkerror', function (e) {
    console.error("termd link failed for "+sessioncookie+": "+e.message);
    if (connection) {
      try { connection.sendUTF('\0' + JSON.stringify({cmd: "reconnectfailed"})); } catch (err) {}
    }
    termd_cleanup_gone(username, sessioncookie);
  });
  link.on('linkclose', function () {
    // the daemon died (crash, kill) while this link was the live side:
    // the session is detached from wslogin's point of view; the probe
    // sweep removes it once the socket is confirmed gone
    if (session.pty === link) {
      session.cols = link.cols; session.rows = link.rows;
      session.pty = false;
      notifyPickers(username);
    }
  });
  session.pty = link;
  session.cols = cols; session.rows = rows;
  wire_session(username, sessioncookie);
  link.resize(cols, rows);
}

// termd replacement for replay_pty: the snapshot already arrived (or is
// arriving) through the link and was buffered for the paused client;
// drain the buffer and complete the handshake.
function termd_replay(username, sessioncookie, connection) {
  var session = sessions[username][sessioncookie];
  var finish = function () {
    while (connection.sendbuffer.length > 0) {
      var buf = connection.sendbuffer.shift();
      if (buf !== false) connection.sendUTF(buf);
    }
    connection.paused = false;
    if (connection.shared || connection.viewonly) {
      connection.sendUTF('\0' + JSON.stringify({cmd: "replaydone"}));
    } else {
      connection.sendUTF('\0' + JSON.stringify({cmd: "reconnected", viewid: session.viewid,
        shareid: session.shareid, reconnect: session.reconnectid, personalized: personalizedLinks}));
    }
  };
  // A viewer/sharer joins a session whose live link belongs to the owner:
  // the daemon snapshot only reaches the link, so fetch one for this
  // viewer; live frames buffered while paused are drained after it, in
  // the right order. A viewer of a session without an owner gets its own
  // link, whose snapshot already lands in the sendbuffer - no fetch.
  if ((connection.viewonly || connection.shared) && session.termd &&
      session.pty && !session.pty.dead && session.pty.main) {
    termd.termdSnapshot(username, session.termd, function (snap) {
      if (snap) {
        try {
          connection.sendUTF('\0' + JSON.stringify({cmd: "resize", cols: snap.cols, rows: snap.rows}));
          connection.sendUTF('\x01' + snap.serialized);
        } catch (e) {}
      }
      finish();
    });
    return;
  }
  setTimeout(finish, 300);
}

// Live-session state, declared before the startup scan (finish_interrupted_
// sessions / resume_session) that rebuilds sessions from disk.
// connection index counter; connections are reachable through the sessions
// maps, no global list is kept, so closed clients do not accumulate
var nextIndex = 0;
// failed login tracking, ip -> {count, first, blocked_until}. Attempts are
// counted when they arrive, not when PAM answers, so parallel floods are
// bound by the same limit; a success clears the counter.
// null-prototype maps: ids and ips are attacker-controlled keys, a plain
// {} would let '__proto__' and friends pass `in` checks.
var logins = Object.create(null);
var login_max_attempts = configInt('login_max_attempts', 5);
var login_window_seconds = configInt('login_window_seconds', 300);
var login_block_seconds = configInt('login_block_seconds', 900);
function loginBlockSeconds(ip) {
  var a = logins[ip];
  if (!a || !a.blocked_until) return 0;
  var left = a.blocked_until - now();
  if (left <= 0) { delete logins[ip]; return 0; }
  return left;
}
function loginAttempt(ip) {
  var t = now();
  var a = logins[ip];
  if (!a || t - a.first > login_window_seconds) a = {count:0, first:t};
  a.count++;
  if (login_max_attempts > 0 && a.count > login_max_attempts) {
    a.blocked_until = t + login_block_seconds;
    console.log("login blocked for "+ip+" for "+login_block_seconds
      +"s after "+a.count+" login attempts");
  }
  logins[ip] = a;
}
var sessions = Object.create(null);
var views = Object.create(null);
var shares = Object.create(null);
var reconnects = Object.create(null);

// A log that still exists without the .done suffix at startup belongs to a
// session that was interrupted by a crash, so mark it finished for uploader.js.
// Finished logs that predate the tailer record get one appended.
function finish_interrupted_sessions() {
  if (!fs.existsSync(session_dir)) return;
  function walk(dir, relative) {
    var entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      console.error("error scanning "+dir+": "+error.message);
      return;
    }
    for (var i=0; i<entries.length; i++) {
      var entry = entries[i];
      var rel = relative ? relative+'/'+entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      var finished = null;
      if (entry.name.endsWith('.done')) finished = -'.done'.length;
      else if (entry.name.endsWith('.uploaded')) finished = -'.uploaded'.length;
      if (finished !== null) {
        var baseRel = rel.slice(0, finished);
        if (!baseRel.endsWith('.json')
            || baseRel.endsWith('.checkpoint.json')
            || baseRel.endsWith('.meta.json')) continue;
        if (!matchTemplate(session_template, baseRel, ['username', 'session'])) {
          continue;
        }
        var file = path.join(dir, entry.name);
        try {
          if (!has_tailer(file)) write_tailer(file);
        } catch (error) {
          console.error("error tailing "+file+": "+error.message);
        }
        continue;
      }
      if (!entry.name.endsWith('.json')
          || entry.name.endsWith('.checkpoint.json')
          || entry.name.endsWith('.meta.json')) continue;
      var parts = matchTemplate(session_template, rel, ['username', 'session']);
      if (!parts) continue;
      var file = path.join(dir, entry.name);
      var meta = read_session_header(file);
      if (termd_enabled && meta && meta.termd && meta.username && meta.sessioncookie
          && meta.termd.startsWith(termd_base + path.sep)) {
        termd_resume(meta);
      } else if (session_tmux && meta && meta.tmux && meta.username && meta.sessioncookie
          && meta.tmux.startsWith(tmux_socket_dir + path.sep)
          && tmux_alive(meta.username, meta.tmux)) {
        resume_session(meta);
      } else {
        if (session_tmux && meta && meta.tmux && meta.username
            && !meta.tmux.startsWith(tmux_socket_dir + path.sep)
            && tmux_alive(meta.username, meta.tmux)) {
          // old socket layout (e.g. in the user's home): the log is
          // retired, kill the orphaned tmux server with its shell
          console.log("killing tmux server with retired socket "+meta.tmux);
          run_as(meta.username, ['tmux', '-S', meta.tmux, 'kill-server']);
        }
        finish_path(file);
      }
    }
  }
  walk(session_dir, '');
}
finish_interrupted_sessions();
var wwwdir = "www"; 

var playback = null;
try {
  playback = createPlayback(config, {
    baseDir: __dirname,
    hostname: os.hostname(),
    isActive: function(username, session) {
      return !!(sessions[username] && sessions[username][session]
        && sessions[username][session].pty);
    },
    sso: {user: function(request, callback) {
      ssoPlaybackUser(request, callback);
    }},
    authenticate: function(username, password, callback) {
      pam.authenticate(username, password, function(error) {
        callback(error);
      }, {serviceName: config.playback_auth_service || 'sshd'});
    }
  });
} catch (error) {
  console.error("playback configuration error: "+error.message);
  process.exit(1);
}
console.log("playback: enabled="+playback.enabled+" dir="+playback.sessionDir
  +" www="+playback.wwwDir+" cache="+playback.cacheDir
  +" auth="+playback.authRequired);

var writeQueues = new Map();
function writeAll(fd,buffer) {
  return new Promise(function(resolve) {
    var offset=0;
    function next() {
      if (offset>=buffer.length) { resolve(); return; }
      fs.write(fd,buffer,offset,buffer.length-offset,null,
        function(err,written) {
          if (err) {
            console.error("error: " + err.message);
            resolve();
            return;
          }
          if (!written) { resolve(); return; }
          offset+=written;
          next();
        });
    }
    next();
  });
}
function write(fd,d) {
  var buffer=Buffer.isBuffer(d) ? d : Buffer.from(String(d),'utf8');
  var previous=writeQueues.get(fd) || Promise.resolve();
  var pending=previous.catch(function() {}).then(function() {
    return writeAll(fd,buffer);
  });
  writeQueues.set(fd,pending);
  function done() {
    if (writeQueues.get(fd)===pending) writeQueues.delete(fd);
  }
  pending.then(done,done);
  return pending;
}
function fopen(fname,flags) {
  return fs.openSync(fname,flags);
}
function serialize_terminal(terminal, serializeAddon, viewportOnly) {
  const {isCursorHidden} = terminal._core._inputHandler._coreService;
  // scrollback: 0 serializes the visible screen only (thumbnails do not
  // need the mirror's history, checkpoints do for reconnects)
  return serializeAddon.serialize(viewportOnly ? {scrollback:0} : undefined)+(isCursorHidden ? '\x1b[?25l' : '\x1b[?25h');
}

function load_checkpoint(file, checkpointfile) {
  if (!fs.existsSync(checkpointfile)) {
    return null;
  }
  try {
    var checkpoint=JSON.parse(fs.readFileSync(checkpointfile, 'utf-8'));
    if (checkpoint.version!==1 ||
        !Number.isInteger(checkpoint.offset) || checkpoint.offset<0 ||
        !Number.isInteger(checkpoint.cols) || checkpoint.cols<1 ||
        !Number.isInteger(checkpoint.rows) || checkpoint.rows<1 ||
        typeof checkpoint.serialized !== 'string') {
      console.log("ignoring invalid checkpoint "+checkpointfile);
      return null;
    }
    if (checkpoint.offset > fs.statSync(file).size) {
      console.log("ignoring checkpoint past end of "+file);
      return null;
    }
    console.log("using checkpoint "+checkpointfile+" at offset "+checkpoint.offset);
    return checkpoint;
  } catch (error) {
    console.error("error reading checkpoint "+checkpointfile+": "+error.message);
    return null;
  }
}

async function create_replayed_terminal (file, checkpointfile) {
  var checkpoint=checkpointfile ? load_checkpoint(file, checkpointfile) : null;
  return new Promise((resolve, reject) => {
    // scrollback matching the browser terminal (wslogin.js): the serialized
    // replay carries this much history to the reconnecting client
    var terminal = new Terminal({ allowProposedApi: true, scrollback: SCROLLBACK });
    var serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    const finish = function() {
      terminal.write("",function () {
        const {isCursorHidden} = terminal._core._inputHandler._coreService;
        if (isCursorHidden) {
          console.log("cursor is hidden");
        }
        resolve({cols:terminal.cols,rows:terminal.rows,s:serialize_terminal(terminal, serializeAddon)});
      })
    };
    const replay = function() {
      var options=checkpoint ? {start:checkpoint.offset} : undefined;
      var rd = readline.createInterface({
        input: fs.createReadStream(file, options),
        terminal: false
      });
      rd.on('line', function(line) {
        try {
          var json=JSON.parse(line);
          if (json.c==0) {
            const c=JSON.parse(json.d);
            if (c.cmd=="resize") {
              terminal.resize(c.cols,c.rows);
            } else if (c.cmd=="b64") {
              terminal.write(Buffer.from(c.data,'base64'));
            }
          } else if (json.c==1) {
            terminal.write(json.d);
          }
        } catch (error) {
          console.error("error replaying "+file+": "+error.message);
        }
      }).on('close', finish).on('error', function(error) {
        // a cleaned up (deleted) log must not kill the server: replay
        // what is there (nothing) and continue with the live session
        console.error("error reading "+file+": "+error.message);
        finish();
      });
    };
    if (checkpoint) {
      terminal.resize(checkpoint.cols,checkpoint.rows);
      terminal.write(checkpoint.serialized, function() { replay(); });
    } else {
      replay();
    }
  });
}

function create_mirror(cols, rows) {
  if (!checkpoint_enabled) {
    return null;
  }
  var terminal = new Terminal({ allowProposedApi: true, scrollback: SCROLLBACK });
  var serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  terminal.resize(cols, rows);
  return {
    terminal: terminal,
    serializeAddon: serializeAddon,
    queue: [],
    offset: 0,
    bytesSinceCheckpoint: 0,
    lastCheckpoint: now(),
    busy: false,
    saving: false,
    saveRequested: false
  };
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Start a detached per-session tmux server, running as the user, with the
// user's shell as its only pane. The shell is a direct child of the user's
// tmux server (no lingering sudo), and survives a wslogin restart. Returns
// true when the session is up.
function start_tmux_session(username, sessioncookie, cols, rows, env) {
  var u = lookupUser(username);
  if (!u) { console.error("no passwd entry for "+username); return false; }
  var sock = session_tmux_path(username, sessioncookie);
  var dir = session_tmux_dir(username);
  // The per-user socket directory is owned by the user (their tmux server
  // creates the socket and lock file in it). Default ACLs on the base
  // directory give wslogin rw on everything created below it: wslogin can
  // traverse the path and connect the attach client to the socket,
  // even though tmux forces the socket to mode 0600 (the mask inherited
  // from the default ACL keeps wslogin's entry effective).
  var base = path.dirname(dir);
  try { fs.mkdirSync(base, { recursive: true, mode: 0o755 }); } catch (error) {}
  var bacl = spawnSync('setfacl', ['-d', '-m', 'u:'+WSLOGIN_USER+':rwx',
    '-d', '-m', 'm::rwx', base]);
  if (bacl.status !== 0) {
    console.error("setfacl defaults on "+base+" for "+WSLOGIN_USER+" failed: "
      +bacl.stderr+"; tmux sockets will be owner-only and attaching will fail");
  }
  // the user needs write on the base directory to create his socket dir;
  // '+wx' (add entry, keep mask) is rejected as EINVAL by setfacl 2.3.x on
  // tmpfs, so set the entry and the mask explicitly
  var uacl = spawnSync('setfacl', ['-m', 'u:'+username+':rwx,m::rwx', base]);
  if (uacl.status !== 0) console.error("setfacl "+base+" for "+username+" failed: "+uacl.stderr);
  var st = null;
  try { st = fs.statSync(dir); } catch (error) {}
  if (!st) {
    var mk = run_as(username, ['mkdir', '-p', dir]);
    if (mk.status !== 0) console.error("mkdir "+dir+" as "+username+" failed: "+mk.stderr);
  } else if (st.uid !== (lookupUser(username)||{}).uid) {
    console.error(dir+" exists with unexpected owner uid "+st.uid+", session attach may fail");
  }
  var shell = u.shell || '/bin/bash';
  var viewid = ((env && env.VIEWID) || '');
  var viewurl = ((env && env.VIEWURL) || '');
  // Pane command: env -i drops everything tmux and sudo inject (TMUX,
  // TMUX_PANE, TERM_PROGRAM*, SUDO_*, SHLVL, PWD) and starts a login shell
  // with a minimal, hand-picked environment.
  var panecmd = "exec env -i HOME=" + shQuote(u.home) + " SHELL=" + shQuote(shell) +
    " USER=" + shQuote(username) + " LOGNAME=" + shQuote(username) +
    " PATH=/usr/local/bin:/usr/bin:/bin" +
    " LANG=en_US.UTF-8 COLORTERM=truecolor TERM=xterm-256color" +
    " VIEWID=" + shQuote(viewid) + " VIEWURL=" + shQuote(viewurl) +
    " " + shQuote(shell) + " -l";
  var args = user_run_prefix(username).concat(['env',
    'USER=' + username, 'LOGNAME=' + username, 'HOME=' + u.home,
    'SHELL=' + shell, 'PATH=/usr/local/bin:/usr/bin:/bin',
    'VIEWID=' + viewid, 'VIEWURL=' + viewurl,
    'tmux', '-S', sock]);
  if (fs.existsSync(tmux_conf)) args.push('-f', tmux_conf);
  args.push('new-session', '-d', '-s', 'main',
    '-x', String(cols), '-y', String(rows), panecmd);
  // No cwd: the service user cannot enter the user's home (mode 700) and a
  // spawnSync child chdir there would fail with EACCES; the pane command's
  // login shell changes into HOME itself.
  var prog = args.shift();
  var out = spawnSync(prog, args);
  if (out.status !== 0) {
    console.error("tmux new-session failed for "+username+" "+sessioncookie
      +": "+(out.stderr ? out.stderr : out.error ? out.error.message
      : "status "+out.status));
    return false;
  }
  return tmux_alive(username, sock);
}

function attach_tmux(username, sessioncookie, cols, rows, env, sock) {
  if (!sock) sock = session_tmux_path(username, sessioncookie);
  var args = user_run_prefix(username).concat(
    ['env', 'TERM=xterm-256color', 'tmux', '-S', sock, 'attach', '-t', 'main']);
  var prog = args.shift();
  return pty.spawn(prog, args, {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: '/',
    encoding: null,
    env: env
  });
}

// Is a tmux server with this socket alive and showing its session?
// Runs as the session's user via sudo, so it works unprivileged too.
function tmux_alive(username, sock) {
  var out = run_as(username, ['tmux', '-S', sock, 'list-sessions'], { encoding: 'utf8' });
  return out.status === 0 && /main/.test(out.stdout);
}

function kill_tmux_session(username, sessioncookie) {
  var sock = session_tmux_path(username, sessioncookie);
  run_as(username, ['tmux', '-S', sock, 'kill-server']);
  try { fs.unlinkSync(sock); } catch (error) {}
}

// Detach the tmux attach clients of a session; used when the wslogin side
// of a view goes away (pty exit, owner disconnect) so no client lingers on
// the tmux server. tmux 3.x has no kill-client, clients are detached by
// their tty (the target accepted by detach-client).
function kill_tmux_clients(username, sessioncookie) {
  var sock = session_tmux_path(username, sessioncookie);
  var out = run_as(username, ['tmux', '-S', sock, 'list-clients', '-F', '#{client_tty}'],
    { encoding: 'utf8' });
  if (out.status !== 0) return;
  String(out.stdout).split('\n').forEach(function(entry) {
    var tty = entry.trim();
    if (!tty.startsWith('/dev/')) return;
    run_as(username, ['tmux', '-S', sock, 'detach-client', '-t', tty]);
  });
}

function append_session_log(session, log) {
  var text=JSON.stringify(log)+'\n';
  var bytes=Buffer.byteLength(text);
  session.logBytes=(session.logBytes||0)+bytes;
  if (session.pty && session.pty.file) {
    write(session.pty.file,text);
  }
  return {offset:session.logBytes,bytes:bytes};
}

function pump_mirror(session) {
  var mirror=session.mirror;
  if (!mirror || mirror.busy) return;
  var op=mirror.queue.shift();
  if (!op) return;
  mirror.busy=true;
  const done=function() {
    mirror.offset=op.offset;
    if (op.type=='data') {
      mirror.bytesSinceCheckpoint+=op.bytes;
    }
    mirror.busy=false;
    maybe_save_checkpoint(session);
    pump_mirror(session);
  };
  try {
    if (op.type=='resize') {
      mirror.terminal.resize(op.cols,op.rows);
      done();
    } else {
      mirror.terminal.write(op.data,done);
    }
  } catch (error) {
    console.error("error updating checkpoint terminal: "+error.message);
    mirror.busy=false;
    pump_mirror(session);
  }
}

// The window title a terminal last set with OSC 0/2. The headless mirror
// terminal ignores title sequences, so it is tracked from the raw stream.
function extract_title(s) {
  var last = '';
  var re = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  var m;
  s = String(s);
  while ((m = re.exec(s)) !== null) last = m[1];
  return last;
}

function queue_mirror(session, op) {
  if (!session.mirror) return;
  if (op.type === 'data' && session.mirror) {
    var title = extract_title(op.data);
    if (title) session.mirror.title = title;
  }
  session.mirror.queue.push(op);
  pump_mirror(session);
}

// Wire a session's tmux-attach pty to the log, the mirror and its viewers.
// Used both when a session is created and when it is resumed after a restart.
function wire_session(username, sessioncookie) {
  var session = sessions[username][sessioncookie];
  var ptyproc = session.pty;
  var lastCols = ptyproc.cols, lastRows = ptyproc.rows;
  ptyproc.on('data', function(data) {
    var senddata=false;
    // node-pty emits raw Buffers (encoding: null). A utf8 round-trip that
    // yields the same bytes proves the chunk is valid utf8; invalid bytes
    // (8-bit apps, binary noise) go through the base64 channel instead of
    // being corrupted into U+FFFD by the utf8 coercion.
    var text=data.toString('utf8');
    if (Buffer.compare(Buffer.from(text,'utf8'), data) === 0) {
      var log={t:now(),d:text,c:1};
      var written=append_session_log(session,log);
      queue_mirror(session,{type:'data',data:text,offset:written.offset,bytes:written.bytes});
      senddata='\1'+ text;
    } else {
      var cmd={cmd:'b64',data:data.toString('base64')};
      var log={t:now(),d:JSON.stringify(cmd),c:0};
      var written=append_session_log(session,log);
      // keep the checkpoint mirror in sync: xterm accepts raw Buffers
      queue_mirror(session,{type:'data',data:data.slice(),offset:written.offset,bytes:written.bytes});
      senddata='\0'+ JSON.stringify(cmd);
    }
    for (const [key, conn] of Object.entries(session['connections'])) {
      if (conn.paused) {
        bufferSend(conn, senddata);
      } else {
        conn.sendUTF(senddata);
      }
    }
  });
  ptyproc.on('resize', function() {
    // node-pty fires 'resize' on every resize() call, also no-op ones;
    // a same-size resize reflows the mirror's whole scrollback and
    // appends a duplicate resize op to the log, so ignore it
    if (ptyproc.cols === lastCols && ptyproc.rows === lastRows) return;
    lastCols = ptyproc.cols; lastRows = ptyproc.rows;
    var resize={cmd:"resize",rows:ptyproc.rows,cols:ptyproc.cols};
    var cmdtext='\0'+JSON.stringify(resize);
    var log={t:now(),d:JSON.stringify(resize),c:0};
    var written=append_session_log(session,log);
    queue_mirror(session,{type:'resize',cols:resize.cols,rows:resize.rows,offset:written.offset,bytes:written.bytes});
    for (const [key, conn] of Object.entries(session.connections)) {
      if (conn.paused) {
        bufferSend(conn, cmdtext);
      } else {
        conn.send(cmdtext);
      }
    }
  });
  ptyproc.on('exit', function(data) {
    console.log("pty "+sessioncookie+" for "+username+" exited with status "+ data);
    var log={t:now(),d:data,c:3};
    append_session_log(session,log);
    close_pty_file(ptyproc);
    if (!termd_enabled && session_tmux && tmux_alive(username, session_tmux_path(username, sessioncookie))) {
      // the tmux server and its shell survive this view (owner disconnect,
      // wslogin restart): drop any lingering attach clients and keep the
      // session alive for a reconnect. The attach client is gone, so the
      // session is marked detached (pty=false); a reconnect re-attaches
      // (see create_pty).
      kill_tmux_clients(username, sessioncookie);
      session.cols = ptyproc.cols;
      session.rows = ptyproc.rows;
      session.pty = false;
      notifyPickers(username);
      return;
    }
    for (const [key, conn] of Object.entries(session['connections'])) {
      if (ptyproc.main == conn) {
        sendInfo(conn,"Your session ended");
      } else {
        sendInfo(conn,"Session ended");
      }
      conn.close();
    }
    finish_session(username, sessioncookie);
    delete views[session.viewid];
    delete reconnects[session.reconnectid];
    delete_reconnect_token(username, sessioncookie);
    delete shares[session.shareid];
    if (!termd_enabled) kill_tmux_session(username, sessioncookie);
    delete sessions[username][sessioncookie];
    if (Object.keys(sessions[username]).length===0) {
      delete sessions[username];
    }
    notifyPickers(username);
  });
}

// Close the log fd of a pty only after the queued writes on this fd have
// run: closing immediately races with the write queue, and node reuses the
// fd number for the next session, so late writes would hit EBADF or, worse,
// the log of a new session.
function close_pty_file(ptyproc) {
  if (!ptyproc.file) return;
  var fd = ptyproc.file;
  ptyproc.file = false;
  var pending = writeQueues.get(fd) || Promise.resolve();
  writeQueues.delete(fd);
  pending.then(function() { fs.close(fd, function() {}); },
               function() { fs.close(fd, function() {}); });
}

// Re-attach a detached session (tmux server alive, attach client gone,
// e.g. after the owner disconnected): spawn a fresh tmux attach client,
// reopen its log and wire it like on creation.
function reattach_session(username, sessioncookie, cols, rows) {
  var session = sessions[username][sessioncookie];
  var shellenv = { USER: username, VIEWID: session.viewid, SUDO_USER: username,
    LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' };
  session.pty = attach_tmux(username, sessioncookie, cols, rows, shellenv);
  session.pty.file = fopen(session_log_path(username, sessioncookie), 'a+');
  session.pty.main = false;
  wire_session(username, sessioncookie);
  console.log("re-attached "+sessioncookie+" for "+username);
}

function checkpoint_due(session) {
  var mirror=session.mirror;
  if (!mirror || !checkpoint_enabled || mirror.bytesSinceCheckpoint<=0) return false;
  var bytesdue=checkpoint_bytes>0 && mirror.bytesSinceCheckpoint>=checkpoint_bytes;
  var timedue=checkpoint_interval_seconds>0 && (now()-mirror.lastCheckpoint)>=checkpoint_interval_seconds;
  return bytesdue || timedue;
}

function maybe_save_checkpoint(session) {
  var mirror=session.mirror;
  if (!mirror || mirror.busy || mirror.saving) return;
  if (!mirror.saveRequested && !checkpoint_due(session)) return;
  if (save_checkpoint(session)) mirror.saveRequested=false;
}

function save_checkpoint(session) {
  var mirror=session.mirror;
  if (!session.pty || !session.pty.file || !session.checkpoint_path) return false;
  var offset=mirror.offset;
  try {
    if (fs.fstatSync(session.pty.file).size < offset) {
      return false;
    }
  } catch (error) {
    return false;
  }
  var checkpoint={
    version:1,
    offset:offset,
    cols:mirror.terminal.cols,
    rows:mirror.terminal.rows,
    time:now(),
    serialized:serialize_terminal(mirror.terminal, mirror.serializeAddon)
  };
  var tmp=session.checkpoint_path+'.tmp';
  mirror.saving=true;
  mirror.bytesSinceCheckpoint=0;
  mirror.lastCheckpoint=now();
  fs.writeFile(tmp, JSON.stringify(checkpoint), function(error) {
    if (error) {
      console.error("error writing checkpoint "+tmp+": "+error.message);
      mirror.saving=false;
      return;
    }
    fs.rename(tmp, session.checkpoint_path, function(error) {
      if (error) {
        console.error("error saving checkpoint "+session.checkpoint_path+": "+error.message);
      } else {
        console.log("checkpoint saved for "+session.sessioncookie+" at offset "+offset);
      }
      mirror.saving=false;
    });
  });
  return true;
}

function checkpoint_on_disconnect(session) {
  if (!session || !session.mirror) return;
  session.mirror.saveRequested=true;
  maybe_save_checkpoint(session);
}

setInterval(function() {
  for (const username in sessions) {
    for (const sessioncookie in sessions[username]) {
      var session=sessions[username][sessioncookie];
      if (session && session.mirror) {
        maybe_save_checkpoint(session);
      }
    }
  }
  for (const token in reconnects) {
    var r=reconnects[token];
    if (r.stale && (now()-r.time)>7*24*3600) {
      delete reconnects[token];
    }
  }
  for (const ip in logins) {
    var a = logins[ip];
    if (now()-a.first > login_block_seconds+login_window_seconds) delete logins[ip];
  }
  }, 1000).unref();

// termd sweep: a detached session whose daemon no longer answers (killed
// via the termd CLI, daemon crash) has no event source that could ever
// tell wslogin, so probe the registry sockets periodically and clean up
// the ghosts.
var termd_sweep = setInterval(function() {
  if (!termd_enabled) return;
  for (const username in sessions) {
    for (const sessioncookie in sessions[username]) {
      var session = sessions[username][sessioncookie];
      if (session && session.termd && session.pty === false && !session.probed) {
        session.probed = true;
        termd.probeSock(termd.termdSockPath(username, session.termd), (function(user, cookie) {
          return function(info) {
            var s = sessions[user] && sessions[user][cookie];
            if (s) s.probed = false;
            if (!info) termd_cleanup_gone(user, cookie);
          };
        })(username, sessioncookie));
      }
    }
  }
}, 60000).unref();

function sendError(c,msg) {
  cmd={cmd:'error',error:msg};
  console.log("sending error " + msg);
  c.sendUTF('\0'+JSON.stringify(cmd));
}
function sendWarn(c,msg) {
  cmd={cmd:'warn',warn:msg};
  console.log("sending warn " + msg);
  c.sendUTF('\0'+JSON.stringify(cmd));
}
function sendInfo(c,msg) {
  cmd={cmd:'info',info:msg};
  console.log("sending info " + msg);
  c.sendUTF('\0'+JSON.stringify(cmd));
}
function peerLabel(connection) {
  return connection.peer || connection.ip || 'someone';
}
// cap per paused connection; a paused client that cannot keep up drops its
// oldest buffered data instead of growing the buffer without limit
var max_sendbuffer = configInt('max_sendbuffer', 2000);
function bufferSend(conn, data) {
  if (conn.sendbuffer.length >= max_sendbuffer) {
    conn.sendbuffer.shift();
  }
  conn.sendbuffer.push(data);
}

/**
 * HTTP server
 */
var static_types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};
function serve_www(request, response, relative) {
  var root = path.resolve(__dirname, wwwdir);
  var localpath = path.resolve(root, '.'+path.sep+relative);
  if (localpath != root && !localpath.startsWith(root+path.sep)) {
    response.statusCode = 400;
    response.end('bad path');
    return;
  }
  fs.stat(localpath, function(error, stat) {
    if (error || !stat.isFile()) {
      response.statusCode = 404;
      response.end('');
      return;
    }
    response.setHeader('Content-Type',
      static_types[path.extname(localpath).toLowerCase()]
      || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    fs.createReadStream(localpath).pipe(response);
  });
}
var ssoAuth = createSsoAuth();
if (ssoAuth) {
  console.log("sso login enabled for cookie "+ssoAuth.cookieName);
}
var personalizedLinks = !!(ssoAuth && ssoAuth.linkEnabled);
console.log("personalized links: "+(personalizedLinks?"enabled":"disabled (no linkshare_passphrase)"));
// The username of a request with a valid auth server session cookie
// (auth.ini) for the playback API, false when it has no usable sso
// session. Same checks as the websocket sso login: group, root and PAM
// verification of the password stored in the auth server session.
function ssoPlaybackUser(request, callback) {
  if (!ssoAuth) {
    callback(false);
    return;
  }
  var cookies = parseCookieHeader(request.headers.cookie);
  var value = cookies[ssoAuth.cookieName];
  if (!value) {
    callback(false);
    return;
  }
  var cred = ssoAuth.credentialsOf(value);
  if (!cred || !cred.user || cred.user == 'root') {
    callback(false);
    return;
  }
  if (ssoAuth.ssoGroup && !userInGroup(cred.user, ssoAuth.ssoGroup)) {
    console.log("sso user "+cred.user+" is not in group "+ssoAuth.ssoGroup);
    callback(false);
    return;
  }
  if (!ssoAuth.verifyPassword) {
    console.log("sso login for "+cred.user+" on playback (pam verification disabled)");
    callback(cred.user);
    return;
  }
  if (!cred.password) {
    console.log("sso session of "+cred.user+" has no stored password, pam verification impossible");
    callback(false);
    return;
  }
  pam.authenticate(cred.user, cred.password, function(error) {
    if (error) {
      console.log("pam verification failed for sso user "+cred.user+": "+error);
      callback(false);
      return;
    }
    console.log("sso login for "+cred.user+" on playback");
    callback(cred.user);
  }, {serviceName: ssoAuth.pamService});
}
function httpHandler(request, response) {
  var url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch (error) {
    response.statusCode = 400;
    response.end('bad request');
    return;
  }
  if (url.pathname == '/api/playback'
      || url.pathname.startsWith('/api/playback/')) {
    playback.handle(request, response, url).catch(function(error) {
      console.error("playback request failed: "+error.message);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end('internal server error');
      } else if (!response.writableEnded) {
        response.end();
      }
    });
    return;
  }
  if (url.pathname == '/playback') {
    response.statusCode = 302;
    response.setHeader('Location', '/playback/');
    response.end('');
    return;
  }
  if (url.pathname == '/playback/' || url.pathname.startsWith('/playback/')) {
    var asset = url.pathname.slice('/playback/'.length) || 'index.html';
    playback.serveStatic(response, asset);
    return;
  }
  var relative = url.pathname.substring(1);
  if(relative == '') {
    relative = 'index.html';
  }
  if (ssoAuth && (relative == 'index.html' || relative == 'i.html')) {
    var ssoUser = ssoAuth.username(request);
    if (ssoUser && (!ssoAuth.ssoGroup || userInGroup(ssoUser, ssoAuth.ssoGroup))) {
      var destHost = url.searchParams.get('d');
      var destPath = url.searchParams.get('u') || '/';
      if (destHost && ssoAuth.inDomain(destHost)
          && destPath.startsWith('/') && !destPath.startsWith('//')) {
        console.log("sso login for "+ssoUser+" to "+destHost+destPath);
        response.statusCode = 302;
        response.setHeader('Location', 'https://'+destHost+destPath);
        response.end('');
        return;
      }
    }
  }
  serve_www(request, response, relative);
}

var httpServer = http.createServer(httpHandler);

/**
 * HTTPS server, enabled through the [https] section of the configuration.
 * When no certificate and key are configured, a self-signed certificate
 * is generated automatically.
 */
var httpsServer = null;
var sslOptions = null;
try {
  sslOptions = loadSslOptions(config, {baseDir: __dirname});
} catch (error) {
  console.error("ssl configuration error: "+error.message);
  process.exit(1);
}
if (sslOptions) {
  httpsServer = https.createServer(sslOptions, httpHandler);
  console.log("https enabled using "+sslOptions.certFile
    + (sslOptions.selfSigned ? " (self-signed)" : ""));
}

var allow_http = allowPlaintext(config);
if (!httpsServer && !allow_http) {
  console.error("plain http is disabled but https is not enabled, there is nothing to serve");
  process.exit(1);
}
if (httpsServer && !allow_http) {
  console.log("plain http is disabled, only https/wss is served");
}

/**
 * When https is enabled both plain http and https are served on the same
 * port. The first byte of the connection tells us which protocol to use:
 * 0x16 is the start of a TLS handshake. Plain http connections are refused
 * when allow_http is disabled.
 */
var server = httpServer;
if (httpsServer) {
  server = net.createServer(function(socket) {
    socket.once('data', function(chunk) {
      socket.pause();
      socket.unshift(chunk);
      if (chunk[0] === 0x16) {
        httpsServer.emit('connection', socket);
      } else if (allow_http) {
        httpServer.emit('connection', socket);
        // the http server does not resume the socket for us
        socket.resume();
      } else {
        var message = "plain http is disabled, use https";
        socket.resume();
        socket.end("HTTP/1.1 403 Forbidden\r\n"
          +"Connection: close\r\n"
          +"Content-Type: text/plain\r\n"
          +"Content-Length: "+Buffer.byteLength(message)+"\r\n"
          +"\r\n"
          +message);
      }
    });
  });
}

server.listen(webSocketsServerPort, function() {
  console.log("Server is listening on port "
    + webSocketsServerPort
    + (httpsServer ? (allow_http ? " (http and https)" : " (https only)") : "") + ".");
});

/**
 * WebSocket server
 */
var wsServer = new webSocketServer({
  // WebSocket server is tied to a HTTP server. WebSocket
  // request is just an enhanced HTTP request. For more info 
  // http://tools.ietf.org/html/rfc6455#page-6
  httpServer: httpsServer ? (allow_http ? [httpServer, httpsServer] : httpsServer) : httpServer,
  autoAcceptConnections: false
});
// Origins allowed to run websocket clients, from config.allowed_origin
// (comma separated). A missing Origin header (non-browser clients) is
// always allowed; with no configured allowlist all origins are allowed.
var allowed_origins = 'allowed_origin' in config
  ? String(config.allowed_origin).split(',').map(function(entry) { return entry.trim(); })
      .filter(function(entry) { return entry.length > 0; })
  : [];
if (allowed_origins.length === 0) {
  console.log("no origin allowlist configured, any origin is accepted");
} else {
  console.log("allowed origins="+allowed_origins.join(','));
}
function originIsAllowed(origin) {
  if (!origin) return true;
  if (allowed_origins.length === 0) return true;
  return allowed_origins.indexOf(origin) !== -1;
}
function getUuidFromCookies(cookies,cookiename) {
  var filtered = cookies.filter(function(obj) {
    return obj.name == cookiename;
  });
  return filtered.length > 0 ? filtered[0].value : null;
}

// true when the request carries a local session cookie (uuid) whose cookie
// file is present, i.e. the client can reconnect to its own session.
function hasValidSessionCookie(uuidcookie) {
  if (!('cookie_dir' in config)) return false;
  if (typeof uuidcookie != 'string' || !/^[0-9a-zA-Z-]+$/.test(uuidcookie)) {
    return false;
  }
  try {
    fs.statSync(config.cookie_dir + '/cookie_' + uuidcookie + '.json');
    return true;
  } catch (error) {
    return false;
  }
}

// The username a local session cookie belongs to: cookie files are written
// by the in-session login helper, so the file owner is the session
// user. false for an unusable cookie.
function cookieUsername(uuidcookie) {
  if (!('cookie_dir' in config)) return false;
  if (typeof uuidcookie != 'string' || !/^[0-9a-zA-Z-]+$/.test(uuidcookie)) {
    return false;
  }
  try {
    var stat = fs.statSync(config.cookie_dir + '/cookie_' + uuidcookie + '.json');
    if (!('uid' in stat)) return false;
    var name = userid.username(stat.uid);
    return (name && name != 'root') ? name : false;
  } catch (error) {
    return false;
  }
}

// A rendered snapshot of a session's current screen, for a reconnect picker.
function serialize_mirror(session) {
  var mirror = session.mirror;
  if (!mirror || !mirror.terminal) return null;
  try {
    return {
      cols: mirror.terminal.cols,
      rows: mirror.terminal.rows,
      title: (mirror.title || mirror.terminal.title) || '',
      s: serialize_terminal(mirror.terminal, mirror.serializeAddon, true)
    };
  } catch (error) {
    return null;
  }
}

// The user's terminals that are running but have no owner connection (the
// owner disconnected): these can be reconnected to.
function listDisconnected(username) {
  var list = [];
  if (!username || !(username in sessions)) return list;
  for (const key in sessions[username]) {
    var s = sessions[username][key];
    // s.pty === false: detached session (daemon alive, link gone after
    // the owner disconnected); reconnect re-links it
    if (s.pty === false || (s.pty && s.pty.main === false)) {
      if (termd_enabled) {
        list.push({
          reconnectid: s.reconnectid,
          cols: s.cols || 80,
          rows: s.rows || 24,
          title: s.title || '',
          snapshot: s.snapshot || ''
        });
        if (s.termd && !s.snapshot) {
          termd.termdSnapshot(username, s.termd, (function (sess) {
            return function (snap) {
              if (!snap || sess.snapshot) return;
              sess.snapshot = snap.serialized;
              var t = extract_title(snap.serialized);
              if (t) sess.title = t;
              notifyPickers(username);
            };
          })(s));
        }
        if (s.termd && s.pty === false) {
          termd.probeSock(termd.termdSockPath(username, s.termd), (function (sess) {
            return function (info) {
              if (!info) termd_cleanup_gone(username, sess.sessioncookie);
            };
          })(s));
        }
        continue;
      }
      var snap = serialize_mirror(s);
      list.push({
        reconnectid: s.reconnectid,
        cols: s.pty ? s.pty.cols : (s.cols || 80),
        rows: s.pty ? s.pty.rows : (s.rows || 24),
        title: (snap && snap.title) || '',
        snapshot: snap ? snap.s : ''
      });
    }
  }
  return list;
}

// Connections currently showing the reconnect picker, by connection index.
// When a user's set of disconnected sessions changes (owner disconnects,
// a session is picked/reconnected, a session ends), the pickers of that
// user are pushed the fresh list so they update without a reload.
var pickers = {};
function notifyPickers(username) {
  if (!username) return;
  for (const idx in pickers) {
    var conn = pickers[idx];
    if (conn.pickerUser != username) continue;
    try {
      conn.sendUTF('\0' + JSON.stringify({cmd:"sessions", list:listDisconnected(username)}));
    } catch (error) {}
  }
}

var groupcache = {time:0, lines:[]};
function userInGroup(username, group) {
  var nowms = Date.now();
  if (nowms - groupcache.time > 10000) {
    try {
      groupcache.lines = fs.readFileSync('/etc/group', 'utf8').split('\n');
      groupcache.time = nowms;
    } catch (error) {
      console.error("cannot read /etc/group: "+error.message);
      return false;
    }
  }
  var gid = null;
  for (var i = 0; i < groupcache.lines.length; i++) {
    var fields = groupcache.lines[i].split(':');
    if (fields[0] == group) {
      gid = parseInt(fields[2], 10);
      if (fields[3].split(',').includes(username)) return true;
    }
  }
  if (gid == null || !Number.isFinite(gid)) return false;
  try {
    var users = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    for (var j = 0; j < users.length; j++) {
      var pw = users[j].split(':');
      if (pw[0] == username && parseInt(pw[3], 10) == gid) return true;
    }
  } catch (error) {
    console.error("cannot read /etc/passwd: "+error.message);
  }
  return false;
}


// This callback function is called every time someone
// tries to connect to the WebSocket server
wsServer.on('request', function(request) {
  var remote=request.remoteAddress;
  var uuidcookie=getUuidFromCookies(request.cookies,'uuid');
  var username = false;
  var sessioncookie=false;
  //var sessioncookie=getUuidFromCookies(request.cookies,'sessionuuid');
  if (!originIsAllowed(request.origin)) {
    request.reject();
    console.log('Connection['+ remote + '] from origin ' + request.origin + ' rejected.');
    return;
  }
  if (request.origin==undefined) {
    request.origin=config.origin
  }
  var clientIp = clientIpOf(request);

  console.log('Connection['+ remote+'] from origin '
    + request.origin + (clientIp!=normalizeIp(remote) ? ' client '+clientIp : ''));


  // accept connection - you should check 'request.origin' to
  // make sure that client is connecting from your website
  // (http://en.wikipedia.org/wiki/Same_origin_policy)
  var connection = request.accept(null, request.origin); 
  connection.rows=34;
  connection.columns=80;
  connection.loggedin=false;
  connection.paused=false;
  connection.sessioncookie=false;
  connection.username=false;
  connection.sendbuffer=[];
  connection.viewonly=false;
  connection.shared=false;
  connection.ip=clientIp;
  connection.peer=false;
  // we need to know client index to remove them on 'close' event
  connection.write = connection.send;
  connection.read = connection.socket.read;
  var liveQuery = (request.resourceURL && request.resourceURL.query) || {};
  var liveView = typeof liveQuery.view === 'string' ? liveQuery.view : null;
  var liveShare = typeof liveQuery.share === 'string' ? liveQuery.share : null;
  var ssoCred = ssoAuth ? ssoAuth.credentialsOf(getUuidFromCookies(request.cookies,ssoAuth.cookieName)) : false;
  var ssoUser = ssoCred ? ssoCred.user : false;
  var index = nextIndex++;
  connection.peer = (ssoUser && ssoUser != 'root') ? ssoUser : false;
  // Only use sso login when there is no valid local session cookie: a client
  // that can reconnect to its own session must not be auto-logged in via sso,
  // which would spawn a fresh session and drop the reconnect.
  if (ssoUser && ssoUser != 'root' && !liveView && !liveShare
      && !hasValidSessionCookie(uuidcookie)) {
    if (ssoAuth.ssoGroup && !userInGroup(ssoUser, ssoAuth.ssoGroup)) {
      console.log("sso user "+ssoUser+" is not in group "+ssoAuth.ssoGroup);
      connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
    } else if (ssoAuth.verifyPassword) {
      if (!ssoCred.password) {
        console.log("sso session of "+ssoUser+" has no stored password, pam verification impossible");
        connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
      } else {
        pam.authenticate(ssoUser, ssoCred.password, function(err) {
          if (err) {
            console.log("pam verification failed for sso user "+ssoUser+": "+err);
            connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
          } else {
            console.log("sso login for "+ssoUser+" on websocket");
            ssoAutoLogin(ssoUser);
          }
        }, {serviceName: ssoAuth.pamService, remoteHost: remote});
      }
    } else {
      console.log("sso login for "+ssoUser+" on websocket (pam verification disabled)");
      ssoAutoLogin(ssoUser);
    }
  } else {
    var cmd={cmd:"login"};
    connection.sendUTF('\0' + JSON.stringify(cmd));
  }
  /*
    if (uuidcookie==undefined) {
      uuidcookie=uuid_v4();
      var cmd={cmd:"cookie",cookie:'uuid='+uuidcookie};
      connection.sendUTF('\0' + JSON.stringify(cmd));
    }
    */
  async function replay_pty(username,sessioncookie,cols,rows,connection) {
    console.log("reconnected to "+sessioncookie+" "+sessions[username][sessioncookie].pty.file);
    var checkpointfile=checkpoint_enabled ? session_checkpoint_path(username,sessioncookie) : null;
    var serial = await create_replayed_terminal(session_log_path(username,sessioncookie), checkpointfile);
    connection.sendUTF('\0'+JSON.stringify({cmd:"resize",cols:serial.cols,rows:serial.rows}));
    connection.sendUTF('\1'+serial.s);
    console.log("sending replayed terminal");
    console.log("done sending replay for "+sessioncookie);
    if (connection.shared || connection.viewonly) {
      var cmd={cmd:"replaydone"};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log("send replaydone to "+sessioncookie);
    } else {
      var cmd={cmd:"reconnected",viewid:sessions[username][sessioncookie].viewid,shareid:sessions[username][sessioncookie].shareid,reconnect:sessions[username][sessioncookie].reconnectid,personalized:personalizedLinks};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log("send reconnected to "+sessioncookie);
      // force tmux to repaint the pane, to fix term properties at the
      // cursor for tmux and others (e.g. the green bar of tmux) after the
      // replayed snapshot. refresh-client redraws the attached clients
      // without touching the geometry: the old ±1 resize dance reflowed
      // the scrollback of the mirror and of every viewer and appended a
      // full screen repaint to the log per resize, duplicating the screen
      // several times at the replay boundary on every reconnect.
      try {
        run_as(username, ['tmux', '-S', session_tmux_path(username, sessioncookie), 'refresh-client']);
      } catch (error) {
        console.log("refresh-client failed for "+sessioncookie+": "+error.message);
      }
    }
    while(connection.sendbuffer.length>0) {
      buf=connection.sendbuffer.shift();
      if (buf!=false) {
        console.log("sending buffered to "+index);
        connection.sendUTF(buf);
      }
    }
    connection.paused=false;
  }

  function create_pty(username,sessioncookie,cols,rows,connection,forceNew) {
    var viewid=false;
    connection.loggedin=true;
    connection.username=username;
    // this connection attached (picked/reconnected/new): it no longer
    // watches the picker
    delete pickers[index];
    if (!forceNew && ( username in sessions)) {
      var list='sessioncookies:\r\n';
      // When a specific session is requested (reconnect/pick), attach to that
      // one only; auto-picking the first disconnected session is for the
      // no-target (auto-reconnect) case.
      var specific = (sessioncookie !== false);
      for (const [key, value] of Object.entries(sessions[username])) {
        var requested = sessioncookie==key;
        var keypty = sessions[username][key].pty;
        if(keypty && keypty.main && !requested) {
		console.log("ignoring " + key + " still connected");
		continue;
	}
        list+=key+'\r\n';
        console.log(key + " length "+Object.keys(sessions[username][key]['connections']).length);
        var mainconnection=false;
        if(!connection.viewonly && !connection.shared) {
          for (const [idx,conn] of Object.entries(sessions[username][key]['connections'])) {
            if(!conn.viewonly && !conn.shared && (!keypty || keypty.main==false)) {
              console.log(username + " reconnected to mainconnection "+key);
              mainconnection=true;
            }
          }
        }
        if(requested || (!specific && !connection.viewonly && !connection.shared && !mainconnection)) {
          sessioncookie=key;
          connection.paused=true;
          if (!sessions[username][sessioncookie].pty ||
              (termd_enabled && sessions[username][sessioncookie].pty.dead)) {
            // detached session (owner disconnected, daemon alive): re-link
            // it at the reconnecting client's geometry; the daemon replays
            // its snapshot through the link
            termd_reattach(username, sessioncookie,
              connection.columns || sessions[username][sessioncookie].cols,
              connection.rows || sessions[username][sessioncookie].rows,
              connection.viewonly || connection.shared, connection);
          }
          if(connection.viewonly) {
            console.log("view started for "+username+" "+sessioncookie);
            var viewmain=sessions[username][sessioncookie].pty.main;
            if (viewmain) sendInfo(viewmain,peerLabel(connection)+" is viewing your session");

          } else if(connection.shared) {
            console.log("sharing started for "+username+" "+sessioncookie);
            var sharemain=sessions[username][sessioncookie].pty.main;
            if (sharemain) sendInfo(sharemain,peerLabel(connection)+" is sharing your session");
          } else {
            sendInfo(connection,"Reconnected to your session");
            if (!requested) {
              var oldreconnectid=sessions[username][sessioncookie].reconnectid;
              var newreconnectid=uuid_v4();
              sessions[username][sessioncookie].reconnectid=newreconnectid;
              reconnects[newreconnectid]={username:username,sessioncookie:sessioncookie};
              if (oldreconnectid && oldreconnectid!=newreconnectid) {
                reconnects[oldreconnectid]={username:username,stale:true,time:now()};
                console.log("rotated reconnect token for "+sessioncookie);
              }
              save_reconnect_token(username, sessioncookie);
            }
            sessions[username][sessioncookie].pty.main=connection;
            notifyPickers(username);
          } 
          if (termd_enabled) {
            termd_replay(username, sessioncookie, connection);
          } else {
            // replay_pty is async and drains connection.sendbuffer itself,
            // after the replayed screen is sent; draining here would deliver
            // live output buffered during the replay before that screen and
            // the client would render the older replay on top of it.
            replay_pty(username,sessioncookie,cols,rows,connection);
          }
          console.log("done sending replay for "+sessioncookie);
          break;
        }
      }
    }
    if (! ( username in sessions)) {
      sessions[username]={};
    }
    if (sessioncookie==false) {
      sessioncookie=uuid_v4();
      viewid=uuid_v4();
      shareid=uuid_v4();
      var reconnectid=uuid_v4();
      //  if (!(sessioncookie in sessions[username])) {
      sessions[username][sessioncookie]={viewid:viewid,shareid:shareid,reconnectid:reconnectid,connections:{}};
      reconnects[reconnectid]={username:username,sessioncookie:sessioncookie};
      save_reconnect_token(username, sessioncookie);
      //  }
      var session=sessions[username][sessioncookie];
      session.sessioncookie=sessioncookie;
      fs.mkdirSync(path.dirname(session_log_path(username,sessioncookie)), { recursive: true });
      views[viewid]={sessioncookie:sessioncookie,username:username}
      shares[shareid]={sessioncookie:sessioncookie,username:username}
      connection.sessioncookie=sessioncookie;
      if (termd_enabled) {
        session.pty = false;
        session.cols = connection.columns;
        session.rows = connection.rows;
        console.log("creating termd session "+sessioncookie+" "+connection.columns+"x"+connection.rows+" for "+index);
        termd.termdSpawn(username, sessioncookie, connection.columns, connection.rows,
          {viewid:viewid, viewurl:request.origin+'/#view='+viewid, shareid:shareid,
           shareurl:request.origin+'/#share='+shareid},
          function(error, termdid) {
            if (error) {
              console.error("termd spawn failed for "+sessioncookie+": "+error.message);
              sendError(connection, "Session start failed");
              connection.close();
              delete sessions[username][sessioncookie];
              delete views[viewid];
              delete shares[shareid];
              delete reconnects[reconnectid];
              delete_reconnect_token(username, sessioncookie);
              return;
            }
            session.termd = termdid;
            var link = termd.termdLink(username, termdid, false);
            link.main = connection;
            link.on('linkerror', function(e) {
              console.error("termd link failed for "+sessioncookie+": "+e.message);
              sendError(connection, "Session start failed");
              termd_cleanup_gone(username, sessioncookie);
            });
            session.pty = link;
            var cmd1={"cmd":"resize","cols":connection.columns,"rows":connection.rows};
            connection.sendUTF('\0' + JSON.stringify(cmd1));
            wire_session(username, sessioncookie);
            link.resize(connection.columns, connection.rows);
            var cmd2={cmd:"authenticated",viewid:session.viewid,shareid:session.shareid,reconnect:session.reconnectid,personalized:personalizedLinks};
            connection.sendUTF('\0' + JSON.stringify(cmd2));
            console.log(username + " authenticated (termd "+termdid+")");
          });
      } else {
      session.checkpoint_path=session_checkpoint_path(username,sessioncookie);
      session.mirror=create_mirror(connection.columns, connection.rows);
      var shellenv = { USER: username, VIEWID: viewid, VIEWURL: request.origin+'/#view='+viewid, SUDO_USER: username, LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' };
      if (session_tmux) {
        start_tmux_session(username, sessioncookie, connection.columns, connection.rows, shellenv);
        sessions[username][sessioncookie].pty = attach_tmux(username, sessioncookie, connection.columns, connection.rows, shellenv);
      } else {
        sessions[username][sessioncookie].pty = pty.spawn('sudo', ['-u',username,'-i'], {
          name: 'xterm',
          cols: connection.columns,
          rows: connection.rows,
          cwd: '/',
          encoding: null,
          env: shellenv
        });
      }
      sessions[username][sessioncookie].pty.file = fopen(session_log_path(username,sessioncookie), 'a+');
      sessions[username][sessioncookie].pty.main=connection;
      console.log("created pty "+sessioncookie+" "+connection.columns+"x"+connection.rows+" for "+index);
      var headermeta={viewid:viewid,shareid:shareid,viewurl:request.origin+'/#view='+viewid,shareurl:request.origin+'/#share='+shareid,
        username:username,sessioncookie:sessioncookie,
        cols:connection.columns,rows:connection.rows,starttime:now()};
      if (session_tmux) headermeta.tmux=session_tmux_path(username,sessioncookie);
      var metalog={t:now(),d:JSON.stringify(headermeta),c:4};
      append_session_log(session,metalog);
      cmd={"cmd":"resize","cols":connection.columns,"rows":connection.rows}
      log={t:now(),d:JSON.stringify(cmd),c:0}
      var written=append_session_log(session,log);
      queue_mirror(session,{type:'resize',cols:connection.columns,rows:connection.rows,offset:written.offset,bytes:written.bytes});
      // Tell the client the real pty size. On sso auto-login the pty is
      // created with the server defaults before the client reports its
      // window, and the client only sends a resize when its own size
      // changes; without this echo the pty would stay at the defaults.
      connection.sendUTF('\0' + JSON.stringify(cmd));
      wire_session(username, sessioncookie);
      var cmd={cmd:"authenticated",viewid:sessions[username][sessioncookie].viewid,shareid:sessions[username][sessioncookie].shareid,reconnect:sessions[username][sessioncookie].reconnectid,personalized:personalizedLinks};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log(username + " authenticated!");
      }
    }
    sessions[username][sessioncookie]['connections'][index]=connection;
    console.log("returning cookie "+sessioncookie+" file "+sessions[username][sessioncookie].pty.file);
    return sessioncookie;

  }

  // A reconnect target is gone: offer this user's disconnected terminals as a
  // picker (with snapshots), or fall back to the login form when there are
  // none. The client replies with 'pick' (chosen reconnectid) or 'newsess'.
  function offerDisconnected(username, connection) {
    var list = listDisconnected(username);
    if (list.length > 0) {
      connection.username = username;
      connection.pickerUser = username;
      pickers[index] = connection;
      console.log("offering "+list.length+" disconnected terminal(s) to "+username);
      connection.sendUTF('\0' + JSON.stringify({cmd:"sessions", list:list}));
    } else {
      sendError(connection,"Your session has expired");
      connection.sendUTF('\0' + JSON.stringify({cmd:"reconnectfailed"}));
    }
  }

  // sso auto-login on connect: if the user has disconnected terminals, show
  // the picker so they choose one (or start a new session) instead of being
  // attached to the first one automatically.
  function ssoAutoLogin(ssoUser) {
    if (listDisconnected(ssoUser).length > 0) {
      // Let the client authenticate itself first: browser tabs keep a
      // reconnect token in sessionStorage and answer the login prompt
      // with it, which reattaches their exact session. Only offer the
      // picker to connections that did not present anything (new tabs).
      connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
      var pickerConn = connection;
      setTimeout(function() {
        if (pickerConn.closeReasonCode !== -1) return;
        // auth is async (pam, cookie lstat): a slow backend finishes after
        // this timer, so a pending login counts as answered
        if (pickerConn.authpending) return;
        if (pickerConn.username || pickerConn.sessioncookie !== false) return;
        offerDisconnected(ssoUser, pickerConn);
      }, 1000);
    } else {
      connection.username = ssoUser;
      connection.sessioncookie = create_pty(ssoUser, false,
        connection.columns, connection.rows, connection);
    }
  }

  // Attaches this connection to a running session as a viewer (mode 'view')
  // or sharer (mode 'share'). id is either a static viewid/shareid, which
  // only works for an authenticated peer, or a personalized link token
  // encrypted with the linkshare_passphrase, which is its own credential.
  function openLiveLink(mode, id) {
    var table = mode === 'view' ? views : shares;
    var expired = mode === 'view' ? "Your view url has expired" : "Your share url has expired";
    if (typeof id !== 'string') { sendError(connection, expired); return; }
    // a connection is bound to one role: a main session owner cannot attach
    // as a viewer/sharer, and a viewer/sharer cannot switch to the other role
    if (connection.loggedin || (connection.viewonly && mode !== 'view')
        || (connection.shared && mode !== 'share')) {
      sendError(connection, "This connection cannot use this "+mode+" link");
      return;
    }
    if (id in table) {
      if (!connection.peer) {
        sendError(connection, "You must be logged in to use this "+mode+" link");
        console.log("static "+mode+" link "+id+" rejected, peer not authenticated");
        return;
      }
      var entry = table[id];
      connection.viewonly = (mode === 'view');
      connection.shared = (mode === 'share');
      connection.username = entry.username;
      connection.sessioncookie = entry.sessioncookie;
      console.log(mode+" "+id+" started for "+connection.username+" "+connection.sessioncookie);
      create_pty(entry.username, entry.sessioncookie, false, false, connection);
      return;
    }
    var token = ssoAuth ? ssoAuth.readLink(id) : null;
    if (token && token.m === mode && token.u in sessions
        && token.s in sessions[token.u] && sessions[token.u][token.s]) {
      connection.viewonly = (mode === 'view');
      connection.shared = (mode === 'share');
      connection.peer = token.t;
      connection.username = token.u;
      connection.sessioncookie = token.s;
      console.log("personalized "+mode+" link for "+token.t+" started for "+token.u+" "+token.s);
      create_pty(token.u, token.s, false, false, connection);
      return;
    }
    sendError(connection, expired);
    console.log(mode+" link does not exist (anymore)");
  }

  console.log('Connection from ['+remote+'] '+index+' accepted.');

  // user sent some message
  connection.on('message', function(message) {
    if (message.type === 'utf8') { // accept only text
      //    console.log('Received Message: ' + escape(message.utf8Data));
      switch (message.utf8Data[0]) {
        case  '\0':
          var buf = message.utf8Data;
          var buf2=buf.substr(1);
          try {
            var m=JSON.parse(buf2);
            var log={t:now(),d:buf2,c:0};
            //console.log('write: '+JSON.stringify(log));
            switch (m.cmd) {
              case 'size':
                // Client-reported window size, sent on connect before the
                // sso auto-login spawns the pty so it starts at the right
                // size. If a pty exists already, treat it as a resize.
                if (!connection.viewonly && validSize(m.cols, m.rows)) {
                  connection.columns = m.cols;
                  connection.rows = m.rows;
                  if (connection.sessioncookie!=false) {
                    var sizeSession=sessions[connection.username][connection.sessioncookie];
                    if (sizeSession.pty && sizeSession.pty.cols===m.cols && sizeSession.pty.rows===m.rows) break;
                    var sizelog={t:now(),d:JSON.stringify({cmd:"resize",cols:m.cols,rows:m.rows}),c:0};
                    if (sizeSession.pty) sizeSession.pty.resize(m.cols,m.rows);
                    var sizewritten=append_session_log(sizeSession,sizelog);
                    queue_mirror(sizeSession,{type:'resize',cols:m.cols,rows:m.rows,offset:sizewritten.offset,bytes:sizewritten.bytes});
                  }
                }
                break;;
              case 'resize':
                if (!connection.viewonly && validSize(m.cols, m.rows)) {
                  connection.columns = m.cols;
                  connection.rows = m.rows;
                   if (connection.sessioncookie!=false) {
                     var rsession=sessions[connection.username][connection.sessioncookie];
                     if (rsession && rsession.pty) {
                     if (rsession.pty.cols===m.cols && rsession.pty.rows===m.rows) break;
                     console.log("received resize to "+m.cols+"x"+m.rows+" "+connection.sessioncookie+" "+rsession.pty.file);
                    rsession.pty.resize(m.cols,m.rows);
                    console.log("writing to "+connection.username+" "+connection.sessioncookie+" "+rsession.pty.file);
                    var written=append_session_log(sessions[connection.username][connection.sessioncookie],log);
                    queue_mirror(sessions[connection.username][connection.sessioncookie],{type:'resize',cols:m.cols,rows:m.rows,offset:written.offset,bytes:written.bytes});
                    if(Object.keys(sessions[connection.username][connection.sessioncookie]['connections']).length>0) {
                      //  console.log("broadcasting resize");
                      for (const [key, conn] of Object.entries(sessions[connection.username][connection.sessioncookie]['connections'])) {
                        if (true || key!=index) {
                          if (conn.paused) {
                            console.log("buffering 0 for "+key+" session "+connection.sessioncookie);
                            bufferSend(conn, '\0' + buf2);
                          } else {
                            //console.log("sending resize to "+key);
                            conn.sendUTF('\0'+buf2);
                          }
                        }
                      }
                    }
                    }
                  } else {
                    connection.columns = m.cols;
                    connection.rows = m.rows;
                    console.log("received prelogin resize to "+m.cols+"x"+m.rows);
                  }
                } else {
                  console.log("ignored resize (viewonly) to "+m.cols+"x"+m.rows+" "+connection.sessioncookie);
                }

                break;;
              case 'view':
                openLiveLink('view', m.view);
                break;;

              case 'share':
                openLiveLink('share', m.share);
                break;;

              case 'grant':
                if (connection.loggedin && !connection.viewonly && !connection.shared
                    && connection.sessioncookie && connection.username in sessions
                    && connection.sessioncookie in sessions[connection.username]
                    && sessions[connection.username][connection.sessioncookie].pty) {
                  var grantMode = m.grant === 'share' ? 'share' : (m.grant === 'view' ? 'view' : null);
                  var grantUser = typeof m.user === 'string' ? m.user.trim() : '';
                  var validName = grantUser.length <= 254 && /^[0-9a-zA-Z._-]+$/.test(grantUser);
                  var validEmail = grantUser.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(grantUser);
                  if (!grantMode) {
                    sendError(connection, "Grant must be 'view' or 'share'");
                  } else if (!grantUser || grantUser === 'root' || !(validName || validEmail)) {
                    sendError(connection, "A valid username or email address is required for a personalized link");
                  } else if (!ssoAuth || !ssoAuth.linkEnabled) {
                    sendError(connection, "Personalized links are not configured");
                  } else {
                    var link = ssoAuth.createLink({
                      m: grantMode,
                      s: connection.sessioncookie,
                      u: connection.username,
                      t: grantUser,
                      e: Date.now() + 7 * 24 * 3600 * 1000
                    });
                    if (!link) {
                      sendError(connection, "Personalized links are not configured");
                    } else {
                      var grantHash = grantMode === 'view' ? 'view=' : 'share=';
                      connection.sendUTF('\0' + JSON.stringify({
                        cmd: 'grantlink', mode: grantMode,
                        url: request.origin + '/#' + grantHash + encodeURIComponent(link)
                      }));
                      console.log("personalized "+grantMode+" link created for "+grantUser+" by "+connection.username);
                    }
                  }
                }
                break;;

              case 'reconnect':
                if (!connection.viewonly) {
                  if (m.reconnect && m.reconnect in reconnects) {
                    var r=reconnects[m.reconnect];
                    // bind the reconnect token to the owning identity: an
                    // authenticated peer must match the session owner, and a
                    // client presenting a local session cookie must own that
                    // cookie; a client with neither identity is accepted on
                    // token possession alone
                    var owner = connection.peer || cookieUsername(uuidcookie);
                    if (owner && r.username && owner != r.username) {
                      console.log("reconnect "+m.reconnect+" rejected: peer "+owner+" is not "+r.username);
                      connection.sendUTF('\0' + JSON.stringify({cmd:"reconnectfailed"}));
                      break;
                    }
                    if (validSize(m.cols, m.rows)) {
                      connection.columns=m.cols;
                      connection.rows=m.rows;
                    }
                    if (r.stale) {
                      delete reconnects[m.reconnect];
                      connection.username=r.username;
                      console.log("reconnect "+m.reconnect+" was taken over, starting a new session for "+r.username);
                      connection.sessioncookie=create_pty(r.username,false,connection.columns,connection.rows,connection,true);
    } else if (r.sessioncookie && r.username in sessions && r.sessioncookie in sessions[r.username] && sessions[r.username][r.sessioncookie]) {
                      connection.username=r.username;
                      connection.sessioncookie=r.sessioncookie;
                      console.log("reconnect "+m.reconnect+" by "+r.username+" to "+r.sessioncookie);
                      create_pty(r.username,r.sessioncookie,connection.columns,connection.rows,connection);
                    } else {
                      delete reconnects[m.reconnect];
                      // The target is gone. Offer the user's other disconnected
                      // terminals to reconnect to, or fall back to the login.
                      offerDisconnected(r.username, connection);
                    }
                  } else {
                    offerDisconnected(connection.peer, connection);
                  }
                }
                break;;
              case 'pick':
                if (!connection.viewonly && !connection.loggedin
                    && m.reconnect && m.reconnect in reconnects) {
                  var pick=reconnects[m.reconnect];
                  var pickOwner = connection.peer || cookieUsername(uuidcookie);
                  if (pick.username && !pick.stale && pick.username in sessions
                      && (!pickOwner || pickOwner == pick.username)
                      && pick.sessioncookie in sessions[pick.username]
                      && sessions[pick.username][pick.sessioncookie]
                      && (!sessions[pick.username][pick.sessioncookie].pty
                          || sessions[pick.username][pick.sessioncookie].pty.main === false)) {
                    if (validSize(m.cols, m.rows)) {
                      connection.columns=m.cols;
                      connection.rows=m.rows;
                    }
                    connection.username=pick.username;
                    connection.sessioncookie=pick.sessioncookie;
                    console.log("picked disconnected terminal "+pick.sessioncookie+" by "+pick.username);
                    create_pty(pick.username,pick.sessioncookie,connection.columns,connection.rows,connection);
                  } else {
                    connection.sendUTF('\0' + JSON.stringify({cmd:"reconnectfailed"}));
                  }
                }
                break;;
              case 'newsess':
                if (!connection.viewonly && !connection.loggedin) {
                  if (validSize(m.cols, m.rows)) {
                    connection.columns=m.cols;
                    connection.rows=m.rows;
                  }
                  var newuser = connection.peer || connection.username;
                  if (newuser) {
                    connection.sessioncookie=create_pty(newuser,false,connection.columns,connection.rows,connection,true);
                  } else {
                    connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
                  }
                }
                break;;
              case 'login':
                if (!connection.viewonly) {
                  if(validSize(m.cols, m.rows)) {
                    console.log("received login size "+m.cols+"x"+m.rows);
                    connection.columns=m.cols;
                    connection.rows=m.rows;
                  }
                   if ('cookie' in m && m.cookie.match('^[0-9a-zA-Z-]+$')) {
                     if ('cookie_dir' in config) {
                       const cookiefile=config.cookie_dir+"/cookie_"+m.cookie+".json";
                       // lstat asynchronously: a cookie is removed on use, a
                       // synchronous statSync on a raced/deleted cookie file
                       // would throw and crash the server. lstat (not stat)
                       // so a symlink in the world-writable cookie dir
                       // cannot borrow another user's file ownership.
                       connection.authpending = true;
                       fs.lstat(cookiefile, function(staterr, stat) {
                         connection.authpending = false;
                         if (staterr) {
                           connection.sendUTF('\1broken session '+staterr);
                           connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
                           connection.close();
                           return;
                         }
                         if (!('uid' in stat)) {
                           connection.sendUTF('\1who are you?\n\r');
                           connection.close();
                           return;
                         }
                         const uname=userid.username(stat.uid);
                         if (uname==undefined || uname=='root') {
                           connection.close();
                           return;
                         }
                         // a cookie older than the max age requires a full
                         // login again; the file is removed best-effort
                         var maxAgeDays = configInt('cookie_max_age_days', 7);
                         if (maxAgeDays > 0 && Date.now() - stat.mtimeMs > maxAgeDays*86400*1000) {
                           fs.rm(cookiefile, {force:true}, function(){});
                           connection.sendUTF('\0' + JSON.stringify({cmd:"login"}));
                           return;
                         }
                         connection.username=uname;
                         console.log("got username "+connection.username+" from cookie "+m.cookie);
                         // the cookie is single-use: removed best-effort (a
                         // sticky dir lets only the owner delete, and the
                         // client rotates its cookie file on every login)
                         fs.rm(cookiefile, {force:true}, function(){});
                         if (m.picker) {
                           connection.peer=uname;
                           offerDisconnected(uname, connection);
                         } else {
                           connection.sessioncookie=create_pty(connection.username,false,connection.columns,connection.rows,connection);
                         }
                       })
                     } else {
                       connection.sendUTF('\1local sessions disabled\n\r');
                       connection.close();
                     }
                   } else if ('username' in m && 'password' in m) {
                    var blocked = loginBlockSeconds(clientIp);
                    if (blocked > 0) {
                      sendError(connection, "too many failed logins, try again in "+Math.ceil(blocked)+"s");
                      connection.sendUTF('\0' + JSON.stringify({cmd:"authfailed"}));
                      break;
                    }
                     loginAttempt(clientIp);
                     // root is refused on every other login path (cookie,
                     // sso, wslogin-run); wslogin-run would refuse the spawn
                     // anyway, reject it here for a clear, consistent error
                     if (m.username == 'root') {
                       console.log("root login rejected");
                       sendError(connection, "root login is not allowed");
                       connection.sendUTF('\0' + JSON.stringify({cmd:"authfailed"}));
                       break;
                     }
                     connection.authpending = true;
                     pam.authenticate(m.username, m.password, function(err) {
                        connection.authpending = false;
                      if(err) {
                        sendError(connection,err);
                        var cmd={cmd:"authfailed"};
                        connection.sendUTF('\0' + JSON.stringify(cmd));
                        console.log(err);
                      } else {
                        delete logins[clientIp];
                        connection.username=m.username;
                        // picker=true: authenticate only, then offer this
                        // user's disconnected terminals (wslogin-cli flow).
                        // The peer identity lets 'pick' accept the session.
                        if (m.picker) {
                          connection.peer=m.username;
                          offerDisconnected(m.username, connection);
                        } else {
                          connection.sessioncookie=create_pty(m.username,false,connection.columns,connection.rows,connection);
                        }
                      }
                    }, {serviceName: config.pam_service || 'sshd', remoteHost: remote});
                  } else {
                    connection.sendUTF('\1session denied\n\r');
                    connection.close();
                  }
                } else {
                  console.log("ignored login on viewonly session");
                }
                break;;
              default: console.log("unknown command: " + buf2);
            }
          } catch(error) {
            console.error(error);
          }
          break;;
        case '\1':
          if (connection.sessioncookie!=false && !connection.viewonly) {
            var input=message.utf8Data.substr(1);
            var log={t:now(),d:input,c:2};
            // the session may have ended (and its maps deleted) while this
            // keystroke was in flight: guard the lookup, an uncaught
            // TypeError in this callback would crash the whole server
            var usermap=sessions[connection.username];
            var isession=usermap && usermap[connection.sessioncookie];
            if (isession && isession.pty) {
              append_session_log(isession,log);
              isession.pty.write(message.utf8Data.substr(1));
            }
          } else {
            console.log("received data while not authed"+ message.utf8Data.substr(1));
          }
          break;;
        case '\2':
          if (connection.sessioncookie!=false && !connection.viewonly) {
            var mouse=message.utf8Data.substr(1);
            var nowms=Date.now();
            if (mouse.length<=256 && nowms-(connection.lastmouse||0)>=40) {
              try {
                var m=JSON.parse(mouse);
                if (Number.isInteger(m.x)&&Number.isInteger(m.y)
                    &&Number.isInteger(m.b)&&m.b>=0&&m.b<=2) {
                  connection.lastmouse=nowms;
                  var session=connection.sessioncookie;
                  var log={t:now(),d:mouse,c:3};
                  append_session_log(sessions[connection.username][session],log);
                  // Forward to all connections of the session so live viewers
                  // can render the pointer.
                  for (const [key, conn] of Object.entries(sessions[connection.username][session]['connections'])) {
                    if (conn.paused) {
                      bufferSend(conn, '\2'+mouse);
                    } else {
                      conn.sendUTF('\2'+mouse);
                    }
                  }
                }
              } catch(error) {}
            }
          }
          break;;
        default: console.log("unknown message type "+ message.utf8Data);
      }
    }
  });

  // user disconnected
  connection.on('close', function(close) {
    delete pickers[index];
    if (connection.username) {
      console.log('['+remote+'] Disconnected '+connection.sessioncookie+' '+index);
      if (( connection.username in sessions)) {
        if (connection.sessioncookie in sessions[connection.username]) {
          delete sessions[connection.username][connection.sessioncookie]['connections'][index];
        }
	if (connection.username in sessions && connection.sessioncookie in sessions[connection.username] && sessions[connection.username][connection.sessioncookie].pty && sessions[connection.username][connection.sessioncookie].pty.main == connection) {
	  console.log("Main connection for "+connection.username+" "+connection.sessioncookie+" disconnected");
	  sessions[connection.username][connection.sessioncookie].pty.main=false;
	  notifyPickers(connection.username);
        // owner gone: end its tmux client (the shell in the tmux server
        // keeps running for a reconnect); viewer/sharer connections share
        // the owner's view and do not end it. In termd mode the daemon
        // keeps the shell: dropping the link detaches the owner.
        if (termd_enabled) {
          var tsess = sessions[connection.username][connection.sessioncookie];
          if (tsess && tsess.pty && tsess.pty.close) tsess.pty.close();
        } else {
          kill_tmux_clients(connection.username, connection.sessioncookie);
        }
        checkpoint_on_disconnect(sessions[connection.username][connection.sessioncookie]);
	} else if (connection.username in sessions && connection.sessioncookie in sessions[connection.username]
	    && sessions[connection.username][connection.sessioncookie].pty
	    && !sessions[connection.username][connection.sessioncookie].pty.main
	    && Object.keys(sessions[connection.username][connection.sessioncookie]['connections']).length === 0) {
	  // last viewer/sharer of a re-attached ownerless session gone: drop
	  // the attach client (its exit handler marks the session detached),
	  // so no live pty runs without any consumer
	  console.log("last consumer of "+connection.sessioncookie+" disconnected, dropping attach client");
	  if (termd_enabled) {
	    var lsess = sessions[connection.username][connection.sessioncookie];
	    if (lsess && lsess.pty) {
	      if (lsess.pty.close) lsess.pty.close();
	      lsess.cols = lsess.pty.cols || lsess.cols;
	      lsess.rows = lsess.pty.rows || lsess.rows;
	      lsess.pty = false;
	    }
	  } else {
	    kill_tmux_clients(connection.username, connection.sessioncookie);
	  }
	}
      } else {
        console.log("username and session "+connection.sessioncookie+" for  "+connection.username+" already cleaned up");
      }
    } else {
      console.log('['+remote+'] Disconnected with no login');
    }

  });
});
wsServer.on('connection', function(ws,req) {
  var forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? String(forwarded).split(',')[0].trim() : req.remoteAddress;
  console.log('Connection from ip ' + ip);
});

