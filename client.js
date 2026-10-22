#!/usr/bin/env node
const {WebSocket} = require('ws');
const { v4: uuid_v4 } = require('uuid');
const fs = require('fs');

const ws = new WebSocket('ws://127.0.0.1:9022/');
var ini = require('ini');
var config = ini.parse(fs.readFileSync('/etc/wslogin/config.ini', 'utf-8',true));
if (! 'cookie_dir' in config) {
  console.log("local sessions are disabled");
  process.exit();
}

ws.on('open', function open() {
});

ws.on('message', function incoming(message) {
  msg=message.toString()
  switch(msg[0]) {
    case '\0':
      json=JSON.parse(msg.substr(1))
      const uuid=uuid_v4();
      fs.writeFileSync(config.cookie_dir+"/cookie_"+uuid+".json",JSON.stringify(process.env))
      switch(json.cmd) {
        case 'login':
          ws.send('\0'+JSON.stringify({cmd:'login',cookie:uuid,cols:process.stdout.columns,rows:process.stdout.rows}))
          break;;
        case 'reconnected':
          ws.send('\0'+JSON.stringify({cmd:'resize',cols:process.stdout.columns,rows:process.stdout.rows}))
          break;;
      }
      break;;
    case '\1': process.stdout.write(msg.substr(1)); 
  }
});
ws.on('close', function() { process.exit(); })
var stdin = process.stdin;

// without this, we would only get streams once enter is pressed
stdin.setRawMode( true );

// resume stdin in the parent process (node app won't quit all by itself
// unless an error or process.exit() happens)
stdin.resume();

// i don't want binary, do you?
stdin.setEncoding( 'utf8' );

// on any data into stdin
stdin.on( 'data', function( key ){
  // ctrl-c ( end of text )
 // if ( key === '\u0003' ) {
  //  process.exit();
 // }
  ws.send('\1'+key);
});
process.stdout.on("resize",function () {
  ws.send('\0'+JSON.stringify({cmd:'resize',cols:process.stdout.columns,rows:process.stdout.rows}))
})
  
