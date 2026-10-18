import { randomUUID } from 'node:crypto';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export class ServiceError extends Error {
  constructor(status, body, message) {
    super(message ?? body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body ?? { error: { code: 'error', message: this.message } };
  }
}

/** One call to the metering service. `key` = account API key, `admin` = send the admin token. */
async function call(method, path, { key, admin, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-api-key'] = key;
  if (admin && ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN;
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ServiceError(res.status, json);
  return json;
}

async function waitForService() {
  for (let i = 0; i < 60; i++) {
    try {
      await call('GET', '/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Metering service not reachable at ${SERVICE_URL}`);
}

// The demo account of this run. Replaced as a whole by seed().
let current = null;
let inFlight = null;

const need = () => {
  if (!current) throw new ServiceError(503, null, 'Demo is still starting, try again in a moment');
  return current;
};

/**
 * Creates a fresh demo account (new API key, nothing consumed):
 *   account plan  "Demo Account"  100 / month, 50 per request   (small, so the shared limit is easy to hit)
 *   alice, carol  "Demo Basic"     80 / month, 20 per request   (two users, one plan definition)
 *   bob           "Demo Premium"  500 / month, 50 per request
 * Reset = call this again. Old accounts stay in the database, untouched.
 */
export function seed() {
  inFlight ??= doSeed().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSeed() {
  await waitForService();
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const account = await call('POST', '/accounts', { admin: true, body: { name: `Demo Co ${stamp}` } });
  const key = account.apiKey;

  const makePlan = (kind, name, monthlyAllowance, maxUnitsPerRequest) =>
    call('POST', '/plans', { key, body: { kind, name, monthlyAllowance, maxUnitsPerRequest } });

  const accountPlan = await makePlan('account', 'Demo Account', 100, 50);
  await call('PUT', '/account/plan', { key, body: { planId: accountPlan.id } });
  const basic = await makePlan('user', 'Demo Basic', 80, 20);
  const premium = await makePlan('user', 'Demo Premium', 500, 50);

  for (const [externalId, plan] of [['alice', basic], ['bob', premium], ['carol', basic]]) {
    await call('POST', '/users', { key, body: { externalId, planId: plan.id } });
  }

  current = { key, accountName: account.name, planIds: { account: accountPlan.id, basic: basic.id, premium: premium.id } };
  console.log(`demo seeded: ${account.name} (key ${account.apiKeyPrefix}...)`);
}

export async function getState() {
  const { key, accountName, planIds } = need();
  const [usage, plans, history] = await Promise.all([
    call('GET', '/usage?limit=100', { key }),
    call('GET', '/plans', { key }),
    call('GET', '/history?limit=12', { key }),
  ]);
  return { accountName, planIds, period: usage.period, account: usage.account, users: usage.users, plans: plans.plans, history: history.requests };
}

/** A new requestId per click. (A retry of the SAME request would reuse its id and come back as replayed.) */
export function consume(userId, units) {
  const { key } = need();
  return call('POST', '/consume', { key, body: { userId, units, requestId: `demo-${randomUUID()}` } });
}

export function switchUserPlan(userId, planId) {
  return call('PUT', `/users/${encodeURIComponent(userId)}/plan`, { key: need().key, body: { planId } });
}

/** null = remove that limit, a missing field = unchanged. */
export function updatePlan(planId, { monthlyAllowance, maxUnitsPerRequest }) {
  return call('PATCH', `/plans/${planId}`, { key: need().key, body: { monthlyAllowance, maxUnitsPerRequest } });
}

/** Scenarios that test the rules start from a fresh demo account, so they behave the same in any order. */
const FRESH = new Set(['account-limit']);

export async function scenario(name) {
  if (FRESH.has(name)) await seed();
  const { planIds } = need();
  if (!planIds) {
    throw new ServiceError(409, null, 'The active account was created in the API explorer. Press "Reset demo" to get the demo account back.');
  }
  switch (name) {
    case 'accepted':
      return { decisions: [await consume('alice', 10)] };
    case 'user-limit': // alice: 25 > her 20 per request, while both monthly allowances have room
      return { decisions: [await consume('alice', 25)] };
    case 'account-limit': { // bob has plenty of his own allowance; the shared 100 runs out first
      const decisions = [];
      for (let i = 0; i < 5; i++) {
        const d = await consume('bob', 50);
        decisions.push(d);
        if (!d.accepted) break;
      }
      return { decisions };
    }
    case 'raise-basic-limit': {
      await updatePlan(planIds.basic, { maxUnitsPerRequest: 50 });
      return { decisions: [], note: 'Demo Basic now allows 50 per request (alice and carol both use it). Run "alice consumes 25" again.' };
    }
    case 'switch-alice-premium': {
      await switchUserPlan('alice', planIds.premium);
      return { decisions: [], note: 'alice is now on Demo Premium. Her usage so far is kept.' };
    }
    default:
      throw new ServiceError(404, null, `Unknown scenario "${name}"`);
  }
}

const ROUTE = /^\/(health|accounts|account|users|plans|consume|usage|history)(\/[^\s\\]*)?(\?[^\s\\]*)?$/;

/**
 * Sends one request to the metering service on behalf of the API explorer page.
 * Only the service's own routes are allowed, so this cannot be used to reach anything else.
 * auth: 'key' (active demo account), 'none', 'wrong' (invalid key), 'admin' (admin token).
 * rawBody is forwarded as typed, so malformed JSON can be tested too.
 */
export async function proxy({ method, path, auth = 'key', rawBody = '', activate = false }) {
  const m = String(method ?? '').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new ServiceError(400, null, 'Unsupported method');
  if (typeof path !== 'string' || !ROUTE.test(path) || path.includes('..')) {
    throw new ServiceError(400, null, 'Path is not a route of the metering service');
  }

  const headers = {};
  if (auth === 'key') headers['x-api-key'] = need().key;
  else if (auth === 'wrong') headers['x-api-key'] = 'mk_this-key-does-not-exist';
  else if (auth === 'admin' && ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN;

  const hasBody = m !== 'GET' && typeof rawBody === 'string' && rawBody.trim() !== '';
  if (hasBody) headers['content-type'] = 'application/json';

  const t0 = performance.now();
  try {
    const res = await fetch(`${SERVICE_URL}${path}`, { method: m, headers, body: hasBody ? rawBody : undefined });
    const text = await res.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: show the text as is */
    }
    const out = {
      status: res.status,
      ms: Math.round(performance.now() - t0),
      retryAfter: res.headers.get('retry-after'),
      body,
    };
    if (activate && m === 'POST' && path === '/accounts' && res.status === 201 && body?.apiKey) {
      current = { key: body.apiKey, accountName: body.name, planIds: null };
      out.activated = true;
    }
    return out;
  } catch (err) {
    return {
      status: 0,
      ms: Math.round(performance.now() - t0),
      retryAfter: null,
      body: { error: { code: 'unreachable', message: String(err?.message ?? err) } },
    };
  }
}