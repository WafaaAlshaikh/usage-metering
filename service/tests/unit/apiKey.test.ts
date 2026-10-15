import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, prefixOf } from '../../src/domain/apiKey';

describe('api keys', () => {
  it('generates distinct keys with the mk_ prefix', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to 64 hex characters', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different keys give different hashes, and the hash does not contain the key', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
    expect(hashApiKey(a)).not.toContain(a);
  });

  it('prefixOf returns the first 8 characters', () => {
    expect(prefixOf('mk_abcdefghij')).toBe('mk_abcde');
  });
});