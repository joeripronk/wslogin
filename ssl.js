'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_CERT_DIR = '/etc/wslogin/ssl';
const FALLBACK_CERT_DIR = 'ssl';
const SELF_SIGNED_KEY = 'selfsigned.key.pem';
const SELF_SIGNED_CERT = 'selfsigned.cert.pem';
const DEFAULT_DAYS = 3650;
const DEFAULT_RSA_BITS = 2048;

function boolOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].indexOf(v) >= 0) return false;
  if (['1', 'true', 'yes', 'on'].indexOf(v) >= 0) return true;
  return fallback;
}

function getSection(config, name) {
  const section = config ? config[name] : undefined;
  return (section && typeof section === 'object') ? section : {};
}

function resolvePath(p, baseDir) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (error) {
    return null;
  }
}

function localIpAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.internal) continue;
      const family = iface.family === 4 ? 'IPv4' : iface.family;
      if (family !== 'IPv4') continue;
      addresses.push(iface.address);
    }
  }
  return addresses;
}

function subjectAltNames(section) {
  const entries = ['DNS:localhost', 'IP:127.0.0.1'];
  const hostname = os.hostname();
  if (hostname) entries.push('DNS:' + hostname);
  const extra = section['alt_names'];
  if (extra) {
    for (const item of String(extra).split(',')) {
      const name = item.trim();
      if (!name) continue;
      if (/^[0-9.]+$/.test(name) || name.indexOf(':') >= 0) entries.push('IP:' + name);
      else entries.push('DNS:' + name);
    }
  }
  for (const ip of localIpAddresses()) entries.push('IP:' + ip);
  return Array.from(new Set(entries));
}

function certificateIsValid(certFile) {
  try {
    execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-checkend', '0'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function generateSelfSigned(section, certDir) {
  const keyFile = path.join(certDir, SELF_SIGNED_KEY);
  const certFile = path.join(certDir, SELF_SIGNED_CERT);
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && certificateIsValid(certFile)) {
    return { keyFile, certFile };
  }
  if (!opensslAvailable()) {
    throw new Error('openssl is required to generate a self-signed certificate, ' +
      'but it is not available. Install openssl or configure a certificate and key in the [https] section.');
  }
  const days = parseInt(section['days'], 10);
  const bits = parseInt(section['rsa_bits'], 10);
  const cn = String(section['common_name'] || os.hostname() || 'localhost').replace(/\s+/g, '-');
  const args = [
    'req', '-x509', '-newkey', 'rsa:' + (bits > 0 ? bits : DEFAULT_RSA_BITS),
    '-sha256', '-nodes', '-days', String(days > 0 ? days : DEFAULT_DAYS),
    '-subj', '/CN=' + cn,
    '-addext', 'subjectAltName=' + subjectAltNames(section).join(','),
    '-keyout', keyFile, '-out', certFile
  ];
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error('failed to generate a self-signed certificate: ' + detail);
  }
  return { keyFile, certFile };
}

function certDirFor(section, baseDir) {
  const configured = resolvePath(section['cert_dir'], baseDir);
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(DEFAULT_CERT_DIR);
  candidates.push(path.resolve(baseDir, FALLBACK_CERT_DIR));
  for (const candidate of candidates) {
    const dir = writableDir(candidate);
    if (dir) return dir;
  }
  throw new Error('no writable directory found to store a self-signed certificate');
}

function sslEnabled(section) {
  if ('active' in section) return boolOption(section['active'], false);
  if ('enabled' in section) return boolOption(section['enabled'], false);
  return !!(section['key'] && section['cert']);
}

/**
 * Whether plain http (and therefore ws) is allowed next to https/wss.
 * Enabled by default, disable it to force clients to use tls.
 */
function allowPlaintext(config) {
  const section = getSection(config, 'https');
  if ('allow_http' in section) return boolOption(section['allow_http'], true);
  if ('allow_plaintext' in section) return boolOption(section['allow_plaintext'], true);
  return true;
}

/**
 * Builds the options for https.createServer() based on the [https] section of
 * the configuration. Returns null when https is not enabled. When https is
 * enabled but no certificate/key is configured, a self-signed certificate is
 * generated (and reused on subsequent starts).
 */
function loadSslOptions(config, options) {
  const section = getSection(config, 'https');
  if (!sslEnabled(section)) return null;
  const baseDir = options && options.baseDir ? options.baseDir : __dirname;
  const passphrase = section['passphrase'] || section['key_password'] || undefined;
  const keyFile = resolvePath(section['key'], baseDir);
  const certFile = resolvePath(section['cert'], baseDir);
  if (keyFile || certFile) {
    if (!keyFile) throw new Error('no ssl key configured, only a certificate');
    if (!certFile) throw new Error('no ssl certificate configured, only a key');
    if (!fs.existsSync(keyFile)) throw new Error('ssl key file not found: ' + keyFile);
    if (!fs.existsSync(certFile)) throw new Error('ssl certificate file not found: ' + certFile);
    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
      passphrase: passphrase,
      keyFile: keyFile,
      certFile: certFile,
      selfSigned: false
    };
  }
  const certDir = certDirFor(section, baseDir);
  const generated = generateSelfSigned(section, certDir);
  return {
    key: fs.readFileSync(generated.keyFile),
    cert: fs.readFileSync(generated.certFile),
    passphrase: passphrase,
    keyFile: generated.keyFile,
    certFile: generated.certFile,
    selfSigned: true
  };
}

module.exports = {
  loadSslOptions: loadSslOptions,
  sslEnabled: sslEnabled,
  allowPlaintext: allowPlaintext,
  boolOption: boolOption,
  getSection: getSection
};
