#!/usr/bin/env node

// Simple CDP connection test
import net from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const session = 'test-direct';
const socketDir = join(homedir(), '.agent-browser');
const portFile = join(socketDir, `${session}.port`);

try {
  const port = parseInt(readFileSync(portFile, 'utf-8'), 10);
  console.log(`Connecting to daemon on port ${port}...`);

  const socket = net.connect(port, '127.0.0.1');

  socket.on('connect', () => {
    console.log('Connected to daemon');

    // Send launch command with CDP URL
    const cmd = {
      action: 'launch',
      id: 'test-1',
      cdpUrl: 'ws://localhost:9222/devtools/browser/fbffe38b-b2d2-4d2a-a786-ed8c973b02dd'
    };

    const cmdJson = JSON.stringify(cmd) + '\n';
    console.log('Sending command:', cmdJson);
    socket.write(cmdJson);
  });

  socket.on('data', (data) => {
    console.log('Response:', data.toString());
    socket.end();
    process.exit(0);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    process.exit(1);
  });

} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
