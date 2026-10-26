var viewonly=false;
var shared=false;
var shareid=false;
var viewid=false;
var personalized=false;
var scaling=true;
var snackshowtimeout=false;
var snackhidetimeout=false;
var middle_button_helper= getOS()!='Linux'

window.onhashchange = function () { authenticated=false;location.reload();};
var menudiv=document.getElementById('fullmenu');
function getOS() {
  var userAgent = window.navigator.userAgent,
      platform = window.navigator.platform,
      macosPlatforms = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'],
      windowsPlatforms = ['Win32', 'Win64', 'Windows', 'WinCE'],
      iosPlatforms = ['iPhone', 'iPad', 'iPod'],
      os = null;

  if (macosPlatforms.indexOf(platform) !== -1) {
    os = 'Mac OS';
  } else if (iosPlatforms.indexOf(platform) !== -1) {
    os = 'iOS';
  } else if (windowsPlatforms.indexOf(platform) !== -1) {
    os = 'Windows';
  } else if (/Android/.test(userAgent)) {
    os = 'Android';
  } else if (!os && /Linux/.test(platform)) {
    os = 'Linux';
  }

  return os;
}


function copyToClipboard(text) {
  showsnack("copied "+text+" to the clipboard");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function() { legacyCopy(text); });
    return true;
  }
  return legacyCopy(text);
}
function legacyCopy(text) {
  if (window.clipboardData && window.clipboardData.setData) {
    // IE specific code path to prevent textarea being shown while dialog is visible.
    return clipboardData.setData("Text", text); 

  } else if (document.queryCommandSupported && document.queryCommandSupported("copy")) {
    var textarea = document.createElement("textarea");
    textarea.textContent = text;
    textarea.style.position = "fixed";  // Prevent scrolling to bottom of page in MS Edge.
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");  // Security exception may be thrown by some browsers.
    } catch (ex) {
      console.warn("Copy to clipboard failed.", ex);
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

function updatemenu() {
  text="<ul>";
  //  if (viewid) text+="<li><a href='"+window.location.href+"#view="+viewid+"' target=_new>viewonly link</a></li>";
  //  if (shareid) text+="<li><a href='"+window.location.href+"#share="+shareid+"' target=_new>shared link</a></li>";
  if (viewid) text+="<li><div onclick=\"copyToClipboard('"+ window.location.href+"#view="+viewid+"')\">copy viewonly link</div></li>";
  if (shareid) text+="<li><div onclick=\"copyToClipboard('"+ window.location.href+"#share="+shareid+"')\">copy shared link</div></li>";
  var personalAttr = personalized ? "onclick=\"createPersonalLink('view')\"" : "class=disabled";
  var personalShareAttr = personalized ? "onclick=\"createPersonalLink('share')\"" : "class=disabled";
  if (viewid) text+="<li><div "+personalAttr+">personalized viewonly link</div></li>";
  if (shareid) text+="<li><div "+personalShareAttr+">personalized shared link</div></li>";
  if (viewonly||shared) text+="<li><div onclick=\"toggleScaling()\">"+(scaling?"no scaling":"scale to window")+"</div></li>";
  text+="<li>Close menu</li>";
  text+="</ul>";
  menudiv.innerHTML=text;
  document.getElementById("fullscreen").oncontextmenu = function(e) {showmenu(e)};
}
function clearFormstatus() {
  var formstatus=document.getElementById('formstatus');
  if (formstatus) formstatus.innerHTML="";
}
function showsnack(text) {
  var x = document.getElementById("snackbar");
  x.className = "show";
  x.innerHTML+="<p>"+text+"</p>";
  if (snackshowtimeout) clearTimeout(snackshowtimeout);
  if (snackhidetimeout) clearTimeout(snackhidetimeout);
  snackhidetimeout=false;
  snackshowtimeout=false;
  snackshowtimeout=setTimeout(function(){
    snackshowtimeout=false; x.className = x.className.replace("show", "hide");
    snackhidetimeout=setTimeout(function() {
      snackhidetimeout=false; x.innerHTML="";x.className = x.className.replace("hide", "");
    },1000);


  }, 5000);
}
function fixMobile() {
  const screen = document.getElementsByClassName('xterm-screen');
  if (!screen) return;
  screen[0].setAttribute('contenteditable', 'true');
  screen[0].setAttribute('spellcheck', 'false');
  screen[0].setAttribute('autocorrect', 'off');
  screen[0].setAttribute('autocomplete', 'off');
  screen[0].setAttribute('autocapitalize', 'none');
}
function setViewid(id){
  viewid=id;
  updatemenu();
}
function setShareid(id){
  shareid=id;
  updatemenu();
}
function toggleScaling() {
  scaling=!scaling;
  applyScaling();
  updatemenu();
  showsnack(scaling?"Scaling to window":"Scaling disabled");
}
function applyScaling() {
  if (!term.element) return;
  if (!(viewonly||shared) || !scaling) {
    term.element.style.transform="";
    term.element.style.transformOrigin="";
    return;
  }
  var availw=terminaldiv.clientWidth, availh=terminaldiv.clientHeight;
  var elw=term.element.offsetWidth, elh=term.element.offsetHeight;
  if (!(availw>0)||!(availh>0)||!(elw>0)||!(elh>0)) return;
  var s=Math.min(availw/elw,availh/elh);
  if (!isFinite(s)||s<=0) return;
  term.element.style.transformOrigin="0 0";
  term.element.style.transform="scale("+s+")";
}
function createPersonalLink(mode){
  if (!authenticated || viewonly || shared) return;
  if (!socket || socket.readyState!=1) return;
  var user = prompt("Username for the personalized "+mode+" link:");
  if (user===null) return;
  user = user.trim();
  if (!user) { showsnack("No username given"); return; }
  socket.send('\0' + JSON.stringify({cmd:'grant', grant:mode, user:user}));
}
function showhidemenu() {
  if (menudiv.style.display=="block") {
    menudiv.style.display="none";
  } else {
    menudiv.style.display="block";
  }
}
function showmenu(e) {
  e.preventDefault();
  showhidemenu();
  return false;
}

if (window.location.hash.substr(1,5) == 'view=') {
  viewonly=true;
}
if (window.location.hash.substr(1,6) == 'share=') {
  shared=true;
}
if (viewonly || shared) updatemenu();
var authenticated=false;
var connected = false;
var terminaldiv=document.getElementById('terminal');
window.addEventListener("beforeunload", function(e){
  if (authenticated) {
    e.preventDefault();
    e.returnValue="";
    return ""
  } else {
    delete e['returnValue'];
  }
}, false);
// only support for SSL
var socket=false;
var reconnectToken=false;
try { reconnectToken = sessionStorage.getItem('wslogin.reconnect') || false; } catch(e) {}
var reconnectAttempts=0;
var reconnectTimer=false;
var sessionEnded=false;
const fitAddon = new FitAddon.FitAddon();
//const webglAddon = new WebglAddon.WebglAddon();

//background: '#2D2E2C',
var baseTheme = {
  foreground: '#F8F8F8',
  background: '#2E3436',
  selection: '#5DA5D533',
  black: '#1E1E1D',
  brightBlack: '#262625',
  red: '#CE5C5C',
  brightRed: '#FF7272',
  green: '#5BCC5B',
  brightGreen: '#72FF72',
  yellow: '#CCCC5B',
  brightYellow: '#FFFF72',
  blue: '#5D5DD3',
  brightBlue: '#7279FF',
  magenta: '#BC5ED1',
  brightMagenta: '#E572FF',
  cyan: '#5DA5D5',
  brightCyan: '#72F0FF',
  white: '#F8F8F8',
  brightWhite: '#FFFFFF'
};
// vscode-snazzy https://github.com/Tyriar/vscode-snazzy
var otherTheme = {
  foreground: '#eff0eb',
  background: '#282a36',
  selection: '#97979b33',
  black: '#282a36',
  brightBlack: '#686868',
  red: '#ff5c57',
  brightRed: '#ff5c57',
  green: '#5af78e',
  brightGreen: '#5af78e',
  yellow: '#f3f99d',
  brightYellow: '#f3f99d',
  blue: '#57c7ff',
  brightBlue: '#57c7ff',
  magenta: '#ff6ac1',
  brightMagenta: '#ff6ac1',
  cyan: '#9aedfe',
  brightCyan: '#9aedfe',
  white: '#f1f1f0',
  brightWhite: '#eff0eb'
};
var isBaseTheme = true;

var term = new window.Terminal({
  theme: baseTheme,
  cursorBlink: true,
  scrollback: 2000,
  convertEol: false,
  allowProposedFeatures: true,
  fontFamily: '"Ubuntu Mono", "DejaVu Sans Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14
});
term.onTitleChange(function (title) {
  document.title = title;
})
term.onData(function (data) {
  if (!viewonly && socket && socket.readyState==1) socket.send('\1'+data);
})
//terminaldiv.addEventListener(
window.addEventListener(
  'mouseup',
  (e) => {
    if (e.which==1 && (middle_button_helper || e.shiftKey)) {
      if (term.hasSelection() && term.getSelection().length>1) {
        copyToClipboard(term.getSelection());
        term.focus();
        return false;
      }
    }
    if (e.which==2 && authenticated && middle_button_helper && socket && socket.readyState==1) {
      navigator.clipboard.readText().then(text => {
        showsnack("Pasted:<div align=left><pre>"+text+"</pre></div>");
        if (socket && socket.readyState==1) socket.send('\1'+text.replaceAll("\r\n","\r").replaceAll("\n","\r"));
        return false;
      })
    }
    return true;
  },
  false,
);
var resizewait=false;
var resizepending=false;
var fitTimer=false;
var loginform = document.getElementById('loginform');
term.open(document.getElementById('terminal'));
//      term.loadAddon(attachAddon); 
term.loadAddon(fitAddon);
// The DOM renderer lays out glyphs in CSS line boxes, whose leading shows
// up as small gaps between rows. The canvas renderer draws glyphs at exact
// row positions and is seamless in all browsers.
if (window.CanvasAddon) {
  try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (e) {}
}
var lastMouseSent={x:-1,y:-1,t:0};
var dragStart=false;
function dragText(a,b) {
  var buf=term.buffer.active;
  var y1=Math.min(a.y,b.y), y2=Math.max(a.y,b.y);
  var x1=Math.min(a.x,b.x), x2=Math.max(a.x,b.x);
  var out=[];
  for (var y=y1; y<=y2; y++) {
    var line=buf.getLine(buf.baseY+y-1);
    if (!line) continue;
    out.push(line.translateToString(true).slice(x1-1,x2));
  }
  return out.join('\n').replace(/\s+$/,'');
}
function mouseCell(e) {
  if (!term.element) return null;
  var screen=term.element.querySelector('.xterm-screen');
  if (!screen) return null;
  var rect=screen.getBoundingClientRect();
  if (rect.width<=0||rect.height<=0) return null;
  var col=Math.floor((e.clientX-rect.left)*term.cols/rect.width);
  var row=Math.floor((e.clientY-rect.top)*term.rows/rect.height);
  if (col<0||row<0||col>=term.cols||row>=term.rows) return null;
  return {x:col+1,y:row+1};
}
function sendMouse(e,b) {
  if (!authenticated||viewonly||shared) return;
  if (!socket||socket.readyState!=1) return;
  // shift bypasses app mouse capture: let xterm.js select locally and the
  // mouseup handler copies the selection, like in a plain shell
  if (e.shiftKey) return;
  var cell=mouseCell(e);
  if (b==1 && e.button==0) dragStart=cell||false;
  if (b==2 && e.button==0 && dragStart) {
    var start=dragStart;
    dragStart=false;
    if (cell && (cell.x!=start.x || cell.y!=start.y)) {
      var t=dragText(start,cell);
      if (t.length>0) { copyToClipboard(t); term.clearSelection(); }
    }
  }
  if (!cell) return;
  var now=Date.now();
  if (b==0) {
    if (cell.x==lastMouseSent.x&&cell.y==lastMouseSent.y) return;
    if (now-lastMouseSent.t<40) return;
  }
  lastMouseSent={x:cell.x,y:cell.y,t:now};
  socket.send('\2'+JSON.stringify({x:cell.x,y:cell.y,b:b,k:b==1?e.button:0}));
}
terminaldiv.addEventListener('mousemove',function(e){sendMouse(e,0);});
terminaldiv.addEventListener('mousedown',function(e){sendMouse(e,1);});
window.addEventListener('mouseup',function(e){sendMouse(e,2);},true);
//        term.loadAddon(webglAddon); 
function resizeScreen () {
  if (terminaldiv.style.display=="none") return;
  if (viewonly || shared) {
    // Viewonly and shared clients mirror the size of the session they
    // watch. They must not resize the pty (that would garble the screen
    // of the owner) and must not resize the local terminal (that would
    // garble their own screen). They scale the rendered grid to fit
    // the window instead (see applyScaling / the menu toggle).
    applyScaling();
    return;
  }
  var dims=fitAddon.proposeDimensions();
  if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) {
    setTimeout(function() { resizeScreen(); },200);
    return;
  }
  if (authenticated) {
    if (term.cols==dims.cols && term.rows==dims.rows) return;
    // Do not resize the local terminal here. The pty is still at the old
    // size until the server confirms, and rendering its output in a
    // differently sized terminal garbles the screen. The server echoes the
    // resize back (see the 'resize' case below), which keeps both in sync.
    if (resizewait) { 
      resizepending=true; 
    } else {
      if (socket && socket.readyState==1) socket.send('\0{"cmd":"resize","cols":' +  dims.cols + ',"rows":' + dims.rows + '}');
      resizewait=setTimeout(function() { resizewait=false;if (resizepending) { resizepending=false; resizeScreen(); } },150);
    }
  } else {
    fitAddon.fit();
  }
}
function scheduleResize () {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer=setTimeout(function() { fitTimer=false; resizeScreen(); },80);
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function() {
    // The webfont changes the cell size, so refit once it is loaded.
    requestAnimationFrame(function() {
      requestAnimationFrame(resizeScreen);
    });
  });
}
document.addEventListener('fullscreenchange',scheduleResize,false);
document.addEventListener('webkitfullscreenchange',scheduleResize,false);

function setReconnectToken(token) {
  reconnectToken = token || false;
  try {
    if (reconnectToken) sessionStorage.setItem('wslogin.reconnect', reconnectToken);
    else sessionStorage.removeItem('wslogin.reconnect');
  } catch(e) {}
}
var loginform = document.getElementById('loginform');
var loginMounted = false;
function wsloginSubmit(username, password, remember) {
  terminaldiv.style.display="block";
  resizeScreen();
  terminaldiv.style.display="none";
  if (!socket || socket.readyState!=1) return false;
  cmd={cmd:'login',username:username,password:password,rememberme:remember,cols:term.cols,rows:term.rows}
  socket.send('\0' + JSON.stringify(cmd));
  return true;
}
function showLoginForm() {
  terminaldiv.style.display="none";
  loginform.style.display="block";
  if (!loginMounted) {
    LoginForm.mount(loginform, wsloginSubmit);
    loginMounted = true;
  }
  LoginForm.status("please login");
  LoginForm.focus();
}
var pickerdiv=document.getElementById('picker');
var pickerTerms=[];
function hidePicker() {
  for (var i = 0; i < pickerTerms.length; i++) {
    try { pickerTerms[i].dispose(); } catch (e) {}
  }
  pickerTerms = [];
  pickerdiv.innerHTML = '';
  pickerdiv.style.display = 'none';
}
function showSessionPicker(list) {
  hidePicker();
  terminaldiv.style.display="none";
  loginform.style.display="none";
  pickerdiv.style.display="block";
  var head=document.createElement('div');
  head.className='picker-head';
  head.innerHTML='Reconnect to a running terminal, or start a new one.';
  pickerdiv.appendChild(head);
  var grid=document.createElement('div');
  grid.className='picker-grid';
  pickerdiv.appendChild(grid);
  (list || []).forEach(function(item) {
    var card=document.createElement('div');
    card.className='picker-card';
    var shot=document.createElement('div');
    shot.className='picker-shot';
    shot.title='Click to expand / collapse';
    card.appendChild(shot);
    var thumb=new window.Terminal({
      cols: item.cols || 80,
      rows: item.rows || 24,
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 1,
      fontSize: 11,
      theme: { background: '#0b1220' }
    });
    thumb.open(shot);
    pickerTerms.push(thumb);
    if (item.snapshot) thumb.write(item.snapshot);
    scaleThumb(shot, thumb);
    shot.onclick=function() { toggleFullCard(card, shot, thumb); };
    var label=document.createElement('div');
    label.className='picker-label';
    label.textContent=(item.title || 'terminal')+'  ('+thumb.cols+'x'+thumb.rows+')';
    card.appendChild(label);
    var btn=document.createElement('button');
    btn.className='picker-connect';
    btn.textContent='Connect';
    btn.onclick=function() { pickSession(item.reconnectid); };
    card.appendChild(btn);
    grid.appendChild(card);
  });
  var newbtn=document.createElement('button');
  newbtn.className='picker-new';
  newbtn.textContent='Start a new session';
  newbtn.onclick=function() { startNewSession(); };
  pickerdiv.appendChild(newbtn);
}
function scaleThumb(shot, thumb) {
  var cell=measureCell(shot, thumb);
  if (!cell || !cell.width || !cell.height) return;
  var w=shot.clientWidth || 240, h=shot.clientHeight || 140;
  var scale=Math.min(w/(thumb.cols*cell.width), h/(thumb.rows*cell.height));
  if (!isFinite(scale) || scale<=0) return;
  var el=shot.querySelector('.xterm');
  if (el) el.style.transform='scale('+scale+')';
}
// Click a thumbnail: expand it to fill the screen, click again to collapse.
function toggleFullCard(card, shot, thumb) {
  var full=card.classList.toggle('picker-full');
  var grid=card.parentNode;
  if (full && grid) grid.classList.add('picker-zoomed');
  if (!full && grid) grid.classList.remove('picker-zoomed');
  // Let the layout settle before measuring the (new) shot size.
  requestAnimationFrame(function() { scaleThumb(shot, thumb); });
}
function measureCell(shot, thumb) {
  var probe=document.createElement('span');
  probe.style.visibility='hidden';
  probe.textContent='W';
  shot.appendChild(probe);
  var cs=window.getComputedStyle(shot);
  var cell={width: probe.offsetWidth, height: parseFloat(cs.lineHeight)||16};
  shot.removeChild(probe);
  return cell;
}
function pickSession(reconnectid) {
  if (socket && socket.readyState==1) {
    socket.send('\0' + JSON.stringify({cmd:'pick', reconnect:reconnectid,
      cols:term.cols, rows:term.rows}));
  }
  hidePicker();
}
function startNewSession() {
  if (socket && socket.readyState==1) {
    socket.send('\0' + JSON.stringify({cmd:'newsess', cols:term.cols, rows:term.rows}));
  }
  hidePicker();
}
function shouldReconnect() {
  return !sessionEnded && (viewonly || shared || authenticated || !!reconnectToken);
}
function scheduleReconnect() {
  if (!shouldReconnect()) return false;
  if (reconnectTimer) return true;
  var delay=Math.min(30000, 1000*Math.pow(2, reconnectAttempts));
  if (reconnectAttempts==0) showsnack("Connection lost, reconnecting...");
  reconnectAttempts++;
  reconnectTimer=setTimeout(function() {
    reconnectTimer=false;
    connect();
  }, delay);
  return true;
}
function onclose(connection) {
  if(connected) {
    //  console.log('connection closed');
    term.write("\r\nConnection closed         \r\n");
    connected=false;
    authenticated=false;
    loginform.style.display="none";
  } else if (!reconnectTimer && reconnectAttempts==0 && !shouldReconnect()) {
    term.write("\rConnection failed\r\n");
    showsnack("Failed to connect");
    loginform.style.display="none";
  }
  if (!viewonly) {
    var rel = document.getElementById("reload");
    rel.style.display="block";
    //  resizeScreen();
  }
  scheduleReconnect();
}
function onopen(connection) {
  connected=true;
  //console.log('connection opened');
  resizeScreen();
  // Report our window size right away. On sso auto-login the server
  // spawns the pty as soon as pam verification finishes, and this
  // command usually arrives first, so the pty starts at the right size.
  if (socket && socket.readyState==1) socket.send('\0' + JSON.stringify({cmd:'size',cols:term.cols,rows:term.rows}));
  window.addEventListener('resize', scheduleResize, false);
}
function connect() {
  if (socket && (socket.readyState==0 || socket.readyState==1)) return;
  var proto = window.location.protocol == 'https:' ? 'wss://' : 'ws://';
  var live = viewonly ? '?view=' + window.location.hash.substr(6)
           : (shared ? '?share=' + window.location.hash.substr(7) : '');
  socket = new WebSocket(proto + window.location.host + window.location.pathname + 'pty' + live);
  socket.onopen=onopen;
  socket.onclose=onclose;
  socket.onerror=function(){};
  socket.onmessage=onmessage;
}
function onmessage(message) {
  var data=message.data.substr(1);
  switch (message.data[0]) {
    case '\0':
      var json = JSON.parse(data);
      switch(json.cmd) {
        case 'b64':
          // non utf8: write the raw bytes, not a latin1 string that xterm
          // would re-encode as utf8
          var bin=atob(json.data);
          var bytes=new Uint8Array(bin.length);
          for (var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
          term.write(bytes);
          break;;
        case 'resize':
          if (term.cols!=json.cols || term.rows!=json.rows) {
            term.resize(json.cols,json.rows);
            term.refresh(0,term.rows-1);
            scheduleResize();
          }
          break;;
        case 'cookie':
          document.cookie=json.cookie;
          break;;
        case 'login':
          if (viewonly) {
            if(connected) socket.send('\0{"cmd":"view","view":"' +  window.location.hash.substr(6) + '"}');
          } else if (shared) {
            if(connected) socket.send('\0{"cmd":"share","share":"' +  window.location.hash.substr(7) + '"}');
          } else if (reconnectToken) {
            if(connected) socket.send('\0' + JSON.stringify({cmd:'reconnect',reconnect:reconnectToken,cols:term.cols,rows:term.rows}));
          } else {
            showLoginForm();
          }
          break;;
        case 'reconnectfailed':
          setReconnectToken(false);
          showLoginForm();
          var formstatus=document.getElementById('formstatus');
          formstatus.innerHTML="<font color=red>Your session has expired, please login again</font>";
          break;;
        case 'sessions':
          // On a page refresh the tab already carries its own session in
          // sessionStorage and reconnects to it; ignore the sso picker then.
          if (sessionStorage.getItem('wsSession')) break;
          showSessionPicker(json.list);
          break;;
        case 'authfailed':
          terminaldiv.style.display="none";
          loginform.style.display="block";
          var formstatus=document.getElementById('formstatus');
          formstatus.innerHTML="<font color=red>Authentication failed</font>";
          break;;
        case 'replaydone':
          sessionEnded=false;
          reconnectAttempts=0;
          if (!viewonly) authenticated=true;
          document.getElementById("reload").style.display="none";
          terminaldiv.style.display="block";
          clearFormstatus();
          loginform.style.display="none";
          term.focus();
          setTimeout(function () {term.scrollToBottom();},200);
          if (viewonly||shared) applyScaling();
          break;;
        case 'reconnected':
          sessionEnded=false;
          reconnectAttempts=0;
          authenticated=true;
          if ('reconnect' in json) setReconnectToken(json.reconnect);
          personalized = json.personalized === true;
          if ('viewid' in json) setViewid(json.viewid);
          if ('shareid' in json) setShareid(json.shareid);
          document.getElementById("reload").style.display="none";
          terminaldiv.style.display="block";
          clearFormstatus();
          loginform.style.display="none";
          terminaldiv.style.display="block";
          term.refresh(0,term.rows-1);
          term.focus();
          setTimeout(function () {term.scrollToBottom();},200);
          resizeScreen();
          break;;
        case 'authenticated':
          sessionEnded=false;
          reconnectAttempts=0;
          authenticated=true;
          if ('reconnect' in json) setReconnectToken(json.reconnect);
          personalized = json.personalized === true;
          if ('viewid' in json) setViewid(json.viewid);
          if ('shareid' in json) setShareid(json.shareid);
          document.getElementById("reload").style.display="none";
          terminaldiv.style.display="block";
          term.reset();
          // term.reset() resets the renderer's measured cell size to the
          // default geometry, which would make the next fit propose
          // wrong dimensions; force it to remeasure for the current size.
          term.resize(term.cols, term.rows);
          term.refresh(0,term.rows-1);
          clearFormstatus();
          loginform.style.display="none";
          term.focus();
          resizeScreen();
          break;;
        case "warn":
          showsnack(json.warn);
          break;;
        case "info":
          if (/session ended/i.test(json.info)) {
            sessionEnded=true;
            setReconnectToken(false);
          }
          showsnack(json.info);
          break;;
        case "error":
          showsnack(json.error);
          break;;
        case 'grantlink':
          copyToClipboard(json.url);
          showsnack("Personalized "+json.mode+" link copied to clipboard");
          break;;
        default: alert(data);
      }
      break;;
    case '\1':
      term.write(data);
      break;;
    case '\2':
      // mouse pointer report from another client, ignored on this page
      break;;
    default:
      alert(message.data);
  }
};
function goFullScreen(){

  var elem = document.getElementById('terminal');

  if(elem.requestFullscreen){
    elem.requestFullscreen();
  }
  else if(elem.mozRequestFullScreen){
    elem.mozRequestFullScreen();
  }
  else if(elem.webkitRequestFullscreen){
    elem.webkitRequestFullscreen();
  }
  else if(elem.msRequestFullscreen){
    elem.msRequestFullscreen();
  }
}
connect();
