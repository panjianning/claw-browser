import { existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { execSync } from 'child_process';

/**
 * Find Chrome/Chromium executable on the system.
 * Checks common installation paths based on platform.
 */
export function findChrome(): string | null {
  const platform = process.platform;

  if (platform === 'win32') {
    return findChromeWindows();
  } else if (platform === 'darwin') {
    return findChromeMac();
  } else {
    return findChromeLinux();
  }
}

function findChromeWindows(): string | null {
  const paths = [
    // Chrome stable
    join(
      process.env.PROGRAMFILES || 'C:\\Program Files',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),

    // Chromium
    join(
      process.env.PROGRAMFILES || 'C:\\Program Files',
      'Chromium\\Application\\chrome.exe'
    ),
    join(process.env.LOCALAPPDATA || '', 'Chromium\\Application\\chrome.exe'),

    // Edge
    join(
      process.env.PROGRAMFILES || 'C:\\Program Files',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function findChromeMac(): string | null {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(os.homedir(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    join(os.homedir(), '/Applications/Chromium.app/Contents/MacOS/Chromium'),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function findChromeLinux(): string | null {
  // Try common binary names
  const binaries = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ];

  for (const binary of binaries) {
    try {
      const path = execSync(`which ${binary}`, { encoding: 'utf-8' }).trim();
      if (path && existsSync(path)) {
        return path;
      }
    } catch {
      // Binary not found, continue
    }
  }

  // Check common installation directories
  const paths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}
