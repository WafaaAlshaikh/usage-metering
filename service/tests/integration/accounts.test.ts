import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts } from '../../src/db/schema';
import { hashApiKey } from '../../src/domain/apiKey';
import { BadRequestError } from '../../src/domain/errors';
import { findAccountByKeyHash } from '../../src/repo/accounts';
import { registerAccount } from '../../src/services/accounts';
import { setupTestDb, type TestDb } from '../helpers/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('registerAccount', () => {
  it('creates an account on the Starter plan and returns the raw key once', async () => {
    const r = await registerAccount(t.db, { name: 'Acme' });
    expect(r.apiKey).toMatch(/^mk_/);
    expect(r.apiKeyPrefix).toBe(r.apiKey.slice(0, 8));
    const [row] = await t.db.select().from(accounts).where(eq(accounts.id, r.id));
    expect(row!.apiKeyHash).toBe(hashApiKey(r.apiKey));
    expect(row!.apiKeyHash).not.toContain(r.apiKey); // only the hash is stored
  });

  it('can start on another predefined account plan', async () => {
    const r = await registerAccount(t.db, { name: 'BigCo', planName: 'Pro' });
    const [row] = await t.db.select().from(accounts).where(eq(accounts.id, r.id));
    expect(row!.accountPlanId).toBe(r.planId);
  });

  it('rejects a plan that does not exist or is a user plan', async () => {
    await expect(registerAccount(t.db, { name: 'X', planName: 'Nope' })).rejects.toBeInstanceOf(BadRequestError);
    await expect(registerAccount(t.db, { name: 'X', planName: 'Basic' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('finds the account by the hash of its key, and not by a wrong key', async () => {
    const r = await registerAccount(t.db, { name: 'Finder' });
    expect((await findAccountByKeyHash(t.db, hashApiKey(r.apiKey)))?.id).toBe(r.id);
    expect(await findAccountByKeyHash(t.db, hashApiKey('mk_wrong'))).toBeNull();
  });

  it('two accounts get different keys', async () => {
    const a = await registerAccount(t.db, { name: 'A' });
    const b = await registerAccount(t.db, { name: 'B' });
    expect(a.apiKey).not.toBe(b.apiKey);
  });
});