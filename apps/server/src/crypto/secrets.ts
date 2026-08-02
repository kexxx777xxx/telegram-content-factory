import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

/**
 * AES-256-GCM envelope for bot tokens and provider API keys.
 *
 * Stored form: `v1.<iv-b64>.<tag-b64>.<ciphertext-b64>`. The version prefix
 * exists so a future key rotation can decrypt old rows while writing new ones.
 */

const KEY = Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');
const VERSION = 'v1';
const IV_BYTES = 12;

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Пошкоджений або несумісний формат зашифрованого секрету');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * What the API returns instead of a secret. Never send the real value to the
 * client — not even to the admin UI, which only ever needs to confirm identity.
 */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `···${tail}`;
}

export function maskStoredSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return maskSecret(decryptSecret(stored));
  } catch {
    return '···(не вдалося розшифрувати)';
  }
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
