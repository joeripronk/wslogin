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

var checkpoint_enabled = configBool('checkpoint_enabled', true);
var checkpoint_interval_seconds = Math.max(0, configInt('checkpoint_interval_seconds', 3600));
var checkpoint_bytes = Math.max(0, configInt('checkpoint_bytes', 1024 * 1024));
if (checkpoint_interval_seconds==0 && checkpoint_bytes==0) {
  checkpoint_enabled=false;
}
console.log("checkpoints: enabled="+checkpoint_enabled
  +" interval="+checkpoint_interval_seconds+"s bytes="+checkpoint_bytes);

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

function redactConfig(cfg) {
  var copy = JSON.parse(JSON.stringify(cfg));
  var httpsSection = copy['https'];
  if (httpsSection && typeof httpsSection == 'object') {
    if ('passphrase' in httpsSection) httpsSection.passphrase = '***';
    if ('key_password' in httpsSection) httpsSection.key_password = '***';
  }
  return copy;
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
      if (!matchTemplate(session_template, rel, ['username', 'session'])) {
        continue;
      }
      finish_path(path.join(dir, entry.name));
    }
  }
  walk(session_dir, '');
}
finish_interrupted_sessions();
var clients = [ ];
var logins = {};
var sessions = {};
var views = {};
var shares = {};
var reconnects = {};
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
function serialize_terminal(terminal, serializeAddon) {
  const {isCursorHidden} = terminal._core._inputHandler._coreService;
  return serializeAddon.serialize()+(isCursorHidden ? '\x1b[?25l' : '\x1b[?25h');
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
    var terminal = new Terminal({ allowProposedApi: true });
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
            }
          } else if (json.c==1) {
            terminal.write(json.d);
          }
        } catch (error) {
          console.error("error replaying "+file+": "+error.message);
        }
      }).on('close', finish);
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
  var terminal = new Terminal({ allowProposedApi: true });
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

function queue_mirror(session, op) {
  if (!session.mirror) return;
  session.mirror.queue.push(op);
  pump_mirror(session);
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
}, 1000).unref();

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
function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed.
  return true;
  if (origin=='https://ssh.joeri.nu') {
    return true;
  } else {
    return false;
  }
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

// A rendered snapshot of a session's current screen, for a reconnect picker.
function serialize_mirror(session) {
  var mirror = session.mirror;
  if (!mirror || !mirror.terminal) return null;
  try {
    return {
      cols: mirror.terminal.cols,
      rows: mirror.terminal.rows,
      title: mirror.terminal.title || '',
      s: serialize_terminal(mirror.terminal, mirror.serializeAddon)
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
    if (s.pty && s.pty.main === false) {
      var snap = serialize_mirror(s);
      list.push({
        reconnectid: s.reconnectid,
        cols: s.pty.cols,
        rows: s.pty.rows,
        title: (snap && snap.title) || '',
        snapshot: snap ? snap.s : ''
      });
    }
  }
  return list;
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
      // force a redraw, to fix term properties at cursor for tmux and others
      // currently terminal properties of the last drawn character are active
      // e.g. the green bar of tmux
      // The reconnected client is replayed at the session geometry first.
      // The client fits its terminal to the screen and only then sends a
      // resize if its geometry differs from the session geometry, so the
      // stale size from the reconnect request is never applied to the pty.
      sessions[username][sessioncookie].pty.resize(serial.cols+1,serial.rows);
      console.log("resizing "+sessioncookie+' to '+(serial.cols+1)+'x'+(serial.rows+1));
      setTimeout(function() {
           sessions[username][sessioncookie].pty.resize(serial.cols, serial.rows);
           console.log("resizing back to "+sessioncookie+' to '+(serial.cols)+'x'+(serial.rows));
        }, 30);
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
    if (!forceNew && ( username in sessions)) {
      var list='sessioncookies:\r\n';
      // When a specific session is requested (reconnect/pick), attach to that
      // one only; auto-picking the first disconnected session is for the
      // no-target (auto-reconnect) case.
      var specific = (sessioncookie !== false);
      for (const [key, value] of Object.entries(sessions[username])) {
        var requested = sessioncookie==key;
        if(sessions[username][key].pty.main && !requested) {
		console.log("ignoring " + key + " still connected");
		continue;
	}
        list+=key+'\r\n';
        console.log(key + " length "+Object.keys(sessions[username][key]['connections']).length);
        var mainconnection=false;
        if(!connection.viewonly && !connection.shared) {
          for (const [idx,conn] of Object.entries(sessions[username][key]['connections'])) {
            if(!conn.viewonly && !conn.shared && sessions[username][key].pty.main==false) {
              console.log(username + " reconnected to mainconnection "+key);
              mainconnection=true;
            }
          }
        }
        if(requested || (!specific && !connection.viewonly && !connection.shared && !mainconnection)) {
          sessioncookie=key;
          connection.paused=true;
          if(connection.viewonly) {
            console.log("view started for "+username+" "+sessioncookie);
            sendInfo(sessions[username][sessioncookie].pty.main,peerLabel(connection)+" is viewing your session");

          } else if(connection.shared) {
            console.log("sharing started for "+username+" "+sessioncookie);
            sendInfo(sessions[username][sessioncookie].pty.main,peerLabel(connection)+" is sharing your session");
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
            }
            sessions[username][sessioncookie].pty.main=connection;
          } 
          replay_pty(username,sessioncookie,cols,rows,connection);
          while(connection.sendbuffer.length>0) {
            buf=connection.sendbuffer.shift();
            if (buf!=false) {
              console.log("sending late buffered to "+index);
              connection.sendUTF(buf);
            }
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
      //  }
      var session=sessions[username][sessioncookie];
      session.sessioncookie=sessioncookie;
      session.checkpoint_path=session_checkpoint_path(username,sessioncookie);
      session.mirror=create_mirror(connection.columns, connection.rows);
      fs.mkdirSync(path.dirname(session_log_path(username,sessioncookie)), { recursive: true });
      //file = fs.createWriteStream(session_log_path(username,sessioncookie), { flags: 'a' });
      sessions[username][sessioncookie].pty = pty.spawn('sudo', ['-u',username,'-i'], {
        name: 'xterm',
        cols: connection.columns,
        rows: connection.rows,
        cwd: '/',
        env: { USER: username,VIEWID: viewid,VIEWURL: request.origin+'/#view='+viewid,SUDO_USER: username }
      });
      sessions[username][sessioncookie].pty.file = fopen(session_log_path(username,sessioncookie), 'a+');
      /*        sessions[username][sessioncookie].pty.sessioncookie=sessioncookie;
        sessions[username][sessioncookie].pty.username=username;
        */
      sessions[username][sessioncookie].pty.main=connection;
      views[viewid]={sessioncookie:sessioncookie,username:username}
      shares[shareid]={sessioncookie:sessioncookie,username:username}
      console.log("created pty "+sessioncookie+" "+connection.columns+"x"+connection.rows+" for "+index);
      var metalog={t:now(),d:JSON.stringify({viewid:viewid,shareid:shareid,viewurl:request.origin+'/#view='+viewid,shareurl:request.origin+'/#share='+shareid}),c:4};
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
      // connection.sendUTF('\1'+list);
      sessions[username][sessioncookie].pty.on('data', function(data) {
        var senddata=false;
        if (JSON.stringify(data)) {
          var log={t:now(),d:data,c:1};
          var written=append_session_log(session,log);
          queue_mirror(session,{type:'data',data:data,offset:written.offset,bytes:written.bytes});
          senddata='\1'+ data;
        } else {
          cmd={cmd:'b64',data:btoa(data)}
          var log={t:now(),d:JSON.stringify(cmd),c:0};
          append_session_log(session,log);
          senddata='\0'+ JSON.stringify(cmd);
        }

        for (const [key, conn] of Object.entries(sessions[username][sessioncookie]['connections'])) {
          if (conn.paused) {
            console.log("buffering 1 for "+key+" session "+sessioncookie);
            conn.sendbuffer.push(senddata);
          } else {
            while(connection.sendbuffer.length>0) {
              buf=connection.sendbuffer.shift();
              if (buf!=false) {
                console.log("sending delayed buffered to "+index);
                connection.sendUTF(buf);
              }
            }
            conn.sendUTF(senddata);
          }
        }
      });
      connection.sessioncookie=sessioncookie;
      sessions[username][sessioncookie].pty.on('resize', function() {
        var resize={cmd:"resize",rows:session.pty.rows,cols:session.pty.cols};
        var cmdtext='\0'+JSON.stringify(resize);
        var log={t:now(),d:JSON.stringify(resize),c:0};
        var written=append_session_log(session,log);
        queue_mirror(session,{type:'resize',cols:resize.cols,rows:resize.rows,offset:written.offset,bytes:written.bytes});

        for (const [key, conn] of Object.entries(session.connections)) {
          if (conn.paused) {
            console.log("buffering 0 for "+cmdtext+" session "+connection.sessioncookie);
            conn.sendbuffer.push(cmdtext);
          } else {
            conn.send(cmdtext);
          }
        }
      });

      sessions[username][sessioncookie].pty.on('exit', function(data) {
        console.log("pty "+connection.sessioncookie+" for "+connection.username+" exited with status "+ data);
        var log={t:now(),d:data,c:3};
        append_session_log(session,log);
        for (const [key, conn] of Object.entries(sessions[connection.username][connection.sessioncookie]['connections'])) {
          if (sessions[connection.username][connection.sessioncookie].pty.main == conn) {
            sendInfo(sessions[connection.username][connection.sessioncookie].pty.main,"Your session ended");
          } else {
            sendInfo(conn,"Session ended");
          }
          conn.close();
        }
        console.log("closing "+connection.sessioncookie+" "+sessions[connection.username][connection.sessioncookie].pty.file);
        if (sessions[connection.username][connection.sessioncookie].pty.file) {
           console.log("closing pty file views for "+connection.username);
           fs.close(sessions[connection.username][connection.sessioncookie].pty.file);
           sessions[connection.username][connection.sessioncookie].pty.file=false;
        }
        finish_session(connection.username, connection.sessioncookie);
        delete views[sessions[connection.username][connection.sessioncookie].viewid];
        if (connection.username in views && views[connection.username].length==0) {
          console.log("deleting all views for "+connection.username);
          delete views[connection.username];
        }     
        delete reconnects[sessions[connection.username][connection.sessioncookie].reconnectid];
        delete shares[sessions[connection.username][connection.sessioncookie].shareid];
        if (connection.username in shares && shares[connection.username].length==0) {
          console.log("deleting all shared views for "+connection.username);
          delete shares[connection.username];
        }     
	console.log("deleting sessions "+connection.username+ " " + connection.sessioncookie);
        delete sessions[connection.username][connection.sessioncookie];
        if (connection.username in sessions && sessions[connection.username].length==0) {
          console.log("deleting all sessions for "+connection.username);
          delete sessions[connection.username];
        }     
      });
      var cmd={cmd:"authenticated",viewid:sessions[username][sessioncookie].viewid,shareid:sessions[username][sessioncookie].shareid,reconnect:sessions[username][sessioncookie].reconnectid,personalized:personalizedLinks};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log(username + " authenticated!");
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
      offerDisconnected(ssoUser, connection);
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
        && token.s in sessions[token.u] && sessions[token.u][token.s].pty) {
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

  var index = clients.push(connection) - 1;


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
                if (!connection.viewonly && Number.isInteger(m.cols) && Number.isInteger(m.rows)
                    && m.cols > 0 && m.rows > 0) {
                  connection.columns = m.cols;
                  connection.rows = m.rows;
                  if (connection.sessioncookie!=false) {
                    var sizelog={t:now(),d:JSON.stringify({cmd:"resize",cols:m.cols,rows:m.rows}),c:0};
                    var sizeSession=sessions[connection.username][connection.sessioncookie];
                    sizeSession.pty.resize(m.cols,m.rows);
                    var sizewritten=append_session_log(sizeSession,sizelog);
                    queue_mirror(sizeSession,{type:'resize',cols:m.cols,rows:m.rows,offset:sizewritten.offset,bytes:sizewritten.bytes});
                  }
                }
                break;;
              case 'resize':
                if (!connection.viewonly) {
                  connection.columns = m.cols;
                  connection.rows = m.rows;
                  if (connection.sessioncookie!=false) {
                    console.log("received resize to "+m.cols+"x"+m.rows+" "+connection.sessioncookie+" "+sessions[connection.username][connection.sessioncookie].pty.file);
                    sessions[connection.username][connection.sessioncookie].pty.resize(m.cols,m.rows);
                    console.log("writing to "+connection.username+" "+connection.sessioncookie+" "+sessions[connection.username][connection.sessioncookie].pty.file);
                    var written=append_session_log(sessions[connection.username][connection.sessioncookie],log);
                    queue_mirror(sessions[connection.username][connection.sessioncookie],{type:'resize',cols:m.cols,rows:m.rows,offset:written.offset,bytes:written.bytes});
                    if(Object.keys(sessions[connection.username][connection.sessioncookie]['connections']).length>0) {
                      //  console.log("broadcasting resize");
                      for (const [key, conn] of Object.entries(sessions[connection.username][connection.sessioncookie]['connections'])) {
                        if (true || key!=index) {
                          if (conn.paused) {
                            console.log("buffering 0 for "+key+" session "+connection.sessioncookie);
                            conn.sendbuffer.push('\0' + buf2);
                          } else {
                            //console.log("sending resize to "+key);
                            conn.sendUTF('\0'+buf2);
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
                    if ('cols' in m && 'rows' in m) {
                      connection.columns=m.cols;
                      connection.rows=m.rows;
                    }
                    if (r.stale) {
                      delete reconnects[m.reconnect];
                      connection.username=r.username;
                      console.log("reconnect "+m.reconnect+" was taken over, starting a new session for "+r.username);
                      connection.sessioncookie=create_pty(r.username,false,connection.columns,connection.rows,connection,true);
                    } else if (r.sessioncookie && r.username in sessions && r.sessioncookie in sessions[r.username] && sessions[r.username][r.sessioncookie].pty) {
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
                  if (pick.username && !pick.stale && pick.username in sessions
                      && pick.sessioncookie in sessions[pick.username]
                      && sessions[pick.username][pick.sessioncookie].pty
                      && sessions[pick.username][pick.sessioncookie].pty.main === false) {
                    if ('cols' in m && 'rows' in m) {
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
                  if ('cols' in m && 'rows' in m) {
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
                  if('cols' in m && 'rows' in m) {
                    console.log("received login size "+m.cols+"x"+m.rows);
                    connection.columns=m.cols;
                    connection.rows=m.rows;
                  }
                  if ('cookie' in m && m.cookie.match('^[0-9a-zA-Z-]+$')) {
                    if ('cookie_dir' in config) {
                      const cookiefile=config.cookie_dir+"/cookie_"+m.cookie+".json";
                      const stat=fs.statSync(cookiefile); 
                      fs.rm(cookiefile, function (err) {
                        if (err) {
                          connection.sendUTF('\1broken session '+err);
                          connection.close();
                        } else {
                          if ('uid' in stat) {
                            const uname=userid.username(stat.uid); 
                            if (uname!=undefined && uname!='root' ) {
                              connection.username=uname; 
                              console.log("got username "+connection.username+" from cookie "+m.cookie);
                              connection.sessioncookie=create_pty(connection.username,false,false,false,connection);
                            } else {
                              connection.close();
                            }
                          } else {
                            connection.sendUTF('\1who are you?\n\r');
                            connection.close();
                          }
                        }
                      })
                    } else {
                      connection.sendUTF('\1local sessions disabled\n\r');
                      connection.close();
                    }
                  } else if ('username' in m && 'password' in m) {
                    pam.authenticate(m.username, m.password, function(err) {
                      if(err) {
                        sendError(connection,err);
                        var cmd={cmd:"authfailed"};
                        connection.sendUTF('\0' + JSON.stringify(cmd));
                        console.log(err);
                      } else {
                        connection.username=m.username;
                        connection.sessioncookie=create_pty(m.username,false,connection.columns,connection.rows,connection);
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
            //		console.log("writing to "+connection.username+" "+connection.sessioncookie+" "+sessions[connection.username][connection.sessioncookie].pty.file);
            append_session_log(sessions[connection.username][connection.sessioncookie],log);
            sessions[connection.username][connection.sessioncookie].pty.write(message.utf8Data.substr(1));
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
                      conn.sendbuffer.push('\2'+mouse);
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
    if (connection.username) {
      console.log('['+remote+'] Disconnected '+connection.sessioncookie+' '+index);
      if (( connection.username in sessions)) {
        if (connection.sessioncookie in sessions[connection.username]) {
          delete sessions[connection.username][connection.sessioncookie]['connections'][index];
        }
	if (connection.username in sessions && connection.sessioncookie in sessions[connection.username] && sessions[connection.username][connection.sessioncookie].pty.main == connection) {
	  console.log("Main connection for "+connection.username+" "+connection.sessioncookie+" disconnected");
	  sessions[connection.username][connection.sessioncookie].pty.main=false;
	  checkpoint_on_disconnect(sessions[connection.username][connection.sessioncookie]);
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
  console.log('Connection from ip ' + req.headers);
  const ip = req.headers['x-forwarded-for'].split(',')[0].trim();
  console.log('Connection from ip ' + ip);
});

