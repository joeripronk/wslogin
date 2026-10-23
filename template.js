'use strict';

const path = require('path');

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = '0' + text;
  return text;
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value == 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  return new Date();
}

// Formats a date using YYYY, YY, mm (month), dd (day), HH, MM (minutes) and
// ss. The value may be a Date or a number of seconds since the epoch. Local
// time is used, so YYYY-mm-dd matches the usual calendar notation.
function formatDate(value, format) {
  var date = asDate(value);
  var parts = {
    YYYY: function() { return pad(date.getFullYear(), 4); },
    YY: function() { return pad(date.getFullYear() % 100, 2); },
    mm: function() { return pad(date.getMonth() + 1, 2); },
    dd: function() { return pad(date.getDate(), 2); },
    HH: function() { return pad(date.getHours(), 2); },
    MM: function() { return pad(date.getMinutes(), 2); },
    ss: function() { return pad(date.getSeconds(), 2); }
  };
  return String(format).replace(/YYYY|YY|mm|dd|HH|MM|ss/g, function(token) {
    return parts[token]();
  });
}

// Renders a path template. Placeholders are written as <name> and dates as
// <%date FORMAT>, for example <%date YYYY-mm-dd>/<hostname>/<session>.json.
function render(template, values) {
  var source = String(template);
  var rendered = source.replace(/<%date\s+([^>]+)>/g, function(match, format) {
    return formatDate(values.date, format.trim());
  });
  return rendered.replace(/<([A-Za-z_][A-Za-z0-9_]*)>/g, function(match, name) {
    if (!(name in values) || values[name] == null || values[name] === '') {
      return match;
    }
    return String(values[name]);
  });
}

// Returns the set of placeholder names used by a template, including "date".
function placeholders(template) {
  var names = new Set();
  var source = String(template);
  source.replace(/<%date\s+[^>]+>/g, function() {
    names.add('date');
  });
  source.replace(/<([A-Za-z_][A-Za-z0-9_]*)>/g, function(match, name) {
    names.add(name);
  });
  return names;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches a relative path against a template and returns the placeholder
// values, or null. Only simple <name> placeholders can be captured.
function match(template, relative, names) {
  var source = String(template);
  var pattern = '^';
  var captured = [];
  var re = /<%date\s+[^>]+>|<([A-Za-z_][A-Za-z0-9_]*)>/g;
  var last = 0;
  var found;
  while ((found = re.exec(source))) {
    pattern += escapeRegExp(source.slice(last, found.index));
    if (found[1]) {
      if (!names || names.indexOf(found[1]) == -1) return null;
      captured.push(found[1]);
      pattern += '([^/]+)';
    } else {
      pattern += '[^/]+';
    }
    last = re.lastIndex;
  }
  pattern += escapeRegExp(source.slice(last)) + '$';
  var result = new RegExp(pattern).exec(relative);
  if (!result) return null;
  var values = {};
  for (var i = 0; i < captured.length; i++) {
    values[captured[i]] = result[i + 1];
  }
  return values;
}

// Rejects absolute paths and paths that escape their base directory.
function isSafeRelative(relative) {
  if (typeof relative != 'string' || relative.length == 0) return false;
  if (path.isAbsolute(relative)) return false;
  var normalized = path.normalize(relative);
  if (normalized == '.' || normalized == '..') return false;
  if (normalized.startsWith('..' + path.sep)) return false;
  return true;
}

module.exports = {
  formatDate: formatDate,
  render: render,
  placeholders: placeholders,
  match: match,
  isSafeRelative: isSafeRelative
};
