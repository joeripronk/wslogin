'use strict';

// Decrypts Apache mod_session cookies (SessionCryptoPassphrase from
// mod_session_crypto) so wslogin can use the central auth server for
// single sign-on: requests presenting a valid session cookie of the auth
// server are logged in as that user without the login form.
//
// Cookie format (mod_session_crypto.c):
//   base64( siphash24-MAC(8) | salt(16, uuid) | IV(16) | AES-256-CBC )
// The key is PBKDF2-HMAC-SHA1(passphrase, salt, 4096, 32) (apr_crypto
// calls PKCS5_PBKDF2_HMAC_SHA1, 4096 iterations hardcoded in
// mod_session_crypto.c). The MAC key is MD5(passphrase).
// The plaintext is the session entries: urlencoded key=value pairs separated
// by '&', including 'user=' and 'expiry=' (microseconds).

const crypto = require('crypto');
const fs = require('fs');
const ini = require('ini');

const MASK64 = (1n << 64n) - 1n;

function add64(a, b) {
  return (a + b) & MASK64;
}
function rotl64(x, n) {
  return ((x << n) | (x >> (64n - n))) & MASK64;
}
function read64le(buf, offset) {
  var value = 0n;
  for (var i = 7; i >= 0; i--) value = (value << 8n) | BigInt(buf[offset + i]);
  return value;
}
function write64le(value) {
  var out = Buffer.alloc(8);
  for (var i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return out;
}
function sipround(v) {
  v[0] = add64(v[0], v[1]); v[1] = rotl64(v[1], 13n); v[1] ^= v[0]; v[0] = rotl64(v[0], 32n);
  v[2] = add64(v[2], v[3]); v[3] = rotl64(v[3], 16n); v[3] ^= v[2];
  v[0] = add64(v[0], v[3]); v[3] = rotl64(v[3], 21n); v[3] ^= v[0];
  v[2] = add64(v[2], v[1]); v[1] = rotl64(v[1], 17n); v[1] ^= v[2]; v[2] = rotl64(v[2], 32n);
  return v;
}
function siphash24(key, data) {
  var k0 = read64le(key, 0);
  var k1 = read64le(key, 8);
  var v = [
    (k0 ^ 0x736f6d6570736575n) & MASK64,
    (k1 ^ 0x646f72616e646f6dn) & MASK64,
    (k0 ^ 0x6c7967656e657261n) & MASK64,
    (k1 ^ 0x7465646279746573n) & MASK64
  ];
  var rem = data.length & 7;
  var end = data.length - rem;
  for (var offset = 0; offset < end; offset += 8) {
    var m = read64le(data, offset);
    v[3] ^= m; v = sipround(v); v = sipround(v); v[0] ^= m;
  }
  var last = BigInt(data.length & 0xff) << 56n;
  for (var i = rem - 1; i >= 0; i--) last |= BigInt(data[end + i]) << BigInt(8 * i);
  v[3] ^= last; v = sipround(v); v = sipround(v); v[0] ^= last;
  v[2] ^= 0xffn;
  v = sipround(v); v = sipround(v); v = sipround(v); v = sipround(v);
  return write64le((v[0] ^ v[1] ^ v[2] ^ v[3]) & MASK64);
}

function deriveKey(pass, salt, bytes, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(pass), salt,
    iterations == null ? 4096 : iterations, bytes, 'sha1');
}

function decryptCookie(value, passphrase) {
  var decoded = Buffer.from(value, 'base64');
  if (decoded.length < 8 + 16 + 16 + 16) return null;
  var salt = decoded.subarray(8, 24);
  var iv = decoded.subarray(24, 40);
  var cipher = decoded.subarray(40);
  if (cipher.length % 16 != 0) return null;
  var macKey = crypto.createHash('md5').update(passphrase, 'utf8').digest();
  var auth = siphash24(macKey, Buffer.concat([salt, iv, cipher]));
  if (!crypto.timingSafeEqual(auth, decoded.subarray(0, 8))) return null;
  var key = deriveKey(passphrase, salt, 32);
  try {
    var decrypt = crypto.createDecipheriv('aes-256-cbc', key, iv);
    var plain = Buffer.concat([decrypt.update(cipher), decrypt.final()]);
    return plain.toString('utf8').replace(/\0+$/, '');
  } catch (error) {
    return null;
  }
}

function parseSession(plain) {
  var entries = {};
  var pairs = plain.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i];
    var pos = pair.indexOf('=');
    if (pos < 1) continue;
    try {
      entries[decodeURIComponent(pair.substring(0, pos))]
        = decodeURIComponent(pair.substring(pos + 1));
    } catch (error) {
      continue;
    }
  }
  return entries;
}

function sessionEntries(value, passphrases) {
  for (var i = 0; i < passphrases.length; i++) {
    var plain = decryptCookie(value, passphrases[i]);
    if (plain == null && value.includes('%')) {
      try { plain = decryptCookie(decodeURIComponent(value), passphrases[i]); } catch (error) {}
    }
    if (plain == null) continue;
    var entries = parseSession(plain);
    var expiry = parseInt(entries.expiry, 10);
    if (Number.isFinite(expiry) && expiry < Date.now() * 1000) return null;
    // mod_session stores per-location entries, the user of the auth
    // server session is the value of a '<location>-user' key, the
    // password entered at the auth server (if stored) the value of a
    // '<location>-pw' key.
    var user = null;
    var pw = null;
    var keys = Object.keys(entries);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var value = entries[key];
      if (/(-user|user)$/.test(key) && !/-user$/.test(value) && !user) {
        user = value;
      }
      if (/(-pw|pw)$/.test(key) && !/-pw$/.test(value) && !pw) {
        pw = value;
      }
    }
    if (!user) return null;
    entries.user = user;
    entries.pw = pw;
    return entries;
  }
  return null;
}

function parseCookieHeader(header) {
  var cookies = {};
  if (!header) return cookies;
  var parts = header.split(/;\s*/);
  for (var i = 0; i < parts.length; i++) {
    var pos = parts[i].indexOf('=');
    if (pos < 1) continue;
    var name = parts[i].substring(0, pos).trim();
    var value = parts[i].substring(pos + 1).trim();
    try { value = decodeURIComponent(value); } catch (error) {}
    if (!(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

function loadAuthConfig(authPath) {
  var parsed = ini.parse(fs.readFileSync(authPath, 'utf-8'));
  var cookieName = parsed.cookie_name ? String(parsed.cookie_name).trim() : '';
  var domain = parsed.cookie_domain ? String(parsed.cookie_domain).trim().toLowerCase() : '';
  var passphrases = parsed.passphrase == null ? []
    : (Array.isArray(parsed.passphrase) ? parsed.passphrase : [parsed.passphrase])
      .map(function (pass) { return String(pass); });
  if (!cookieName || passphrases.length == 0) return null;
  var verifyPassword = parsed.verify_password == null ? true
    : !/^(false|off|no|0)$/i.test(String(parsed.verify_password).trim());
  var pamService = parsed.pam_service ? String(parsed.pam_service).trim() : 'wslogin';
  var ssoGroup = parsed.sso_group ? String(parsed.sso_group).trim() : '';
  return { cookieName: cookieName, domain: domain, passphrases: passphrases,
           verifyPassword: verifyPassword, pamService: pamService,
           ssoGroup: ssoGroup };
}

function createSsoAuth(authPath) {
  var path = authPath || process.env.WSLOGIN_AUTH_CONFIG || '/etc/wslogin/auth.ini';
  if (!fs.existsSync(path)) return null;
  var conf;
  try {
    conf = loadAuthConfig(path);
  } catch (error) {
    console.error("could not read auth configuration "+path+": "+error.message);
    return null;
  }
  if (!conf) {
    console.error("auth configuration "+path+" has no cookie_name or passphrase, sso login disabled");
    return null;
  }
  return {
    cookieName: conf.cookieName,
    verifyPassword: conf.verifyPassword,
    pamService: conf.pamService,
    ssoGroup: conf.ssoGroup,
    // the username of the auth server session of this request, false when
    // the request has no (or an invalid, expired) session cookie.
    username: function (request) {
      var cookies = parseCookieHeader(request.headers.cookie);
      var value = cookies[conf.cookieName];
      if (!value) return false;
      var entries = sessionEntries(value, conf.passphrases);
      if (!entries) return false;
      return entries.user;
    },
    // the username of a raw auth server session cookie value, false when
    // the value is not a valid, unexpired session cookie.
    usernameOf: function (value) {
      if (!value) return false;
      var entries = sessionEntries(value, conf.passphrases);
      if (!entries) return false;
      return entries.user;
    },
    // {user, password} of a raw auth server session cookie value, false
    // when invalid. the password is the one entered at the auth server,
    // empty when the session does not store it.
    credentialsOf: function (value) {
      if (!value) return false;
      var entries = sessionEntries(value, conf.passphrases);
      if (!entries) return false;
      return {user: entries.user, password: entries.pw || ''};
    },
    // true when host is the configured cookie domain or a subdomain of it.
    inDomain: function (host) {
      if (!conf.domain) return false;
      host = String(host).split('@').pop().split(':')[0].toLowerCase();
      return host == conf.domain || host.endsWith('.'+conf.domain);
    }
  };
}

module.exports = { createSsoAuth };
