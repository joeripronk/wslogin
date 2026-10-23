var viewonly=false;
var shared=false;
var shareid=false;
var viewid=false;
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
  text+="<li>Close menu</li>";
  text+="</ul>";
  menudiv.innerHTML=text;
  document.getElementById("fullscreen").oncontextmenu = function(e) {showmenu(e)};
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
var authenticated=false;
var options = {
  scrollback: 10000,
  cursorBlink: true,
  fontSize: 14,
  lineHeight: 1,
  theme: {
    background: '#2d0922',
    foreground: '#fbf9f4'
  },
  convertEol: false
};
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
  scrollback: 10000,
  convertEol: false,
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
    if (e.which==1 && middle_button_helper) {
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
//        term.loadAddon(webglAddon); 
function resizeScreen () {
  if (terminaldiv.style.display=="none") return;
  if (viewonly || shared) {
    // Viewonly and shared clients mirror the size of the session they
    // watch. They must not resize the pty (that would garble the screen
    // of the owner) and must not resize the local terminal (that would
    // garble their own screen).
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
function showLoginForm() {
  var formstatus=document.getElementById('formstatus');
  var usernameinput=document.getElementById('username');
  terminaldiv.style.display="none";
  formstatus.innerHTML="please login";
  loginform.style.display="block";
  usernameinput.focus();
  loginform.onsubmit=function (event) {
    event.preventDefault();
    // TODO: properly disable double submit
    //  loginform.onsubmit=function (event) { event.preventDefault(); return false; };
    var username=document.getElementById('username');
    var password=document.getElementById('password');
    terminaldiv.style.display="block";
    resizeScreen();
    terminaldiv.style.display="none";
    if (!socket || socket.readyState!=1) return false;
    cmd={cmd:'login',username:username.value,password:password.value,rememberme:rememberme.value,cols:term.cols,rows:term.rows}
    socket.send('\0' + JSON.stringify(cmd));
    var formstatus=document.getElementById('formstatus');
    formstatus.innerHTML="Authenticating";
    return false;
  };
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
  window.addEventListener('resize', scheduleResize, false);
}
function connect() {
  if (socket && (socket.readyState==0 || socket.readyState==1)) return;
  if (window.location.protocol == 'https:') {
    socket = new WebSocket('wss://'+window.location.host+window.location.pathname+'pty');
  } else {
    socket = new WebSocket('ws://'+window.location.host+window.location.pathname+'pty');
  }
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
          // non utf 
          term.write(atob(json.data));
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
          var formstatus=document.getElementById('formstatus');
          formstatus.innerHTML="";
          loginform.style.display="none";
          term.focus();
          setTimeout(function () {term.scrollToBottom();},200);
          break;;
        case 'reconnected':
          sessionEnded=false;
          reconnectAttempts=0;
          authenticated=true;
          if ('reconnect' in json) setReconnectToken(json.reconnect);
          if ('viewid' in json) setViewid(json.viewid);
          if ('shareid' in json) setShareid(json.shareid);
          document.getElementById("reload").style.display="none";
          terminaldiv.style.display="block";
          var formstatus=document.getElementById('formstatus');
          formstatus.innerHTML="";
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
          if ('viewid' in json) setViewid(json.viewid);
          if ('shareid' in json) setShareid(json.shareid);
          document.getElementById("reload").style.display="none";
          terminaldiv.style.display="block";
          term.reset();
          term.refresh(0,term.rows-1);
          var formstatus=document.getElementById('formstatus');
          formstatus.innerHTML="";
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
        default: alert(data);
      }
      break;;
    case '\1':
      term.write(data);
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
