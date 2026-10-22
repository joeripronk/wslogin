process.title = 'wslogin';

var webSocketServer = require('websocket').server;
//const isValidUTF8 = require('utf-8-validate');
const http = require('http');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const pty = require('node-pty');
const { Terminal } =  require ("@xterm/headless");
//const { Terminal } =  require ("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { v4: uuid_v4 } = require('uuid');
const userid = require('userid');
var pam = require('authenticate-pam');
function now() {
  return Date.now()/1000;
  //var hrTime = process.hrtime()
  //return (hrTime[0] * 1000000) + (hrTime[1] / 1000)
}

var ini = require('ini');
var config = ini.parse(fs.readFileSync('/etc/wslogin/config.ini', 'utf-8',true));
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

console.log(JSON.stringify(config));
var shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

const webSocketsServerPort = 9022;
var clients = [ ];
var logins = {};
var sessions = {};
var views = {};
var shares = {};
var reconnects = {};
var wwwdir = "www"; 

function write(fd,d) {
  return fs.write(fd,d,function (err) {
    if (err) console.error("error: " + err.message);
  });
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
    saving: false
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
  if (!mirror || mirror.busy || mirror.saving || !checkpoint_due(session)) return;
  save_checkpoint(session);
}

function save_checkpoint(session) {
  var mirror=session.mirror;
  if (!session.pty || !session.pty.file || !session.checkpoint_path) return;
  var offset=mirror.offset;
  try {
    if (fs.fstatSync(session.pty.file).size < offset) {
      return;
    }
  } catch (error) {
    return;
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

/**
 * HTTP server
 */
var server = http.createServer(function(request, response) {
  // Not important for us. We're writing WebSocket server,
  // not HTTP server    

  let path = request.url.substring(1);
  if(path == '') {
    path = 'index.html';
  }
  var localpath = wwwdir + '/' + path;
  if(fs.existsSync(localpath)) {
    console.log("serving " + localpath);
    if(path.indexOf('.js') === path.length-3) {
      response.setHeader('Content-Type', 'application/javascript');
    }
    response.end(fs.readFileSync(localpath));
  } else {
    response.statusCode = 404;
    response.end('');
  }
});

server.listen(webSocketsServerPort, function() {
  console.log("Server is listening on port "
    + webSocketsServerPort + ".");
});

/**
 * WebSocket server
 */
var wsServer = new webSocketServer({
  // WebSocket server is tied to a HTTP server. WebSocket
  // request is just an enhanced HTTP request. For more info 
  // http://tools.ietf.org/html/rfc6455#page-6
  httpServer: server,
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
  var xff=request;
  //	['x-forwarded-for'];

  console.log('Connection['+ remote+'] from origin '
    + request.origin );


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
  // we need to know client index to remove them on 'close' event
  connection.write = connection.send;
  connection.read = connection.socket.read;
  var cmd={cmd:"login"};
  connection.sendUTF('\0' + JSON.stringify(cmd));
  /*
    if (uuidcookie==undefined) {
      uuidcookie=uuid_v4();
      var cmd={cmd:"cookie",cookie:'uuid='+uuidcookie};
      connection.sendUTF('\0' + JSON.stringify(cmd));
    }
    */
  async function replay_pty(username,sessioncookie,cols,rows,connection) {
    console.log("reconnected to "+sessioncookie+" "+sessions[username][sessioncookie].pty.file);
    var checkpointfile=checkpoint_enabled ? 'sessions/'+username+'/'+sessioncookie+'.checkpoint.json' : null;
    var serial = await create_replayed_terminal('sessions/'+username+'/'+sessioncookie+'.json', checkpointfile);
    connection.sendUTF('\0'+JSON.stringify({cmd:"resize",cols:serial.cols,rows:serial.rows}));
    connection.sendUTF('\1'+serial.s);
    console.log("sending replayed terminal");
    console.log("done sending replay for "+sessioncookie);
    if (connection.shared || connection.viewonly) {
      var cmd={cmd:"replaydone"};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log("send replaydone to "+sessioncookie);
    } else {
      var cmd={cmd:"reconnected",viewid:sessions[username][sessioncookie].viewid,shareid:sessions[username][sessioncookie].shareid,reconnect:sessions[username][sessioncookie].reconnectid};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log("send reconnected to "+sessioncookie);
      // force a redrwa, to fix term properties at cursor for tmux and others
      // currently terminal properties of the last drawn character are active
      // e.g. the green bar of tmux
      if (rows>1 && cols >1 && (serial.cols!=cols || serial.rows != serial.rows)) {
        console.log("resizing reconnected to "+sessioncookie+' to '+cols+'x'+rows);
        sessions[username][sessioncookie].pty.resize(cols,rows);
      } else {
        sessions[username][sessioncookie].pty.resize(serial.cols+1,serial.rows);
        console.log("resizing "+sessioncookie+' to '+(serial.cols+1)+'x'+(serial.rows+1));
        setTimeout(function() {
             sessions[username][sessioncookie].pty.resize(serial.cols, serial.rows);
             console.log("resizing back to "+sessioncookie+' to '+(serial.cols)+'x'+(serial.rows));
          }, 30);
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
    if (!forceNew && ( username in sessions)) {
      var list='sessioncookies:\r\n';
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
        if(requested || (!connection.viewonly && !connection.shared && !mainconnection)) {
          sessioncookie=key;
          connection.paused=true;
          if(connection.viewonly) {
            console.log("view started for "+username+" "+sessioncookie);
            sendInfo(sessions[username][sessioncookie].pty.main,"someone is viewing your session");

          } else if(connection.shared) {
            console.log("sharing started for "+username+" "+sessioncookie);
            sendInfo(sessions[username][sessioncookie].pty.main,"someone is sharing your session");
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
      session.checkpoint_path='sessions/'+username+'/'+sessioncookie+'.checkpoint.json';
      session.mirror=create_mirror(connection.columns, connection.rows);
      fs.mkdirSync('sessions/'+username, { recursive: true });
      //file = fs.createWriteStream('sessions/'+username+'/'+sessioncookie+'.json', { flags: 'a' });
      sessions[username][sessioncookie].pty = pty.spawn('sudo', ['-u',username,'-i'], {
        name: 'xterm',
        cols: connection.columns,
        rows: connection.rows,
        cwd: '/',
        env: { USER: username,VIEWID: viewid,VIEWURL: request.origin+'/#view='+viewid,SUDO_USER: username }
      });
      sessions[username][sessioncookie].pty.file = fopen('sessions/'+username+'/'+sessioncookie+'.json', 'a+');
      /*        sessions[username][sessioncookie].pty.sessioncookie=sessioncookie;
        sessions[username][sessioncookie].pty.username=username;
        */
      sessions[username][sessioncookie].pty.main=connection;
      views[viewid]={sessioncookie:sessioncookie,username:username}
      shares[shareid]={sessioncookie:sessioncookie,username:username}
      console.log("created pty "+sessioncookie+" "+connection.columns+"x"+connection.rows+" for "+index);
      cmd={"cmd":"resize","cols":connection.columns,"rows":connection.rows}
      log={t:now(),d:JSON.stringify(cmd),c:0}
      var written=append_session_log(session,log);
      queue_mirror(session,{type:'resize',cols:connection.columns,rows:connection.rows,offset:written.offset,bytes:written.bytes});
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
      var cmd={cmd:"authenticated",viewid:sessions[username][sessioncookie].viewid,shareid:sessions[username][sessioncookie].shareid,reconnect:sessions[username][sessioncookie].reconnectid};
      connection.sendUTF('\0' + JSON.stringify(cmd));
      console.log(username + " authenticated!");
    }
    sessions[username][sessioncookie]['connections'][index]=connection;
    console.log("returning cookie "+sessioncookie+" file "+sessions[username][sessioncookie].pty.file);
    return sessioncookie;

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
                if (m.view in views) {
                  connection.viewonly=true;
                  connection.username=views[m.view].username;
                  connection.sessioncookie=views[m.view].sessioncookie;
                  console.log("view "+m.view+" started for "+connection.username+" "+connection.sessioncookie);
                  create_pty(views[m.view].username,views[m.view].sessioncookie,connection);
                } else {
                  sendError(connection,"Your view url has expired");
                  console.log("View "+m.viewid+" does not exist (anymore)");
                }
                break;;

              case 'share':
                if (m.share in shares) {
                  connection.shared=true;
                  connection.username=shares[m.share].username;
                  connection.sessioncookie=shares[m.share].sessioncookie;
                  console.log("share started for "+connection.username+" "+connection.sessioncookie);
                  create_pty(shares[m.share].username,shares[m.share].sessioncookie,false,false,connection);
                } else {
                  sendError(connection,"Your share url has expired");
                  console.log("Share "+m.share+" does not exist (anymore)");
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
                      sendError(connection,"Your session has expired");
                      connection.sendUTF('\0' + JSON.stringify({cmd:"reconnectfailed"}));
                    }
                  } else {
                    sendError(connection,"Your session has expired");
                    connection.sendUTF('\0' + JSON.stringify({cmd:"reconnectfailed"}));
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
                    }, {serviceName: 'sshd', remoteHost: remote});
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

