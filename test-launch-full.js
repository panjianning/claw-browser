#!/usr/bin/env node

// Test browser launching by starting a daemon and sending launch command
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';

const SESSION = 'test-launch-browser';
const SOCKET_DIR =
  process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '', '.agent-browser')
    : path.join(process.env.HOME || '', '.agent-browser');

async function testBrowserLaunch() {
  console.log('Testing browser launch via daemon...\n');

  // 1. Start daemon
  console.log('[1/5] Starting daemon...');
  const env = { ...process.env };
  env.AGENT_BROWSER_DAEMON = '1';
  env.AGENT_BROWSER_SESSION = SESSION;
  env.AGENT_BROWSER_DEBUG = '1';

  const daemon = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js')], {
    env,
    detached: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  // Wait for daemon to be ready
  console.log('  Waiting for daemon to start...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const portPath = path.join(SOCKET_DIR, `${SESSION}.port`);
  if (!fs.existsSync(portPath)) {
    daemon.kill();
    throw new Error('Daemon did not create port file');
  }

  const port = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
  console.log(`✓ Daemon started on port ${port}\n`);

  let socket;
  try {
    // 2. Connect to daemon
    console.log('[2/5] Connecting to daemon...');
    socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    console.log('✓ Connected to daemon\n');

    // 3. Send launch command
    console.log('[3/5] Sending launch command...');
    const launchCmd = {
      id: 'test-launch-1',
      action: 'launch',
      headless: true,
      args: [],
    };

    socket.write(JSON.stringify(launchCmd) + '\n');

    // Wait for response
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Launch timeout')), 60000);
      socket.once('data', (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
      socket.once('error', reject);
    });

    console.log('Response:', response);

    if (response.success) {
      console.log('✓ Browser launched successfully\n');

      // 4. Send navigate command
      console.log('[4/5] Navigating to example.com...');
      const navCmd = {
        id: 'test-nav-1',
        action: 'navigate',
        url: 'https://example.com',
      };

      socket.write(JSON.stringify(navCmd) + '\n');

      const navResponse = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Navigate timeout')), 30000);
        socket.once('data', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
        socket.once('error', reject);
      });

      console.log('Response:', navResponse);
      if (navResponse.success) {
        console.log(`✓ Navigation successful: ${navResponse.data?.url}\n`);
      } else {
        console.log(`✗ Navigation failed: ${navResponse.error}\n`);
      }

      // 5. Close browser
      console.log('[5/5] Closing browser...');
      const closeCmd = {
        id: 'test-close-1',
        action: 'close',
      };

      socket.write(JSON.stringify(closeCmd) + '\n');

      const closeResponse = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Close timeout')), 10000);
        socket.once('data', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
        socket.once('error', reject);
      });

      console.log('Response:', closeResponse);
      console.log('✓ Browser closed\n');

      console.log('All tests passed! ✓');
    } else {
      console.log(`✗ Launch failed: ${response.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('\n✗ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (socket) {
      socket.end();
    }
    daemon.kill();
    // Clean up port file
    try {
      fs.unlinkSync(portPath);
    } catch {
      // Ignore
    }
  }
}

testBrowserLaunch();
