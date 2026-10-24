#!/usr/bin/env node
'use strict';

process.title = 'wslogin-playback';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ini = require('ini');
const pam = require('authenticate-pam');
const { createPlayback } = require('./playback');
const { createSsoAuth, parseCookieHeader } = require('./auth');

const configPath = process.env.WSLOGIN_CONFIG || '/etc/wslogin/playback.ini';
if (!fs.existsSync(configPath)) {
  console.error('configuration file not found: ' + configPath);
  process.exit(1);
}
const config = ini.parse(fs.readFileSync(configPath, 'utf-8', true));
console.log('using configuration file ' + configPath);

function configInt(name, fallback) {
  if (!(name in config)) return fallback;
  const value = parseInt(config[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

const port = configInt('port', 9024);
const bindAddress = config.bind_address || '127.0.0.1';

const ssoAuth = createSsoAuth();
if (ssoAuth) {
  console.log('sso login enabled for cookie ' + ssoAuth.cookieName);
}

var groupcache = {time: 0, lines: []};
function userInGroup(username, group) {
  var nowms = Date.now();
  if (nowms - groupcache.time > 10000) {
    try {
      groupcache.lines = fs.readFileSync('/etc/group', 'utf8').split('\n');
      groupcache.time = nowms;
    } catch (error) {
      console.error('cannot read /etc/group: ' + error.message);
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
    console.error('cannot read /etc/passwd: ' + error.message);
  }
  return false;
}

// The username of a request with a valid auth server session cookie
// (auth.ini), false when the request has no usable sso session. Mirrors
// the sso checks of server.js: cookie domain, sso group, root, and PAM
// verification of the password stored in the auth server session.
function ssoUser(request, callback) {
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
  if (!cred || !cred.user) {
    callback(false);
    return;
  }
  if (cred.user == 'root') {
    callback(false);
    return;
  }
  if (ssoAuth.domain && !ssoAuth.inDomain(request.headers.host || '')) {
    console.log('sso rejected: host ' + request.headers.host
      + ' outside cookie domain ' + ssoAuth.domain);
    callback(false);
    return;
  }
  if (ssoAuth.ssoGroup && !userInGroup(cred.user, ssoAuth.ssoGroup)) {
    console.log('sso user ' + cred.user + ' is not in group '
      + ssoAuth.ssoGroup);
    callback(false);
    return;
  }
  if (!ssoAuth.verifyPassword) {
    console.log('sso login for ' + cred.user + ' on playback'
      + ' (pam verification disabled)');
    callback(cred.user);
    return;
  }
  if (!cred.password) {
    console.log('sso session of ' + cred.user
      + ' has no stored password, pam verification impossible');
    callback(false);
    return;
  }
  pam.authenticate(cred.user, cred.password, function(error) {
    if (error) {
      console.log('pam verification failed for sso user ' + cred.user
        + ': ' + error);
      callback(false);
      return;
    }
    console.log('sso login for ' + cred.user + ' on playback');
    callback(cred.user);
  }, {serviceName: ssoAuth.pamService});
}

let playback;
try {
  playback = createPlayback(config, {
    baseDir: __dirname,
    hostname: os.hostname(),
    sso: {user: ssoUser},
    authenticate: function(username, password, callback) {
      pam.authenticate(username, password, function(error) {
        callback(error);
      }, {serviceName: config.playback_auth_service || 'sshd'});
    }
  });
} catch (error) {
  console.error('playback configuration error: ' + error.message);
  process.exit(1);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function httpHandler(request, response) {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch (error) {
    response.statusCode = 400;
    response.end('bad request');
    return;
  }
  if (url.pathname === '/health') {
    sendJson(response, 200, {ok: true, playback: playback.enabled});
    return;
  }
  if (url.pathname === '/api/playback'
      || url.pathname.startsWith('/api/playback/')) {
    playback.handle(request, response, url).catch(function(error) {
      console.error('playback request failed: ' + error.message);
      if (!response.headersSent) {
        sendJson(response, 500, {error: 'internal server error'});
      } else if (!response.writableEnded) {
        response.end();
      }
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/playback') {
    response.statusCode = 302;
    response.setHeader('Location', '/playback/');
    response.end('');
    return;
  }
  if (url.pathname === '/playback/login') {
    playback.serveStatic(response, 'login.html');
    return;
  }
  if (url.pathname === '/playback/' || url.pathname.startsWith('/playback/')) {
    const asset = url.pathname.slice('/playback/'.length) || 'index.html';
    playback.serveStatic(response, asset);
    return;
  }
  response.statusCode = 404;
  response.end('');
}

const server = http.createServer(httpHandler);
server.requestTimeout = 0;
server.listen(port, bindAddress, function() {
  console.log('playback server listening on ' + bindAddress + ':' + port);
  console.log('playback: enabled=' + playback.enabled
    + ' dir=' + playback.sessionDir
    + ' www=' + playback.wwwDir
    + ' cache=' + playback.cacheDir
    + ' auth=' + playback.authRequired
    + ' idle=' + playback.idleSkipEnabled + '/'
    + playback.idleSkipSeconds + 's'
    + ' video=' + playback.idleVideoDelaySeconds + 's'
    + ' overlay=' + playback.idleOverlayDelaySeconds + 's'
    + ' auto=' + playback.idleAutoSkipSeconds + 's'
    + ' movieAuto=' + playback.idleMovieAutoSkipSeconds + 's');
});

function shutdown() {
  server.close(function() {
    process.exit(0);
  });
  setTimeout(function() {
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
