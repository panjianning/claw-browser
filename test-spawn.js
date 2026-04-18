#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = { ...process.env };
env.AGENT_BROWSER_DAEMON = '1';
env.AGENT_BROWSER_SESSION = 'test-spawn';
env.AGENT_BROWSER_DEBUG = '1';

const daemonScript = path.join(__dirname, 'dist', 'index.js');

console.log(`Spawning: node ${daemonScript}`);
console.log(`Env: AGENT_BROWSER_DAEMON=${env.AGENT_BROWSER_DAEMON}, SESSION=${env.AGENT_BROWSER_SESSION}`);

const child = spawn(process.execPath, [daemonScript], {
  env,
  detached: false,
  stdio: ['ignore', 'inherit', 'inherit'],
});

child.on('exit', (code) => {
  console.log(`Daemon exited with code: ${code}`);
});

setTimeout(() => {
  console.log('Killing daemon...');
  child.kill();
}, 5000);
