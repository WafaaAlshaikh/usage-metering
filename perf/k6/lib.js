import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const ADMIN = __ENV.ADMIN_TOKEN || 'dev-admin-token';
const json = { 'content-type': 'application/json' };

function post(path, body, headers = {}, extra = {}) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), { headers: { ...json, ...headers }, ...extra });
}

/**
 * Creates `accounts` accounts, each with huge limits (so no request is ever rejected and the
 * measurement is about throughput, not about the rules) and `users` users.
 * Returns [{ key, accountId, users: ['u0', ...] }].
 */
export function createFixtures({ accounts, users }) {
  const out = [];
  const stamp = Date.now();
  for (let a = 0; a < accounts; a++) {
    const acc = post('/accounts', { name: `perf-${stamp}-${a}` }, { 'x-admin-token': ADMIN });
    if (acc.status !== 201) fail(`create account: ${acc.status} ${acc.body}`);
    const { id, apiKey } = acc.json();
    const auth = { 'x-api-key': apiKey };
    const BIG = 1_000_000_000_000;

    const ap = post('/plans', { kind: 'account', name: 'perf-account', monthlyAllowance: BIG, maxUnitsPerRequest: 1000 }, auth).json();
    const up = post('/plans', { kind: 'user', name: 'perf-user', monthlyAllowance: BIG, maxUnitsPerRequest: 1000 }, auth).json();
    const r = http.put(`${BASE}/account/plan`, JSON.stringify({ planId: ap.id }), { headers: { ...json, ...auth } });
    if (r.status !== 200) fail(`assign account plan: ${r.status} ${r.body}`);

    const names = [];
    for (let u = 0; u < users; u++) {
      const res = post('/users', { externalId: `u${u}`, planId: up.id }, auth);
      if (res.status !== 201) fail(`create user: ${res.status} ${res.body}`);
      names.push(`u${u}`);
    }
    out.push({ key: apiKey, accountId: id, users: names });
  }
  return out;
}

let counter = 0;
/** One consume call with a unique requestId, tagged so the summary can ignore setup traffic. */
export function consumeOnce(fixture, vu, units = 1) {
  const user = fixture.users[(vu + counter++) % fixture.users.length];
  const res = post(
    '/consume',
    { userId: user, units, requestId: `k6-${vu}-${__ITER}-${Date.now()}-${counter}` },
    { 'x-api-key': fixture.key },
    { tags: { name: 'consume' } },
  );
  check(res, {
    'status 200': (r) => r.status === 200,
    accepted: (r) => r.status === 200 && r.json('accepted') === true,
  });
  return res;
}

export function summarize(data, name) {
  const dur = data.metrics['http_req_duration{name:consume}'];
  const t = dur ? dur.values : data.metrics.http_req_duration.values;
  const n = data.metrics.iterations.values.count;
  // const secs = data.state.testRunDurationMs / 1000;
  const secs = parseInt(__ENV.DURATION || '30', 10);
  const text = `\n${name}: ${n} consumes, ${(n / secs).toFixed(0)} consumes/s (over ${secs}s)
latency ms (consume only): avg ${t.avg.toFixed(1)}  p50 ${t.med.toFixed(1)}  p95 ${t['p(95)'].toFixed(1)}  p99 ${t['p(99)'].toFixed(1)}  max ${t.max.toFixed(1)}
failed: ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%\n`;
  return { [`perf/results/${name}.json`]: JSON.stringify(data, null, 2), stdout: text };
}