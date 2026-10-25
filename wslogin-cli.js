#!/usr/bin/env node
'use strict';

// wslogin-cli.js - open a shell connected to wslogin-server from a terminal.
//
// Logs in with a local session cookie: the cli writes a cookie file into
// the server's (world-writable, sticky) cookie dir and the file's owner
// uid is the authentication, so no password is needed. With no usable
// cookie it falls back to a PAM password login. It then offers a picker of
// your disconnected terminals (sessions whose owner connection is gone)
// and attaches the chosen one, or starts a new session. Ctrl-] detaches:
// the shell keeps running server-side and shows up in the picker on the
// next run.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const WebSocket = require('ws');
const ini = require('ini');

const HELP = `wslogin - open a shell connected to wslogin-server

usage: wslogin [-n] [-u user] [--url ws://host:port/pty]

  -n, --new    always start a new session (skip the picker)
  -u, --user   login user (default: current user)
      --url    websocket url (default ws://127.0.0.1:<port>/pty, port
               taken from /etc/wslogin/config.ini)

Login uses a local session cookie (the file owner authenticates the
current user); a password is only asked for when no cookie is available.
A detached session (Ctrl-], server restart, dropped connection) is
reattached automatically on the next run; the picker only appears when
that session is gone.
Ctrl-] detaches from the session. It keeps running server-side and can be
picked up with wslogin again (also from the browser).`;

function parseArgs(argv) {
  var opts = {url: process.env.WSLOGIN_URL || null,
    user: os.userInfo().username, userSet: false, picker: true};
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-n' || a === '--new') opts.picker = false;
    else if (a === '-u' || a === '--user') { opts.user = argv[++i]; opts.userSet = true; }
    else if (a === '--url') opts.url = argv[++i];
    else if (a.startsWith('--url=')) opts.url = a.slice(6);
    else { console.error('wslogin: unknown option: ' + a); process.exit(2); }
  }
  return opts;
}

function cookieDir() {
  if (process.env.WSLOGIN_COOKIE_DIR) return process.env.WSLOGIN_COOKIE_DIR;
  var file = process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini';
  try {
    var conf = ini.parse(fs.readFileSync(file, 'utf-8'));
    if (conf && conf.cookie_dir) return String(conf.cookie_dir);
  } catch (error) {}
  return '/opt/wslogin/cookies';
}

function cookieStateFile() {
  return (process.env.HOME || os.homedir()) + '/.wslogin-cookie';
}

// The local session cookie: a file in the server's cookie dir whose owner
// uid authenticates the current user. Written fresh on every login; the
// server consumes (and tries to delete) it. Returns the uuid, or null
// when the cookie dir is not usable.
function issueCookie() {
  var dir = cookieDir();
  var prev = null;
  try { prev = fs.readFileSync(cookieStateFile(), 'utf-8').trim(); } catch (error) {}
  if (prev) {
    // the server cannot delete from a sticky dir; the owner cleans up
    try { fs.unlinkSync(dir + '/cookie_' + prev + '.json'); } catch (error) {}
  }
  var uuid = crypto.randomUUID();
  try {
    var file = dir + '/cookie_' + uuid + '.json';
    fs.writeFileSync(file, JSON.stringify({cli: true, issued: Date.now()}) + '\n',
      {mode: 0o600});
    try { fs.writeFileSync(cookieStateFile(), uuid + '\n'); } catch (error) {}
    return uuid;
  } catch (error) {
    return null;
  }
}

function reconnectFile() {
  return (process.env.HOME || os.homedir()) + '/.wslogin-reconnect';
}

// The reconnect token of the session this cli last used: presenting it
// reattaches exactly that session, so a detached session is picked up
// again without the picker. The server rotates it on every (re)connect.
function savedReconnect() {
  try {
    var token = fs.readFileSync(reconnectFile(), 'utf-8').trim();
    return /^[0-9a-zA-Z-]+$/.test(token) ? token : null;
  } catch (error) {
    return null;
  }
}

function saveReconnect(token) {
  if (!token) return;
  try { fs.writeFileSync(reconnectFile(), token + '\n', {mode: 0o600}); } catch (error) {}
}

function defaultUrl() {
  var port = 9022;
  var file = process.env.WSLOGIN_CONFIG || '/etc/wslogin/config.ini';
  try {
    var conf = ini.parse(fs.readFileSync(file, 'utf-8'));
    if (conf && conf.port) port = conf.port;
  } catch (error) {}
  return 'ws://127.0.0.1:' + port + '/pty';
}

function askText(question, initial) {
  return new Promise(function (resolve) {
    var rl = readline.createInterface({input: process.stdin,
      output: process.stderr, terminal: true});
    rl.question(question, function (answer) {
      rl.close();
      resolve(answer.trim() || initial || '');
    });
  });
}

function askSecret(question) {
  return new Promise(function (resolve) {
    var rl = readline.createInterface({input: process.stdin,
      output: process.stderr, terminal: true});
    rl._writeToOutput = function (s) { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.stdoutMuted = true;
    process.stderr.write(question);
    rl.question('', function (answer) {
      rl.stdoutMuted = false;
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var url = opts.url || defaultUrl();
  // a saved reconnect token reattaches the session this cli last used;
  // -n starts a fresh one and skips it
  var token = opts.picker ? savedReconnect() : null;
  connect(opts, url, issueCookie(), token);
}

function connect(opts, url, cookie, token) {
  var ws = new WebSocket(url);
  var state = 'auth';
  var authTries = 0;
  var loginPrompts = 0;
  var pickerList = [];
  var pickerRl = null;
  var cookiePhase = !token && !!cookie;
  var cookieAttempted = !!cookie;
  var reconnectPhase = !!token;

  function size() {
    return {cols: process.stdout.columns || 80, rows: process.stdout.rows || 24};
  }
  function sendCmd(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send('\x00' + JSON.stringify(obj));
  }
  function sendSizeCmd(cmd) {
    var s = size();
    sendCmd({cmd: cmd, cols: s.cols, rows: s.rows});
  }

  function cleanupStdin() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  function detach(message) {
    cleanupStdin();
    if (ws.readyState <= WebSocket.OPEN) ws.close();
    process.stdout.write('\x1b[0m');
    process.stderr.write(message + '\n');
    process.exit(0);
  }

  function enterRaw() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', function (chunk) {
      if (chunk[0] === 0x1d) {
        detach('detached. your session keeps running: wslogin re-attaches it.');
        return;
      }
      ws.send('\x01' + chunk.toString('utf8'));
    });
    process.stdout.on('resize', function () { sendSizeCmd('resize'); });
  }

  function goLive() {
    state = 'live';
    cookiePhase = false;
    reconnectPhase = false;
    enterRaw();
    // The replay is rendered at the session's stored geometry (the browser
    // adapts its element to that); a real terminal cannot, so announce our
    // own size right away and let the server resize the session to it.
    sendSizeCmd('resize');
  }

  function showPicker(list) {
    pickerList = list;
    process.stderr.write('\nyour disconnected terminals:\n');
    list.forEach(function (s, i) {
      process.stderr.write('  ' + (i + 1) + ')  '
        + (s.title ? s.title + '  ' : '')
        + s.cols + 'x' + s.rows + '\n');
    });
    process.stderr.write('  n) new session\n  q) quit\n');
  }

  function startPicker() {
    state = 'picker';
    cookiePhase = false;
    reconnectPhase = false;
    if (pickerRl) pickerRl.close();
    pickerRl = readline.createInterface({input: process.stdin,
      output: process.stderr, terminal: true});
    pickerRl.setPrompt('attach which? ');
    pickerRl.prompt();
    pickerRl.on('line', function (line) {
      var v = line.trim().toLowerCase();
      if (v === 'q') process.exit(0);
      var s = size();
      if (v === 'n') {
        pickerRl.close();
        pickerRl = null;
        state = 'replay';
        sendCmd({cmd: 'newsess', cols: s.cols, rows: s.rows});
        return;
      }
      var i = parseInt(v, 10);
      if (i >= 1 && i <= pickerList.length) {
        pickerRl.close();
        pickerRl = null;
        state = 'replay';
        sendCmd({cmd: 'pick', reconnect: pickerList[i - 1].reconnectid,
          cols: s.cols, rows: s.rows});
      } else {
        pickerRl.prompt();
      }
    });
  }

  async function doLogin() {
    var user = opts.user;
    if (!opts.userSet) {
      user = (await askText('wslogin user [' + opts.user + ']: ', opts.user))
        || opts.user;
      opts.user = user;
      opts.userSet = true;
    }
    var password = await askSecret('password: ');
    var s = size();
    // always authenticate in picker mode: a plain login would let the
    // server attach us to any disconnected session; 'newsess' forces a
    // fresh one
    sendCmd({cmd: 'login', username: user, password: password,
      picker: true, cols: s.cols, rows: s.rows});
  }

  ws.on('open', function () {
    sendSizeCmd('size');
    if (token) {
      sendCmd({cmd: 'reconnect', reconnect: token,
        cols: size().cols, rows: size().rows});
    } else if (cookie) {
      sendCmd({cmd: 'login', cookie: cookie, picker: true,
        cols: size().cols, rows: size().rows});
    }
  });

  ws.on('message', function (raw) {
    var buf = raw.toString('utf8');
    var tag = buf.charAt(0);
    var body = buf.substring(1);
    if (tag === '\x01') {
      if (state === 'live' || state === 'replay') process.stdout.write(body);
      return;
    }
    if (tag !== '\x00') return;
    var m;
    try { m = JSON.parse(body); } catch (error) { return; }
    switch (m.cmd) {
      case 'login':
        // the server's standard hello on connect: answered by the reconnect
        // token or the cookie already in flight; a second prompt means the
        // cookie was rejected
        if (reconnectPhase || cookiePhase) {
          if (++loginPrompts > 1) {
            reconnectPhase = false;
            cookiePhase = false;
            doLogin();
          }
        } else {
          doLogin();
        }
        break;
      case 'sessions':
        if (state === 'auth' || state === 'picker') {
          if (!opts.picker) {
            // -n: answer the picker with "new session"
            state = 'replay';
            sendSizeCmd('newsess');
            break;
          }
          showPicker(m.list);
          if (!pickerRl) startPicker();
        }
        break;
      case 'authenticated':
      case 'reconnected':
        saveReconnect(m.reconnect);
        goLive();
        break;
      case 'authfailed':
        if (++authTries >= 3) {
          process.stderr.write('wslogin: login failed\n');
          process.exit(1);
        }
        process.stderr.write('login failed\n');
        doLogin();
        break;
      case 'reconnectfailed':
        if (reconnectPhase) {
          // the saved token is gone (expired session): fall back to the
          // cookie login, which shows the picker
          reconnectPhase = false;
          if (cookie) {
            cookiePhase = true;
            cookieAttempted = true;
            sendCmd({cmd: 'login', cookie: cookie, picker: true,
              cols: size().cols, rows: size().rows});
          } else {
            doLogin();
          }
          break;
        }
        // the picker login found no disconnected terminal
        state = 'replay';
        sendSizeCmd('newsess');
        break;
      case 'b64':
        if (state === 'live' || state === 'replay') process.stdout.write(Buffer.from(m.data, 'base64'));
        break;
      case 'warn':
      case 'info':
      case 'error':
        process.stderr.write('\r\nwslogin: ' + (m.error || m.warn || m.info || '') + '\n');
        break;
      case 'resize':
      case 'replaydone':
      case 'cookie':
      case 'grantlink':
        break;
    }
  });

  ws.on('close', function () {
    if (state === 'live') detach('connection closed. your session keeps running server-side.');
    if (reconnectPhase && state === 'auth') {
      // the server closed the connection over the saved token: fall back
      // to the cookie login (picker)
      reconnectPhase = false;
      connect(opts, url, cookie, null);
      return;
    }
    if (cookieAttempted && state === 'auth') {
      // the server closed the connection over the cookie: retry once
      // without it
      cookieAttempted = false;
      cookiePhase = false;
      connect(opts, url, null, null);
      return;
    }
    detach('wslogin: connection closed');
  });

  ws.on('error', function (error) {
    if (reconnectPhase && state === 'auth') {
      reconnectPhase = false;
      connect(opts, url, cookie, null);
      return;
    }
    if (cookieAttempted && state === 'auth') {
      cookieAttempted = false;
      cookiePhase = false;
      connect(opts, url, null, null);
      return;
    }
    process.stderr.write('wslogin: ' + error.message + '\n');
    process.exit(1);
  });
}

main();
