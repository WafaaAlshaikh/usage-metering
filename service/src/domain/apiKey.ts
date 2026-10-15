import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX_LENGTH = 8;

/** A new random key, e.g. "mk_5Zq...". Shown to the caller once; only its hash is stored. */
export function generateApiKey(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 as hex. The key is random with 256 bits of entropy, so a plain fast hash is enough. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** First characters of the key, stored so humans can tell keys apart. */
export function prefixOf(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}