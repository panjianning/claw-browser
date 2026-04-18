import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * State encryption using AES-256-GCM
 * Translate from cli/src/native/state.rs encryption logic
 */

export interface StorageState {
  cookies: Cookie[];
  origins: OriginStorage[];
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  url?: string;
}

export interface OriginStorage {
  origin: string;
  localStorage: StorageEntry[];
  sessionStorage: StorageEntry[];
}

export interface StorageEntry {
  name: string;
  value: string;
}

/**
 * Derive encryption key from password using SHA-256
 */
export function deriveKey(password: string): Buffer {
  const hash = createHash('sha256');
  hash.update(password);
  return hash.digest();
}

/**
 * Encrypt data using AES-256-GCM
 * @param data - Data to encrypt
 * @param key - 32-byte encryption key
 * @returns Encrypted data: nonce (12 bytes) + tag (16 bytes) + ciphertext
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error('Key must be 32 bytes for AES-256');
  }

  const nonce = randomBytes(12); // 96-bit nonce for GCM
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: nonce (12) + tag (16) + ciphertext
  return Buffer.concat([nonce, tag, encrypted]);
}

/**
 * Decrypt data using AES-256-GCM
 * @param encrypted - Encrypted data (nonce + tag + ciphertext)
 * @param key - 32-byte encryption key
 * @returns Decrypted data
 */
export function decrypt(encrypted: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error('Key must be 32 bytes for AES-256');
  }

  if (encrypted.length < 28) {
    throw new Error('Encrypted data too short');
  }

  const nonce = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(12, 28);
  const ciphertext = encrypted.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Save storage state to encrypted file
 */
export async function saveState(
  state: StorageState,
  path: string,
  password?: string
): Promise<void> {
  const fs = await import('fs/promises');
  const pathMod = await import('path');

  const json = JSON.stringify(state, null, 2);
  const data = Buffer.from(json, 'utf-8');

  if (password) {
    const key = deriveKey(password);
    const encrypted = encrypt(data, key);
    await fs.writeFile(path, encrypted);
  } else {
    await fs.writeFile(path, data, 'utf-8');
  }
}

/**
 * Load storage state from encrypted file
 */
export async function loadState(path: string, password?: string): Promise<StorageState> {
  const fs = await import('fs/promises');

  const fileData = await fs.readFile(path);

  let json: string;
  if (password) {
    const key = deriveKey(password);
    const decrypted = decrypt(fileData, key);
    json = decrypted.toString('utf-8');
  } else {
    json = fileData.toString('utf-8');
  }

  return JSON.parse(json);
}
