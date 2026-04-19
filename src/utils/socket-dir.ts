import * as os from 'os';
import * as path from 'path';

/**
 * Get the base directory for daemon IPC files.
 * Priority: CLAW_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR/claw-browser > ~/.claw-browser > tmpdir
 */
export function getSocketDir(): string {
  const envDir = process.env.CLAW_BROWSER_SOCKET_DIR;
  if (envDir && envDir.trim().length > 0) {
    return envDir;
  }

  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.join(xdgRuntimeDir, 'claw-browser');
  }

  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, '.claw-browser');
  }

  return path.join(os.tmpdir(), 'claw-browser');
}
