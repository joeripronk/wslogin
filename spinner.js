#!/usr/bin/env node
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let i = 0;
const label = process.argv[2] || "Loading...";
const timer = setInterval(() => {
  process.stdout.write(`\r${frames[i++ % frames.length]} ${label} `);
}, 80);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write("\r\x1b[K");
  process.exit(0);
});
