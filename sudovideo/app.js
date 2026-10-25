'use strict';

var API = '/api/playback';
var state = {
  sessions: [],
  current: null,
  active: false,
  start: 0,
  end: 0,
  time: 0,
  seekTarget: 0,
  speed: 1,
  playing: false,
  live: false,
  liveMode: null,
  liveTarget: null,
  liveMeta: null,
  streamDone: false,
  streamId: 0,
  abort: null,
  autoPlay: false,
  started: false,
  queue: [],
  queueIndex: 0,
  lastEventT: null,
  termCols: 80,
  termRows: 24,
  dragging: false,
  lastFrame: 0,
  liveBase: 0,
  liveReal: 0,
  lastUi: 0,
  matches: [],
  matchIndex: -1,
  searchQuery: '',
  idleSkipping: false,
  idleTo: 0,
  idleOverlayTimer: null,
  idleVideoTimer: null,
  idleAutoSkipTimer: null,
  idleTimer: null,
  idleCountdownTimer: null,
  activity: null,
  timeMode: 'real',
  idleConfig: {
    enabled: true,
    thresholdSeconds: 10,
    video: 'onehour.mp4',
    videoDelaySeconds: 5,
    overlayDelaySeconds: 1,
    autoSkipSeconds: 10,
    movieAutoSkipSeconds: 0,
    showVideoSeconds: 600
  }
};

var terminal = null;
var fitAddon = null;
var resizeObserver = null;
var mouseOverlay = null;
var ghostOverlay = null;
var mouseDrag = null;
var mouseTracking = { click: false, drag: false, motion: false, sgr: false, urxvt: false, utf8: false };

function byId(id) {
  return document.getElementById(id);
}

var els = {
  layout: byId('layout'),
  sidebar: byId('sidebar'),
  sidebarEdge: byId('sidebar-edge'),
  connection: byId('connection'),
  head: byId('viewer-head'),
  headTab: byId('head-tab'),
  pinHead: byId('pin-head'),
  refresh: byId('refresh'),
  filter: byId('filter'),
  list: byId('session-list'),
  listStatus: byId('list-status'),
  title: byId('session-title'),
  meta: byId('session-meta'),
  searchInput: byId('search-input'),
  searchCount: byId('search-count'),
  searchPrev: byId('search-prev'),
  searchNext: byId('search-next'),
  download: byId('download'),
  liveView: byId('live-view'),
  liveShare: byId('live-share'),
  frame: byId('terminal-frame'),
  terminalHost: byId('terminal'),
  empty: byId('empty-state'),
  loading: byId('loading-state'),
  loadingText: byId('loading-text'),
  idleOverlay: byId('idle-overlay'),
  idleVideo: byId('idle-video'),
  idleText: byId('idle-text'),
  idleSkip: byId('idle-skip'),
  idleSkipOverlay: byId('idle-skip-overlay'),
  idleSkipText: byId('idle-skip-text'),
  idleSkipNow: byId('idle-skip-now'),
  idleCountdown: byId('idle-countdown'),
  idleSkipCountdown: byId('idle-skip-countdown'),
  play: byId('play'),
  stop: byId('stop'),
  time: byId('time'),
  timeDate: byId('time-date'),
  seek: byId('seek'),
  activity: byId('activity-canvas'),
  speed: byId('speed'),
  live: byId('live'),
  idleTimer: byId('idle-timer')
};

function setConnection(text, kind) {
  els.connection.textContent = text;
  els.connection.className = 'connection' + (kind ? ' ' + kind : '');
}

function requireLogin() {
  var next = location.pathname + location.search + location.hash;
  location.href = './login?next=' + encodeURIComponent(next);
}

var SESSIONS_STALE_MS = 5000;
var lastSessionsLoad = 0;

function refreshSessionsIfStale() {
  if (Date.now() - lastSessionsLoad < SESSIONS_STALE_MS) return;
  loadSessions();
}

function setSidebarVisible(visible) {
  var wasHidden = els.layout.classList.contains('sidebar-hidden');
  els.layout.classList.toggle('sidebar-hidden', !visible);
  els.layout.classList.remove('sidebar-hover');
  els.sidebar.setAttribute('aria-hidden', visible ? 'false' : 'true');
  hoverArmed = true;
  scheduleFit();
  if (visible && wasHidden) refreshSessionsIfStale();
}

var hoverCloseTimer = false;
var hoverArmed = true;
var hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function openSidebarHover() {
  if (!hoverArmed) return;
  if (hoverCloseTimer) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = false;
  }
  var wasClosed = !els.layout.classList.contains('sidebar-hover');
  els.layout.classList.add('sidebar-hover');
  els.sidebar.setAttribute('aria-hidden', 'false');
  if (wasClosed) refreshSessionsIfStale();
}

function closeSidebarHover() {
  els.layout.classList.remove('sidebar-hover');
  els.sidebar.setAttribute('aria-hidden', 'true');
  hoverArmed = false;
}

window.addEventListener('mousemove', function(event) {
  if (!hoverCapable) return;
  if (!els.layout.classList.contains('sidebar-hidden')) return;
  if (els.layout.classList.contains('sidebar-hover')) {
    if (event.clientX > els.sidebar.offsetWidth + 24) {
      if (!hoverCloseTimer) {
        hoverCloseTimer = setTimeout(function() {
          hoverCloseTimer = false;
          closeSidebarHover();
        }, 400);
      }
    } else if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = false;
    }
  } else if (!hoverArmed && event.clientX > 40) {
    hoverArmed = true;
  }
});

els.sidebar.addEventListener('focusin', openSidebarHover);
els.sidebarEdge.addEventListener('mouseenter', openSidebarHover);

if (!hoverCapable) setSidebarVisible(true);

var HEAD_IDLE_MS = 800;
var headIdleTimer = null;
var headHover = false;

try {
  state.headPinned = localStorage.getItem('wslogin.headPinned') == '1';
} catch (error) {
  state.headPinned = false;
}

try {
  state.timeMode = localStorage.getItem('wslogin.timeMode') === 'relative'
    ? 'relative' : 'real';
} catch (error) {
  state.timeMode = 'real';
}

function showHead() {
  els.layout.classList.remove('head-hidden');
  armHeadIdle();
}

function armHeadIdle() {
  if (headIdleTimer) clearTimeout(headIdleTimer);
  headIdleTimer = setTimeout(function() {
    if (state.headPinned || headHover
        || (document.activeElement && els.head.contains(document.activeElement))) {
armHeadIdle();
      return;
    }
    els.layout.classList.add('head-hidden');
  }, HEAD_IDLE_MS);
}

els.head.addEventListener('mouseenter', function() {
  headHover = true;
});

els.headTab.addEventListener('mouseenter', function() {
  if (!state.headPinned) showHead();
});

els.headTab.addEventListener('click', showHead);

function setHeadTab(text) {
  els.headTab.textContent = text || '';
  els.headTab.classList.toggle('hidden', !text);
}

function updateLiveButtons() {
  var meta = state.current || state.liveMeta;
  var viewOk = false;
  var shareOk = false;
  if (meta) {
    var liveView = typeof meta.viewid === 'string'
      && typeof meta.viewurl === 'string';
    var liveShare = typeof meta.shareid === 'string'
      && typeof meta.shareurl === 'string';
    if (state.liveMode === 'view') {
      viewOk = true;
      shareOk = liveShare;
    } else if (state.liveMode === 'share') {
      viewOk = liveView;
      shareOk = true;
    } else {
      viewOk = liveView && state.active === true;
      shareOk = liveShare && state.active === true;
    }
  }
  var viewHref = viewOk ? liveHref(meta, 'view') : null;
  var shareHref = shareOk ? liveHref(meta, 'share') : null;
  if (state.liveMode === 'view') viewHref = '#';
  if (state.liveMode === 'share') shareHref = '#';
  if (viewHref) {
    els.liveView.href = viewHref;
    els.liveView.classList.remove('hidden');
  } else {
    els.liveView.classList.add('hidden');
  }
  if (shareHref) {
    els.liveShare.href = shareHref;
    els.liveShare.classList.remove('hidden');
  } else {
    els.liveShare.classList.add('hidden');
  }
  els.liveView.classList.toggle('on', state.liveMode === 'view');
  els.liveShare.classList.toggle('on', state.liveMode === 'share');
}

function exitLive() {
  var meta = state.liveMeta;
  stopLive();
  updateControls();
  if (meta && meta.username && meta.session) {
    openStream(meta, Number(meta.enddate) || undefined, true);
  } else {
    els.layout.classList.add('browsing');
    els.empty.classList.remove('hidden');
  }
}

function liveLinkClick(mode) {
  return function(event) {
    if (state.liveMode === mode) {
      event.preventDefault();
      exitLive();
    }
  };
}

els.liveView.addEventListener('click', liveLinkClick('view'));
els.liveShare.addEventListener('click', liveLinkClick('share'));

els.head.addEventListener('mouseleave', function() {
  headHover = false;
  armHeadIdle();
});

els.pinHead.checked = state.headPinned;
els.pinHead.addEventListener('change', function() {
  state.headPinned = els.pinHead.checked;
  try {
    localStorage.setItem('wslogin.headPinned', state.headPinned ? '1' : '0');
  } catch (error) {}
  showHead();
});

armHeadIdle();

function setStatus(text, kind) {}

function setLoading(text) {
  if (text) {
    els.loadingText.textContent = text;
    els.loading.classList.remove('hidden');
  } else {
    els.loading.classList.add('hidden');
  }
}

function markLoaded() {
  els.loading.classList.add('hidden');
  els.empty.classList.add('hidden');
  if (!state.started && state.autoPlay
      && (state.active || state.streamDone)) {
    state.started = true;
    state.autoPlay = false;
    beginPlayback();
  }
}

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  var secs = seconds % 60;
  if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(secs);
  return pad(minutes) + ':' + pad(secs);
}

function formatDate(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(epochSeconds * 1000));
  } catch (error) {
    return new Date(epochSeconds * 1000).toLocaleString();
  }
}

function formatClockTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return '--:--:--';
  var d = new Date(epochSeconds * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':'
    + pad(d.getSeconds());
}

function formatClockDate(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: '2-digit'
    }).format(new Date(epochSeconds * 1000));
  } catch (error) {
    return new Date(epochSeconds * 1000).toDateString();
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return (bytes || 0) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
}

function newTerminal(cols, rows) {
  if (terminal) {
    try { terminal.dispose(); } catch (error) {}
    terminal = null;
  }
  els.terminalHost.innerHTML = '';
  terminal = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: false,
    cursorInactiveStyle: 'block',
    fontFamily: '"Ubuntu Mono", "DejaVu Sans Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 14,
    lineHeight: 1,
    scrollback: 10000,
    theme: {
      background: '#090b0e',
      foreground: '#d8dee8',
      cursor: '#5aa9e6',
      cursorAccent: '#090b0e',
      selectionBackground: '#294a66',
      black: '#1d232b',
      red: '#e06c75',
      green: '#7bd88f',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d8dee8',
      brightBlack: '#5c6773',
      brightRed: '#ff7b86',
      brightGreen: '#9be8ab',
      brightYellow: '#f2d49b',
      brightBlue: '#8bc4ff',
      brightMagenta: '#dfa6ef',
      brightCyan: '#82d9e2',
      brightWhite: '#ffffff'
    }
  });
  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
  terminal.open(els.terminalHost);
  // The DOM renderer lays out glyphs in CSS line boxes, whose leading shows
  // up as small gaps between rows. The canvas renderer draws glyphs at exact
  // row positions and is seamless in all browsers.
  if (window.CanvasAddon) {
    try { terminal.loadAddon(new CanvasAddon.CanvasAddon()); } catch (error) {}
  }
  mouseOverlay = document.createElement('div');
  mouseOverlay.className = 'mouse-cursor hidden';
  mouseOverlay.setAttribute('aria-hidden', 'true');
  terminal.element.appendChild(mouseOverlay);
  ghostOverlay = document.createElement('div');
  ghostOverlay.className = 'ghost-selection hidden';
  ghostOverlay.setAttribute('aria-hidden', 'true');
  terminal.element.appendChild(ghostOverlay);
  resetMouseTracking();
  terminal.onTitleChange(function(title) {
    setHeadTab(title);
  });
  state.termCols = Math.max(2, cols || 80);
  state.termRows = Math.max(2, rows || 24);
  terminal.resize(state.termCols, state.termRows);
  requestAnimationFrame(function() {
    requestAnimationFrame(scaleTerminal);
  });
}

var measureCanvas = null;

function cellMetrics(fontSize) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  var ctx = measureCanvas.getContext('2d');
  ctx.font = fontSize + 'px "Ubuntu Mono", "DejaVu Sans Mono", monospace';
  var width = 0;
  var text = 'MW@mw0_';
  for (var i = 0; i < text.length; i++) {
    width = Math.max(width, ctx.measureText(text[i]).width);
  }
  var textMetrics = ctx.measureText('M');
  var ascent = textMetrics.fontBoundingBoxAscent || fontSize * 1.15;
  var descent = textMetrics.fontBoundingBoxDescent || fontSize * 0.3;
  return { width: width + 0.5, height: (ascent + descent) + 0.5 };
}

function scaleTerminal() {
  if (!terminal || (!state.current && !state.liveMode)) return;
  var cols = Math.max(2, state.termCols);
  var rows = Math.max(2, state.termRows);
  if (terminal.options.fontSize !== 14) terminal.options.fontSize = 14;
  if (terminal.cols !== cols || terminal.rows !== rows) {
    terminal.resize(cols, rows);
  }
  var host = els.terminalHost;
  var width = host.clientWidth;
  var height = host.clientHeight;
  if (!width || !height) return;
  var cell;
  try {
    cell = terminal._core._renderService.dimensions.css.cell;
  } catch (error) {
    cell = null;
  }
  if (!cell || !cell.width || !cell.height) cell = cellMetrics(14);
  var scale = Math.min(width / (cols * cell.width + 8),
    height / (rows * cell.height));
  scale = Math.max(0.2, Math.min(8, scale));
  var el = terminal.element;
  el.style.transformOrigin = '0 0';
  el.style.transform = 'scale(' + scale + ')';
  el.style.width = Math.floor(width / scale) + 'px';
  el.style.height = Math.floor(height / scale) + 'px';
}

var fitTimer = null;
function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(scaleTerminal, 80);
}

function resetMouseTracking() {
  mouseTracking = {
    click: false, drag: false, motion: false,
    sgr: false, urxvt: false, utf8: false
  };
  mouseDrag = null;
  if (mouseOverlay) mouseOverlay.classList.add('hidden');
  if (ghostOverlay) ghostOverlay.classList.add('hidden');
}

function mouseTrackingActive() {
  return mouseTracking.click || mouseTracking.drag || mouseTracking.motion;
}

function trackMouseModes(data) {
  var match;
  var re = /\x1b\[\?(\d+)([hl])/g;
  while ((match = re.exec(data))) {
    var mode = Number(match[1]);
    var on = match[2] === 'h';
    if (mode === 1000) mouseTracking.click = on;
    else if (mode === 1002) mouseTracking.drag = on;
    else if (mode === 1003) mouseTracking.motion = on;
    else if (mode === 1006) mouseTracking.sgr = on;
    else if (mode === 1015) mouseTracking.urxvt = on;
    else if (mode === 1005) mouseTracking.utf8 = on;
  }
  if (!mouseTrackingActive()) {
    endDrag();
    if (mouseOverlay) mouseOverlay.classList.add('hidden');
  }
}

function gridMetrics() {
  var cell;
  try {
    cell = terminal._core._renderService.dimensions.css.cell;
  } catch (error) {
    cell = null;
  }
  if (!cell || !cell.width || !cell.height) cell = cellMetrics(14);
  var screen = terminal.element.querySelector('.xterm-screen');
  return { cell: cell, offsetX: screen ? screen.offsetLeft : 0,
    offsetY: screen ? screen.offsetTop : 0 };
}

function showMouseCursor(col, row) {
  if (!mouseOverlay || !terminal) return;
  col = Math.min(Math.max(col, 0), terminal.cols - 1);
  row = Math.min(Math.max(row, 0), terminal.rows - 1);
  var grid = gridMetrics();
  mouseOverlay.style.left =
    Math.floor(grid.offsetX + (col + 0.5) * grid.cell.width) + 'px';
  mouseOverlay.style.top =
    Math.floor(grid.offsetY + (row + 0.5) * grid.cell.height) + 'px';
  mouseOverlay.classList.remove('hidden');
}

function showGhostSelection(colA, rowA, colB, rowB) {
  if (!ghostOverlay || !terminal) return;
  var grid = gridMetrics();
  var c0 = Math.min(Math.max(Math.min(colA, colB), 0), terminal.cols - 1);
  var c1 = Math.min(Math.max(Math.max(colA, colB), 0), terminal.cols - 1);
  var r0 = Math.min(Math.max(Math.min(rowA, rowB), 0), terminal.rows - 1);
  var r1 = Math.min(Math.max(Math.max(rowA, rowB), 0), terminal.rows - 1);
  ghostOverlay.style.left = Math.floor(grid.offsetX + c0 * grid.cell.width) + 'px';
  ghostOverlay.style.top = Math.floor(grid.offsetY + r0 * grid.cell.height) + 'px';
  ghostOverlay.style.width = Math.ceil((c1 - c0 + 1) * grid.cell.width) + 'px';
  ghostOverlay.style.height = Math.ceil((r1 - r0 + 1) * grid.cell.height) + 'px';
  ghostOverlay.classList.remove('hidden');
}

function startDrag(col, row) {
  mouseDrag = { col: col, row: row };
  showGhostSelection(col, row, col, row);
}

function extendDrag(col, row) {
  if (!mouseDrag) return;
  showGhostSelection(mouseDrag.col, mouseDrag.row, col, row);
}

function endDrag() {
  mouseDrag = null;
  if (ghostOverlay) ghostOverlay.classList.add('hidden');
}

function handleMouseReports(data) {
  if (!mouseTrackingActive()) return;
  var match;
  var re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  var found = false;
  while ((match = re.exec(data))) {
    found = true;
    var col = Number(match[2]) - 1;
    var row = Number(match[3]) - 1;
    if (match[4] === 'M') {
      var btn = Number(match[1]);
      showMouseCursor(col, row);
      if (btn & 32) extendDrag(col, row);
      else startDrag(col, row);
    } else {
      endDrag();
      if (mouseOverlay) mouseOverlay.classList.add('hidden');
    }
  }
  re = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
  while ((match = re.exec(data))) {
    found = true;
    var btn = match[1].charCodeAt(0) - 32;
    var col = match[2].charCodeAt(0) - 33;
    var row = match[3].charCodeAt(0) - 33;
    showMouseCursor(col, row);
    if (btn === 3) endDrag();
    else if (btn & 32) extendDrag(col, row);
    else startDrag(col, row);
  }
  if (mouseTracking.urxvt && !found) {
    re = /\x1b\[(\d+);(\d+);(\d+)M/g;
    while ((match = re.exec(data))) {
      showMouseCursor(Number(match[2]) - 1, Number(match[3]) - 1);
    }
  }
}

function applyEvent(event) {
  if (!terminal || !event) return;
  if (event.c === 1) {
    var data = String(event.d || '');
    trackMouseModes(data);
    terminal.write(data);
    return;
  }
  if (event.c === 2) {
    handleMouseReports(String(event.d || ''));
    return;
  }
  if (event.c === 3) {
    try {
      var mouse = JSON.parse(String(event.d || ''));
      var col = Number(mouse.x) - 1;
      var row = Number(mouse.y) - 1;
      if (mouse.b === 2) {
        endDrag();
        if (mouseOverlay) mouseOverlay.classList.add('hidden');
      } else if (mouse.b === 1) {
        showMouseCursor(col, row);
        if (mouse.k === 0) startDrag(col, row);
        else endDrag();
      } else {
        showMouseCursor(col, row);
        extendDrag(col, row);
      }
    } catch (error) {}
    return;
  }
  if (event.c === 0 && typeof event.d === 'string') {
    try {
      var command = JSON.parse(event.d);
      if (command.cmd === 'resize'
          && Number.isInteger(command.cols) && Number.isInteger(command.rows)
          && command.cols > 0 && command.rows > 0) {
        state.termCols = command.cols;
        state.termRows = command.rows;
        terminal.resize(command.cols, command.rows);
        scheduleFit();
      }
    } catch (error) {}
  }
}

function drawActivity() {
  var canvas = els.activity;
  if (!canvas) return;
  var rect = canvas.getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  var width = Math.max(1, Math.round(rect.width * dpr));
  var height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  var context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  var activity = state.activity;
  if (!activity || !Number.isFinite(activity.bins)
      || !Array.isArray(activity.output) || !Array.isArray(activity.input)
      || !Array.isArray(activity.hidden)) {
    return;
  }
  var bins = Math.max(1, activity.bins);
  var gap = Math.max(1, Math.round(height * 0.04));
  var laneHeight = Math.max(1, Math.floor((height - gap * 2) / 3));

  function drawLane(values, color, lane) {
    var base = lane * (laneHeight + gap) + laneHeight;
    context.fillStyle = color;
    for (var i = 0; i < bins; i++) {
      var value = values[i] || 0;
      if (value <= 0) continue;
      var x = Math.floor(i * width / bins);
      var next = Math.floor((i + 1) * width / bins);
      var barWidth = Math.max(1, next - x);
      var barHeight = Math.max(1, Math.round(value / 100 * laneHeight));
      context.fillRect(x, base - barHeight, barWidth, barHeight);
    }
  }

  drawLane(activity.output, 'rgba(255, 159, 67, 0.88)', 0);
  drawLane(activity.input, 'rgba(74, 163, 255, 0.9)', 1);
  drawLane(activity.hidden, 'rgba(255, 90, 95, 0.95)', 2);
}

function updateTimeDisplay(relative) {
  var duration = Math.max(0, state.end - state.start);
  if (!state.current) {
    els.time.textContent = '--:-- / --:--';
    els.timeDate.textContent = '';
    els.timeDate.classList.add('hidden');
    return;
  }
  if (state.timeMode === 'real') {
    var epoch = state.start + relative;
    els.time.textContent = formatClockTime(epoch);
    els.timeDate.textContent = formatClockDate(epoch);
    els.timeDate.classList.remove('hidden');
  } else {
    els.time.textContent = formatDuration(relative) + ' / '
      + formatDuration(duration);
    els.timeDate.textContent = '';
    els.timeDate.classList.add('hidden');
  }
}

var LIVE_IDLE_SECONDS = 15;

function updateIdleTimer() {
  var idle = state.live && Number.isFinite(state.end)
    ? Date.now() / 1000 - state.end : 0;
  var show = idle > LIVE_IDLE_SECONDS;
  els.idleTimer.classList.toggle('hidden', !show);
  if (show) els.idleTimer.textContent = 'Idle ' + formatDuration(idle);
}

function updateControls() {
  var duration = Math.max(0, state.end - state.start);
  var relative = Math.max(0, Math.min(duration, state.time - state.start));
  updateTimeDisplay(relative);
  updateIdleTimer();
  els.seek.max = String(duration);
  if (!state.dragging) els.seek.value = String(relative);
  els.play.textContent = state.playing ? '\u23F8' : '\u25B6';
  els.play.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
  els.live.classList.toggle('hidden', !state.active);
  els.live.classList.toggle('on', state.live);
  els.live.textContent = state.live ? 'Live' : 'Go live';
  updateLiveButtons();
}

function requestTick() {
  requestAnimationFrame(tick);
}

function anchorLive() {
  state.liveBase = state.time;
  state.liveReal = Date.now() / 1000;
}

// Live display clock: advances in real time, never ahead of the newest
// event and never more than one second behind it.
function liveTarget() {
  var wall = Date.now() / 1000;
  state.liveBase += wall - state.liveReal;
  state.liveReal = wall;
  if (state.liveBase > state.end) state.liveBase = state.end;
  if (state.liveBase < state.end - 1) state.liveBase = state.end - 1;
  return state.liveBase;
}

function beginPlayback() {
  if (!state.current) return;
  if (state.streamDone && state.time >= state.end - 0.01) {
    seekTo(state.start, true);
    return;
  }
  state.playing = true;
  state.lastFrame = 0;
  if (state.active && state.time >= state.end - 0.25) {
    state.live = true;
    state.time = state.end;
    anchorLive();
  }
  updateControls();
  requestTick();
}

function pausePlayback() {
  state.playing = false;
  state.live = false;
  if (state.idleSkipping) finishIdleSkip();
  updateControls();
}

function clearIdleTimers() {
  if (state.idleOverlayTimer) {
    clearTimeout(state.idleOverlayTimer);
    state.idleOverlayTimer = null;
  }
  if (state.idleVideoTimer) {
    clearTimeout(state.idleVideoTimer);
    state.idleVideoTimer = null;
  }
  if (state.idleAutoSkipTimer) {
    clearTimeout(state.idleAutoSkipTimer);
    state.idleAutoSkipTimer = null;
  }
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.idleCountdownTimer) {
    clearInterval(state.idleCountdownTimer);
    state.idleCountdownTimer = null;
  }
}

function startCountdown(element, ms) {
  if (state.idleCountdownTimer) {
    clearInterval(state.idleCountdownTimer);
    state.idleCountdownTimer = null;
  }
  if (!element) return;
  var end = Date.now() + ms;
  function update() {
    var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    element.textContent = 'skip in ' + left + 's';
    if (left <= 0 && state.idleCountdownTimer) {
      clearInterval(state.idleCountdownTimer);
      state.idleCountdownTimer = null;
    }
  }
  update();
  state.idleCountdownTimer = setInterval(update, 200);
}

function cancelIdleSkip() {
  clearIdleTimers();
  state.idleSkipping = false;
  state.idleTo = 0;
  els.idleOverlay.classList.add('hidden');
  els.idleSkipOverlay.classList.add('hidden');
  try { els.idleVideo.pause(); } catch (error) {}
}

function finishIdleSkip() {
  if (!state.idleSkipping) return;
  var target = state.idleTo;
  var skipped = Math.max(0, target - state.time);
  cancelIdleSkip();
  if (state.current && target > state.time) {
    state.time = target;
    setStatus('Skipped ' + formatDuration(skipped) + ' of idle time', 'ok');
  }
  updateControls();
  if (state.playing) {
    state.lastFrame = 0;
    requestTick();
  }
}

function showIdleSkipOverlay() {
  if (!state.idleSkipping) return;
  state.idleOverlayTimer = null;
  var skipped = Math.max(0, state.idleTo - state.time);
  els.idleSkipText.textContent = 'Skipping ' + formatDuration(skipped)
    + ' of idle time';
  if (els.idleSkipCountdown) els.idleSkipCountdown.textContent = '';
  els.idleSkipOverlay.classList.remove('hidden');

  var autoSkip = Math.max(0,
    Number(state.idleConfig.autoSkipSeconds) || 0) * 1000;
  if (autoSkip > 0) {
    state.idleAutoSkipTimer = setTimeout(finishIdleSkip, autoSkip);
    startCountdown(els.idleSkipCountdown, autoSkip);
  }
}

function playIdleMovie() {
  if (!state.idleSkipping) return;
  state.idleVideoTimer = null;
  if (state.idleCountdownTimer) {
    clearInterval(state.idleCountdownTimer);
    state.idleCountdownTimer = null;
  }
  if (state.idleAutoSkipTimer) {
    clearTimeout(state.idleAutoSkipTimer);
    state.idleAutoSkipTimer = null;
  }
  els.idleSkipOverlay.classList.add('hidden');
  var skipped = Math.max(0, state.idleTo - state.time);
  els.idleText.textContent = 'Skipping ' + formatDuration(skipped)
    + ' of idle time';
  els.idleOverlay.classList.remove('hidden');

  var video = els.idleVideo;
  var source = './' + state.idleConfig.video;
  if (video.getAttribute('src') !== source) {
    video.src = source;
    video.load();
  }
  try { video.currentTime = 0; } catch (error) {}
  video.muted = false;
  var played = video.play();
  if (played && played.catch) {
    played.catch(function() {
      video.muted = true;
      var muted = video.play();
      if (muted && muted.catch) {
        muted.catch(function() { finishIdleSkip(); });
      }
    });
  }
  var movieAutoSkip = Math.max(0,
    Number(state.idleConfig.movieAutoSkipSeconds) || 0) * 1000;
  if (movieAutoSkip > 0) {
    state.idleTimer = setTimeout(finishIdleSkip, movieAutoSkip);
    startCountdown(els.idleCountdown, movieAutoSkip);
  } else {
    if (els.idleCountdown) els.idleCountdown.textContent = '';
    state.idleTimer = setTimeout(finishIdleSkip, 60000);
  }
}

function startIdleSkip(target) {
  state.idleSkipping = true;
  state.idleTo = target;
  els.idleOverlay.classList.add('hidden');
  els.idleSkipOverlay.classList.add('hidden');
  clearIdleTimers();

  var showVideoSeconds = Number(state.idleConfig.showVideoSeconds) || 0;
  if (showVideoSeconds > 0 && target - state.time < showVideoSeconds) {
    var overlayOnlyDelay = Math.max(0,
      (Number(state.idleConfig.overlayDelaySeconds) || 0)) * 1000;
    if (overlayOnlyDelay <= 0) showIdleSkipOverlay();
    else state.idleOverlayTimer = setTimeout(showIdleSkipOverlay,
      overlayOnlyDelay);
    return;
  }

  var videoDelay = Math.max(0,
    Number(state.idleConfig.videoDelaySeconds) || 0) * 1000;
  var overlayDelay = Math.max(0, Math.min(videoDelay,
    (Number(state.idleConfig.overlayDelaySeconds) || 0) * 1000));

  if (videoDelay <= 0) {
    playIdleMovie();
    return;
  }
  if (overlayDelay <= 0) {
    showIdleSkipOverlay();
  } else if (overlayDelay < videoDelay) {
    state.idleOverlayTimer = setTimeout(showIdleSkipOverlay, overlayDelay);
  }
  state.idleVideoTimer = setTimeout(playIdleMovie, videoDelay);
}

function togglePlayback() {
  if (state.playing) {
    pausePlayback();
  } else {
    beginPlayback();
  }
}

function stopSession() {
  stopLive();
  state.streamId++;
  if (state.abort) state.abort.abort();
  cancelIdleSkip();
  state.current = null;
  state.active = false;
  state.playing = false;
  state.live = false;
  state.streamDone = false;
  state.started = false;
  state.autoPlay = false;
  state.start = 0;
  state.end = 0;
  state.time = 0;
  state.queue = [];
  state.queueIndex = 0;
  state.lastEventT = null;
  state.activity = null;
  clearSearch();
  els.searchInput.value = '';
  if (terminal) {
    try { terminal.dispose(); } catch (error) {}
    terminal = null;
  }
  els.terminalHost.innerHTML = '';
  els.empty.classList.remove('hidden');
  setLoading('');
  els.title.textContent = 'Select a session';
  els.meta.textContent = '';
  setHeadTab('');
  els.download.classList.add('hidden');
  els.download.href = '#';
  els.liveView.classList.add('hidden');
  els.liveView.href = '#';
  els.liveShare.classList.add('hidden');
  els.liveShare.href = '#';
  els.time.textContent = '--:-- / --:--';
  els.seek.max = '0';
  els.seek.value = '0';
  drawActivity();
  updateControls();
  renderSessions();
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch (error) {}
  els.layout.classList.remove('sidebar-hidden');
  els.layout.classList.add('browsing');
  els.layout.classList.remove('sidebar-hover');
  els.sidebar.setAttribute('aria-hidden', 'false');
  hoverArmed = true;
  scheduleFit();
  refreshSessionsIfStale();
}

function tick(timestamp) {
  if (!state.playing || state.idleSkipping) return;
  if (!state.lastFrame) state.lastFrame = timestamp;
  var delta = Math.min(1, (timestamp - state.lastFrame) / 1000);
  state.lastFrame = timestamp;
  var target = state.time + delta * state.speed;
  if (state.live) target = liveTarget();

  while (state.queueIndex < state.queue.length
      && state.queue[state.queueIndex].t <= target + 0.000001) {
    var event = state.queue[state.queueIndex++];
    applyEvent(event);
    if (Number.isFinite(event.t)) state.time = Math.max(state.time, event.t);
  }

  state.time = Math.max(state.time, target);

  if (state.queueIndex > 4096 && state.queueIndex * 2 > state.queue.length) {
    state.queue = state.queue.slice(state.queueIndex);
    state.queueIndex = 0;
  }

  var empty = state.queueIndex >= state.queue.length;

  if (!state.live && state.idleConfig.enabled && !state.dragging
      && state.queueIndex < state.queue.length) {
    var nextEvent = state.queue[state.queueIndex];
    if (Number.isFinite(nextEvent.t)
        && nextEvent.t - state.time > state.idleConfig.thresholdSeconds) {
      startIdleSkip(nextEvent.t);
      return;
    }
  }

  if (!state.streamDone && state.active && empty
      && state.time >= state.end - 0.25) {
    state.time = state.end;
    state.live = true;
    anchorLive();
  }

  if (state.streamDone) {
    state.time = Math.min(state.time, state.end);
    if (empty && state.time >= state.end - 0.01) {
      state.time = state.end;
      state.playing = false;
      state.live = false;
      updateControls();
      setStatus('End of session', '');
      return;
    }
  }

  if (state.live) state.time = Math.min(state.time, state.end);

  if (timestamp - state.lastUi > 80) {
    state.lastUi = timestamp;
    updateControls();
  }

  if (state.playing) requestTick();
}

function handleMessage(message, streamId) {
  if (streamId !== state.streamId || !terminal) return;
  if (message.type === 'checkpoint') {
    state.termCols = message.cols || state.termCols;
    state.termRows = message.rows || state.termRows;
    state.lastEventT = message.t;
    terminal.reset();
    resetMouseTracking();
    terminal.resize(state.termCols, state.termRows);
    if (message.serialized) terminal.write(message.serialized);
    terminal.options.title = typeof message.title === 'string'
      ? message.title : '';
    state.activity = message.activity || null;
    requestAnimationFrame(scaleTerminal);
    requestAnimationFrame(drawActivity);
    markLoaded();
    return;
  }
  if (message.type === 'start') {
    state.termCols = message.cols || state.termCols;
    state.termRows = message.rows || state.termRows;
    state.lastEventT = message.t;
    terminal.reset();
    resetMouseTracking();
    terminal.resize(state.termCols, state.termRows);
    state.activity = message.activity || null;
    requestAnimationFrame(scaleTerminal);
    requestAnimationFrame(drawActivity);
    markLoaded();
    return;
  }
  if (message.type === 'end') {
    state.streamDone = true;
    if (Number.isFinite(message.duration)) {
      state.end = Math.max(state.end, state.start + message.duration / 1000);
    }
    if (!state.playing) updateControls();
    return;
  }
  if (message.type === 'renamed') {
    state.active = false;
    state.streamDone = true;
    if (state.current) {
      state.current.active = false;
      updateSessionHeader(state.current);
    }
    setStatus('Session ended and was moved to the archive', '');
    updateControls();
    renderSessions();
    return;
  }
  if (message.type === 'reset') {
    setStatus('Session log was truncated, reloading', 'error');
    resetMouseTracking();
    return;
  }

  var event = {
    t: Number.isFinite(message.t) ? message.t : state.lastEventT,
    d: message.d,
    c: message.c,
    o: message.o
  };
  if (state.idleSkipping && state.live) finishIdleSkip();
  if (Number.isFinite(event.t)) {
    state.lastEventT = event.t;
    state.end = Math.max(state.end, event.t);
  }
  if (!Number.isFinite(event.t)) event.t = state.time;

  // Live streams the file directly like the wslogin pty endpoint: every
  // event that arrives is applied to the terminal right away, no queue,
  // no clock, no speed factor.
  if (event.t <= state.seekTarget + 0.000001 || state.live) {
    applyEvent(event);
    state.time = Math.max(state.time, event.t);
  } else {
    state.queue.push(event);
  }
  markLoaded();
}

async function consumeStream(response, streamId) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  while (true) {
    var result = await reader.read();
    if (streamId !== state.streamId) return;
    if (result.done) break;
    buffer += decoder.decode(result.value, {stream: true});
    var index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      var line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      var message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        continue;
      }
      handleMessage(message, streamId);
    }
  }
  if (buffer.trim()) {
    try {
      handleMessage(JSON.parse(buffer), streamId);
    } catch (error) {}
  }
}

var liveSocket = null;
var liveInputDisposable = null;

function stopLive() {
  if (liveInputDisposable) {
    try { liveInputDisposable.dispose(); } catch (error) {}
    liveInputDisposable = null;
  }
  if (liveSocket) {
    var socket = liveSocket;
    liveSocket = null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch (error) {}
  }
  state.liveMode = null;
  state.liveTarget = null;
  state.liveMeta = null;
}

// Connects to a running wslogin host with a viewonly (view) or shared
// (share) link from the session log header. The view streams the live
// terminal; the share also forwards typed input.
function startLive(mode, id, origin) {
  stopLive();
  cancelIdleSkip();
  state.streamId++;
  if (state.abort) state.abort.abort();
  state.abort = null;
  state.playing = false;
  state.live = false;
  state.current = null;
  state.active = false;
  state.termCols = 80;
  state.termRows = 24;
  if (els.layout.classList.contains('browsing')) setSidebarVisible(false);
  els.layout.classList.remove('browsing');
  els.empty.classList.add('hidden');
  drawActivity();
  newTerminal(80, 24);
  setLoading('Connecting');
  var socket;
  try {
    var base = String(origin).replace(/\/+$/, '');
    var query = (mode === 'share' ? 'share=' : 'view=') + encodeURIComponent(id);
    socket = new WebSocket(base.replace(/^http/, 'ws') + '/pty?' + query);
  } catch (error) {
    setLoading('Invalid live endpoint');
    return;
  }
  liveSocket = socket;
  state.liveMode = mode;
  socket.onmessage = function(ev) {
    var data = String(ev.data);
    var kind = data.charAt(0);
    var body = data.slice(1);
    if (kind === '\x00') {
      var json;
      try { json = JSON.parse(body); } catch (error) { return; }
      if (json.cmd === 'login') {
        socket.send('\x00' + JSON.stringify(mode === 'share'
          ? {cmd: 'share', share: id}
          : {cmd: 'view', view: id}));
      } else if (json.cmd === 'resize') {
        if (terminal && json.cols > 0 && json.rows > 0) {
          state.termCols = json.cols;
          state.termRows = json.rows;
          terminal.resize(json.cols, json.rows);
          scheduleFit();
        }
      } else if (json.cmd === 'b64') {
        if (terminal) terminal.write(atob(json.data));
      } else if (json.cmd === 'replaydone' || json.cmd === 'reconnected') {
        setLoading('');
        markLoaded();
        if (terminal) {
          terminal.focus();
          scheduleFit();
        }
        if (mode === 'share' && terminal && !liveInputDisposable) {
          liveInputDisposable = terminal.onData(function(input) {
            if (liveSocket && liveSocket.readyState === 1) {
              liveSocket.send('\x01' + input);
            }
          });
        }
        setStatus(mode === 'share'
          ? 'Live control, typing sends to the session' : 'Live view', 'ok');
      } else if (json.cmd === 'info' || json.cmd === 'warn') {
        setStatus(json.info || json.warn || '', '');
      } else if (json.cmd === 'error') {
        setLoading(json.error || 'Live session failed');
        setStatus(json.error || 'Live session failed', 'error');
      }
    } else if (kind === '\x01') {
      if (terminal) terminal.write(body);
    } else if (kind === '\x02') {
      applyEvent({c: 3, d: body, t: null});
    }
  };
  socket.onclose = function() {
    if (liveSocket === socket) {
      liveSocket = null;
      state.liveMode = null;
      setLoading('Live connection closed');
      setStatus('Live connection closed', 'error');
    }
  };
  socket.onerror = function() {};
}

function openLiveFromHash() {
  var params = new URLSearchParams(location.hash.slice(1));
  var view = params.get('view');
  var share = params.get('share');
  if (!view && !share) return false;
  var origin = params.get('ws') || location.origin;
  var target = (view ? 'view' : 'share') + ':' + (view || share) + '@' + origin;
  if (state.liveTarget === target) return true;
  startLive(view ? 'view' : 'share', view || share, origin);
  state.liveTarget = target;
  var u = params.get('u');
  var s = params.get('s');
  var h = params.get('h');
  var meta = (state.sessions || []).find(function(item) {
    return item.username === u && item.session === s
      && (!h || !item.hostname || item.hostname === h);
  });
  state.liveMeta = meta || (view
    ? {viewid: view, viewurl: origin + '/#view=' + view}
    : {shareid: share, shareurl: origin + '/#share=' + share});
  updateLiveButtons();
  return true;
}

async function openStream(meta, target, autoplay) {
  stopLive();
  cancelIdleSkip();
  if (els.layout.classList.contains('browsing')) setSidebarVisible(false);
  els.layout.classList.remove('browsing');
  var streamId = ++state.streamId;
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.current = meta;
  state.active = !!meta.active;
  state.start = Number(meta.startdate) || Date.now() / 1000;
  state.end = Math.max(state.start + 0.001,
    Number(meta.enddate) || state.start);
  state.seekTarget = Math.max(state.start,
    Math.min(state.end, Number(target) || state.start));
  state.time = state.seekTarget;
  state.queue = [];
  state.queueIndex = 0;
  state.lastEventT = null;
  state.streamDone = false;
  state.started = false;
  state.autoPlay = autoplay;
  state.playing = false;
  state.live = false;
  state.lastFrame = 0;
  state.matches = [];
  state.matchIndex = -1;
  state.searchQuery = '';
  state.activity = meta.activity || null;
  drawActivity();
  els.searchInput.value = '';
  els.searchCount.textContent = '';
  els.empty.classList.add('hidden');
  setLoading(state.active ? 'Opening live session' : 'Loading session');
  setStatus('', '');
  newTerminal(meta.cols || 80, meta.rows || 24);
  updateSessionHeader(meta);
  updateControls();
  updateHash(meta);
  renderSessions();

  var params = new URLSearchParams();
  params.set('u', meta.username);
  params.set('s', meta.session);
  if (meta.hostname) params.set('h', meta.hostname);
  params.set('from', state.seekTarget.toFixed(3));
  if (state.active) params.set('follow', '1');

  try {
    var response = await fetch(API + '/events?' + params.toString(), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: state.abort.signal
    });
    if (streamId !== state.streamId) return;
    if (response.status === 401) {
      setLoading('');
      setConnection('Authentication required', 'error');
      requireLogin();
      return;
    }
    if (!response.ok) {
      var detail = '';
      try {
        var body = await response.json();
        detail = body.error || '';
      } catch (error) {}
      throw new Error(detail || ('HTTP ' + response.status));
    }
    await consumeStream(response, streamId);
    if (streamId !== state.streamId) return;
    state.streamDone = true;
    if (state.active) {
      state.active = false;
      if (state.current) state.current.active = false;
    }
    updateControls();
    renderSessions();
    if (!state.playing) {
      if (state.autoPlay) {
        state.autoPlay = false;
        beginPlayback();
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    setLoading('');
    setStatus('Playback failed: ' + error.message, 'error');
  }
}

function updateSessionHeader(meta) {
  els.title.textContent = meta.username
    + (meta.hostname ? ' @ ' + meta.hostname : '');
  setHeadTab(els.title.textContent);
  var parts = [];
  parts.push(formatDate(meta.startdate));
  if (Number.isFinite(meta.enddate) && meta.enddate >= meta.startdate) {
    parts.push(formatDuration(meta.enddate - meta.startdate));
  }
  if (meta.size) parts.push(formatBytes(meta.size));
  if (meta.active) parts.push('active');
  els.meta.textContent = parts.join('  |  ');
  els.download.classList.remove('hidden');
  els.download.href = API + '/download?u=' + encodeURIComponent(meta.username)
    + '&s=' + encodeURIComponent(meta.session)
    + (meta.hostname ? '&h=' + encodeURIComponent(meta.hostname) : '');
}

function liveHref(meta, mode) {
  var url = mode === 'view' ? meta.viewurl : meta.shareurl;
  var id = mode === 'view' ? meta.viewid : meta.shareid;
  if (typeof url !== 'string') return null;
  var origin;
  try {
    origin = new URL(url).origin;
  } catch (error) {
    return null;
  }
  if (typeof id !== 'string') return url;
  var hash = '#' + mode + '=' + encodeURIComponent(id)
    + '&ws=' + encodeURIComponent(origin);
  if (typeof meta.username === 'string') {
    hash += '&u=' + encodeURIComponent(meta.username);
  }
  if (typeof meta.session === 'string') {
    hash += '&s=' + encodeURIComponent(meta.session);
  }
  if (typeof meta.hostname === 'string') {
    hash += '&h=' + encodeURIComponent(meta.hostname);
  }
  return location.pathname + location.search + hash;
}

function seekTo(target, autoplay) {
  if (!state.current) return;
  var meta = Object.assign({}, state.current);
  meta.enddate = Math.max(Number(meta.enddate) || 0, state.end);
  if (state.active) meta.active = true;
  pausePlayback();
  openStream(meta, target, !!autoplay);
}

function updateHash(meta) {
  var params = new URLSearchParams();
  params.set('u', meta.username);
  params.set('s', meta.session);
  if (meta.hostname) params.set('h', meta.hostname);
  try {
    history.replaceState(null, '', '#' + params.toString());
  } catch (error) {}
}

function openSession(meta, target, autoplay) {
  if (!meta) return;
  var time = target;
  if (!Number.isFinite(time)) {
    time = meta.active ? (Number(meta.enddate) || meta.startdate)
      : meta.startdate;
  }
  openStream(meta, time, autoplay !== false);
}

async function loadPlaybackConfig() {
  try {
    var response = await fetch(API, {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!response.ok) return;
    var data = await response.json();
    state.idleConfig.enabled = data.idle_skip_enabled === true;
    var threshold = Number(data.idle_skip_seconds);
    if (Number.isFinite(threshold) && threshold > 0) {
      state.idleConfig.thresholdSeconds = threshold;
    } else {
      state.idleConfig.enabled = false;
    }
    if (typeof data.idle_video === 'string' && data.idle_video) {
      state.idleConfig.video = data.idle_video;
    }
    var videoDelay = Number(data.idle_video_delay_seconds);
    if (Number.isFinite(videoDelay) && videoDelay >= 0) {
      state.idleConfig.videoDelaySeconds = videoDelay;
    }
    var overlayDelay = Number(data.idle_overlay_delay_seconds);
    if (Number.isFinite(overlayDelay) && overlayDelay >= 0) {
      state.idleConfig.overlayDelaySeconds = Math.min(
        state.idleConfig.videoDelaySeconds, overlayDelay);
    }
    var autoSkip = Number(data.idle_auto_skip_seconds);
    if (Number.isFinite(autoSkip) && autoSkip >= 0) {
      state.idleConfig.autoSkipSeconds = autoSkip;
    }
    var movieAutoSkip = Number(data.idle_movie_auto_skip_seconds);
    if (Number.isFinite(movieAutoSkip) && movieAutoSkip >= 0) {
      state.idleConfig.movieAutoSkipSeconds = movieAutoSkip;
    }
    var showVideo = Number(data.idle_skip_seconds_show_video);
    if (Number.isFinite(showVideo) && showVideo >= 0) {
      state.idleConfig.showVideoSeconds = showVideo;
    }
  } catch (error) {}
}

async function loadSessions() {
  lastSessionsLoad = Date.now();
  setConnection('Loading', '');
  try {
    var response = await fetch(API + '/sessions', {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (response.status === 401) {
      setConnection('Authentication required', 'error');
      els.listStatus.textContent = 'Signing in';
      requireLogin();
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    setConnection('Connected', 'ok');
    els.listStatus.textContent = state.sessions.length
      + (state.sessions.length === 1 ? ' session' : ' sessions');
    renderSessions();
    openFromHash();
  } catch (error) {
    setConnection('Offline', 'error');
    els.listStatus.textContent = 'Could not load sessions';
    setStatus('Could not load sessions: ' + error.message, 'error');
  }
}

function openFromHash() {
  if (openLiveFromHash()) return;
  if (state.current) return;
  var params = new URLSearchParams(location.hash.slice(1));
  var username = params.get('u');
  var session = params.get('s');
  var hostname = params.get('h');
  if (!username || !session) return;
  var meta = state.sessions.find(function(item) {
    return item.username === username && item.session === session
      && (!hostname || item.hostname === hostname);
  });
  if (!meta) return;
  var time = Number(params.get('t'));
  openSession(meta, Number.isFinite(time) ? time : undefined, true);
}

var thumbTerms = [];
var thumbCache = new Map();
var thumbObserver = null;

if (window.IntersectionObserver) {
  thumbObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target);
    });
  }, {root: els.list, rootMargin: '300px'});
}

function disposeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbTerms.forEach(function(term) {
    try { term.dispose(); } catch (error) {}
  });
  thumbTerms = [];
}

function thumbKey(meta) {
  return (meta.hostname || '') + '/' + meta.username + '/' + meta.session
    + ':' + (meta.size || 0);
}

function scaleShot(shot, term) {
  var cell = null;
  try {
    cell = term._core._renderService.dimensions.css.cell;
  } catch (error) {
    cell = null;
  }
  if (!cell || !cell.width || !cell.height) cell = cellMetrics(11);
  var w = shot.clientWidth;
  var h = shot.clientHeight;
  if (!w || !h) return;
  var scale = Math.min(w / (term.cols * cell.width),
    h / (term.rows * cell.height));
  if (!isFinite(scale) || scale <= 0) return;
  var el = shot.querySelector('.xterm');
  if (el) {
    el.style.transformOrigin = '0 0';
    el.style.transform = 'scale(' + scale + ')';
  }
}

function renderShot(shot, data) {
  var term = new Terminal({
    cols: Math.max(2, data.cols || 80),
    rows: Math.max(2, data.rows || 24),
    allowProposedApi: true,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 1,
    fontFamily: '"Ubuntu Mono", "DejaVu Sans Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 11,
    lineHeight: 1,
    theme: {background: '#090b0e', foreground: '#d8dee8'}
  });
  term.open(shot);
  // The DOM renderer's text at thumbnail scale rasterizes to sub-pixel
  // strokes that read as blank; the canvas renderer scales down legibly.
  if (window.CanvasAddon) {
    try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (error) {}
  }
  thumbTerms.push(term);
  shot.__term = term;
  if (data.serialized) {
    term.write(data.serialized, function() {
      requestAnimationFrame(function() {
        if (shot.isConnected) scaleShot(shot, term);
      });
    });
  }
}

// Lazily fetches the newest checkpoint of a session once its thumbnail slot
// scrolls into view. Results are cached per session content (size keyed).
function loadThumb(shot) {
  var meta = shot.__meta;
  var key = shot.__key;
  var cached = thumbCache.get(key);
  if (cached) {
    if (cached.serialized) renderShot(shot, cached);
    return;
  }
  var params = new URLSearchParams();
  params.set('u', meta.username);
  params.set('s', meta.session);
  if (meta.hostname) params.set('h', meta.hostname);
  fetch(API + '/thumbnail?' + params.toString(), {
    cache: 'no-store',
    credentials: 'same-origin'
  }).then(function(response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function(data) {
    if (!data || shot.__key !== key) return;
    if (thumbCache.size > 50) thumbCache.clear();
    thumbCache.set(key, data);
    if (data.serialized && shot.isConnected) renderShot(shot, data);
  }).catch(function() {});
}

function collapseShots() {
  var expanded = document.querySelectorAll('.session-shot.shot-full');
  if (!expanded.length) return false;
  expanded.forEach(function(shot) {
    shot.classList.remove('shot-full');
    requestAnimationFrame(function() {
      if (shot.__term) scaleShot(shot, shot.__term);
    });
  });
  return true;
}

function createSessionItem(meta) {
  var button = document.createElement('div');
  button.className = 'session-item';
  button.setAttribute('role', 'button');
  button.tabIndex = 0;
  if (state.current && state.current.username === meta.username
      && state.current.session === meta.session) {
    button.classList.add('selected');
  }
  var line = document.createElement('div');
  line.className = 'session-line';
  var dot = document.createElement('span');
  dot.className = 'dot' + (meta.active ? ' active' : '');
  var user = document.createElement('span');
  user.className = 'session-user';
  user.textContent = meta.username;
  var host = document.createElement('span');
  host.className = 'session-host';
  host.textContent = meta.hostname || '';
  line.appendChild(dot);
  line.appendChild(user);
  line.appendChild(host);

  var sub = document.createElement('div');
  sub.className = 'session-sub';
  var date = document.createElement('span');
  date.textContent = formatDate(meta.startdate);
  var duration = document.createElement('span');
  duration.textContent = meta.active ? 'live'
    : (Number.isFinite(meta.duration)
      ? formatDuration(meta.duration / 1000) : '');
  sub.appendChild(date);
  sub.appendChild(duration);

  button.appendChild(line);
  button.appendChild(sub);
  if (meta.description) {
    var desc = document.createElement('div');
    desc.className = 'session-desc';
    desc.textContent = meta.description;
    button.appendChild(desc);
  }
  if (meta.checkpoints > 0 && thumbObserver) {
    var shot = document.createElement('div');
    shot.className = 'session-shot';
    shot.title = 'Click to expand / collapse';
    shot.__meta = meta;
    shot.__key = thumbKey(meta);
    shot.addEventListener('click', function(event) {
      event.stopPropagation();
      shot.classList.toggle('shot-full');
      requestAnimationFrame(function() {
        if (shot.__term) scaleShot(shot, shot.__term);
      });
    });
    button.appendChild(shot);
    thumbObserver.observe(shot);
  }
  button.addEventListener('click', function() {
    setSidebarVisible(false);
    openSession(meta);
  });
  button.addEventListener('keydown', function(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSidebarVisible(false);
      openSession(meta);
    }
  });
  if (meta.active === true && (meta.viewid || meta.viewurl)) {
    var live = document.createElement('div');
    live.className = 'session-live';
    [['view', 'View', meta.viewid || meta.viewurl],
      ['share', 'Control', meta.shareid || meta.shareurl]].forEach(function(item) {
      var href = liveHref(meta, item[0]);
      if (!href) return;
      var link = document.createElement('a');
      link.className = 'live-link';
      link.textContent = item[1];
      link.href = href;
      link.addEventListener('click', function(event) {
        event.stopPropagation();
      });
      live.appendChild(link);
    });
    if (live.childNodes.length > 0) button.appendChild(live);
  }
  return button;
}

function renderSessions() {
  disposeThumbs();
  var query = els.filter.value.trim().toLowerCase();
  var list = state.sessions.filter(function(meta) {
    if (!query) return true;
    return (meta.username + ' ' + meta.session + ' ' + (meta.hostname || '')
      + ' ' + (meta.description || ''))
      .toLowerCase().indexOf(query) >= 0;
  });
  els.list.innerHTML = '';
  var active = list.filter(function(meta) { return meta.active; });
  var finished = list.filter(function(meta) { return !meta.active; });

  function group(title, items) {
    if (!items.length) return;
    var heading = document.createElement('div');
    heading.className = 'session-group-title';
    heading.textContent = title;
    els.list.appendChild(heading);
    items.forEach(function(meta) {
      els.list.appendChild(createSessionItem(meta));
    });
  }

  group('Active', active);
  group('Recent', finished);
  if (!list.length) {
    var empty = document.createElement('div');
    empty.className = 'list-status';
    empty.textContent = state.sessions.length ? 'No matching sessions' : 'No sessions';
    els.list.appendChild(empty);
  }
}

function clearSearch() {
  state.matches = [];
  state.matchIndex = -1;
  state.searchQuery = '';
  els.searchCount.textContent = '';
  if (terminal) terminal.clearSelection();
}

function findMatches(query) {
  if (!terminal || !query) return [];
  var buffer = terminal.buffer.active;
  var matches = [];
  var needle = query.toLowerCase();
  for (var row = 0; row < buffer.length; row++) {
    var line = buffer.getLine(row);
    if (!line) continue;
    var text = line.translateToString(true);
    var haystack = text.toLowerCase();
    var start = 0;
    var index;
    while ((index = haystack.indexOf(needle, start)) >= 0) {
      matches.push({row: row, col: index, length: query.length});
      start = index + Math.max(1, needle.length);
      if (matches.length >= 10000) return matches;
    }
  }
  return matches;
}

function runSearch(reset) {
  var query = els.searchInput.value;
  if (!query) {
    clearSearch();
    return;
  }
  if (reset || query !== state.searchQuery) {
    state.searchQuery = query;
    state.matches = findMatches(query);
    state.matchIndex = state.matches.length ? 0 : -1;
    if (state.matchIndex >= 0) showMatch();
  } else {
    showMatch();
  }
  els.searchCount.textContent = state.matches.length
    ? (state.matchIndex + 1) + '/' + state.matches.length : '0/0';
}

function showMatch() {
  var match = state.matches[state.matchIndex];
  if (!match || !terminal) return;
  terminal.scrollToLine(match.row);
  try {
    terminal.select(match.col, match.row, match.length);
  } catch (error) {}
}

function stepSearch(direction) {
  if (!state.matches.length) {
    runSearch(true);
    return;
  }
  state.matchIndex += direction;
  if (state.matchIndex < 0) state.matchIndex = state.matches.length - 1;
  if (state.matchIndex >= state.matches.length) state.matchIndex = 0;
  showMatch();
  els.searchCount.textContent = (state.matchIndex + 1) + '/'
    + state.matches.length;
}

function stepTime(delta) {
  if (!state.current) return;
  var duration = Math.max(0, state.end - state.start);
  var target = state.time + delta;
  target = Math.max(state.start, Math.min(state.start + duration, target));
  seekTo(target, state.playing);
}

els.idleSkip.addEventListener('click', finishIdleSkip);
els.idleSkipNow.addEventListener('click', finishIdleSkip);
els.idleVideo.addEventListener('ended', finishIdleSkip);
els.idleVideo.addEventListener('error', finishIdleSkip);
els.idleOverlay.addEventListener('click', function(event) {
  if (event.target === els.idleOverlay) finishIdleSkip();
});
els.refresh.addEventListener('click', loadSessions);
els.filter.addEventListener('input', renderSessions);
els.play.addEventListener('click', togglePlayback);
els.stop.addEventListener('click', stopSession);
els.speed.addEventListener('change', function() {
  state.speed = Number(els.speed.value) || 1;
});
els.live.addEventListener('click', function() {
  if (!state.current || !state.active) return;
  seekTo(state.end, true);
});
els.time.addEventListener('click', function() {
  state.timeMode = state.timeMode === 'real' ? 'relative' : 'real';
  try {
    localStorage.setItem('wslogin.timeMode', state.timeMode);
  } catch (error) {}
  updateControls();
});
els.seek.addEventListener('pointerdown', function() {
  state.dragging = true;
});
els.seek.addEventListener('pointerup', function() {
  state.dragging = false;
});
els.seek.addEventListener('input', function() {
  var relative = Number(els.seek.value) || 0;
  updateTimeDisplay(relative);
});
els.seek.addEventListener('change', function() {
  state.dragging = false;
  var relative = Number(els.seek.value) || 0;
  seekTo(state.start + relative, state.playing);
});
els.searchInput.addEventListener('keydown', function(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) {
      if (state.searchQuery === els.searchInput.value) stepSearch(-1);
      else runSearch(true);
    } else {
      if (state.searchQuery !== els.searchInput.value) runSearch(true);
      else stepSearch(1);
    }
  } else if (event.key === 'Escape') {
    els.searchInput.value = '';
    clearSearch();
    els.searchInput.blur();
  }
});
els.searchInput.addEventListener('input', function() {
  if (!els.searchInput.value) clearSearch();
});
els.searchNext.addEventListener('click', function() {
  if (state.searchQuery !== els.searchInput.value) runSearch(true);
  else stepSearch(1);
});
els.searchPrev.addEventListener('click', function() {
  if (state.searchQuery !== els.searchInput.value) runSearch(true);
  else stepSearch(-1);
});

document.addEventListener('keydown', function(event) {
  var tag = document.activeElement && document.activeElement.tagName;
  var typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
    return;
  }
  if (typing) return;
  if (event.key === 'Escape' && collapseShots()) return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepTime(event.shiftKey ? -60 : -10);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepTime(event.shiftKey ? 60 : 10);
  } else if (event.key === 'Home' && state.current) {
    event.preventDefault();
    seekTo(state.start, state.playing);
  } else if (event.key === 'End' && state.current) {
    event.preventDefault();
    seekTo(state.end, state.playing);
  }
});

resizeObserver = new ResizeObserver(scheduleFit);
resizeObserver.observe(els.frame);
new ResizeObserver(function() { drawActivity(); }).observe(els.activity);

updateControls();
openLiveFromHash();
window.addEventListener('hashchange', function() { openLiveFromHash(); });
loadPlaybackConfig().then(loadSessions, loadSessions);
