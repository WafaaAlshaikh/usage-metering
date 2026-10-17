import http from 'k6/http';
import { check, fail } from 'k6';
import { BASE, ADMIN, summarize } from './lib.js';
import { sleep } from 'k6';

export const options = {
  scenarios: {
    traffic: { executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || '30s', exec: 'traffic' },
    planChanges: { executor: 'constant-vus', vus: 1, duration: __ENV.DURATION || '30s', exec: 'planChanges' },
  },
  thresholds: { http_req_failed: ['rate<0.001'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { 'content-type': 'application/json' };
const post = (path, body, headers) => http.post(`${BASE}${path}`, JSON.stringify(body), { headers: { ...json, ...headers } });

export function setup() {
  const acc = post('/accounts', { name: `mixed-${Date.now()}` }, { 'x-admin-token': ADMIN });
  if (acc.status !== 201) fail(`create account: ${acc.status} ${acc.body}`);
  const { apiKey } = acc.json();
  const auth = { 'x-api-key': apiKey };
  // Small limits on purpose: the account allowance runs out, so many requests are rejected.
  const ap = post('/plans', { kind: 'account', name: 'mixed-account', monthlyAllowance: 3000, maxUnitsPerRequest: 10 }, auth).json();
  const up = post('/plans', { kind: 'user', name: 'mixed-user', monthlyAllowance: 400, maxUnitsPerRequest: 5 }, auth).json();
  http.put(`${BASE}/account/plan`, JSON.stringify({ planId: ap.id }), { headers: { ...json, ...auth } });
  const users = [];
  for (let i = 0; i < 20; i++) {
    post('/users', { externalId: `u${i}`, planId: up.id }, auth);
    users.push(`u${i}`);
  }
  return { key: apiKey, userPlanId: up.id, users };
}

export function traffic(d) {
  const user = d.users[(__VU + __ITER) % d.users.length];
  const units = 1 + ((__VU * 7 + __ITER) % 8); // 1..8: some exceed the user's per-request limit (5)
  // every 4th iteration repeats the previous requestId of this VU: a retry that must be replayed
  const seq = __ITER % 4 === 3 ? __ITER - 1 : __ITER;
  const body = { userId: user, units: units, requestId: `mx-${__VU}-${seq}` };
  // a repeat must carry the same user and units as the original, so derive them from seq
  const u2 = d.users[(__VU + seq) % d.users.length];
  const n2 = 1 + ((__VU * 7 + seq) % 8);
  const res = post('/consume', { ...body, userId: u2, units: n2 }, { 'x-api-key': d.key });
  check(res, { 'status 200': (r) => r.status === 200 });
}

// While traffic runs, the user plan limits move up and down (plans change under load).
export function planChanges(d) {
  const allowance = 100 + ((__ITER * 137) % 600);
  http.patch(`${BASE}/plans/${d.userPlanId}`, JSON.stringify({ monthlyAllowance: allowance }), {
    headers: { ...json, 'x-api-key': d.key },
  });
  sleep(1);
}

export function handleSummary(data) {
  return summarize(data, __ENV.RESULT || 'mixed');
}