import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX_LENGTH = 8;

export function generateApiKey(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function prefixOf(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}