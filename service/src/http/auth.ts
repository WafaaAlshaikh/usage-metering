import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import type { Account } from '../db/schema';
import { hashApiKey } from '../domain/apiKey';
import { UnauthorizedError } from '../domain/errors';
import { findAccountByKeyHash } from '../repo/accounts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by apiKeyAuth: the account the API key belongs to. */
    account: Account | null;
  }
}

/** Resolves x-api-key to an account. The account id used everywhere comes from here, never from the body. */
export function apiKeyAuth(db: Db) {
  return async (req: FastifyRequest): Promise<void> => {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw new UnauthorizedError();
    const account = await findAccountByKeyHash(db, hashApiKey(key));
    if (!account) throw new UnauthorizedError();
    req.account = account;
  };
}

/** Guards POST /accounts when ADMIN_TOKEN is configured. Constant-time comparison. */
export function adminAuth(adminToken: string | undefined) {
  const sha = (s: string) => createHash('sha256').update(s).digest();
  return async (req: FastifyRequest): Promise<void> => {
    if (adminToken === undefined) return; // open in local dev, documented in README
    const given = req.headers['x-admin-token'];
    if (typeof given !== 'string' || !timingSafeEqual(sha(given), sha(adminToken))) {
      throw new UnauthorizedError('Missing or invalid admin token');
    }
  };
}