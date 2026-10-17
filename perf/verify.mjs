import { execFileSync } from 'node:child_process';

function psql(sql) {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'metering', '-d', 'metering', '-At', '-F', ',', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  return out ? out.split('\n').map((l) => l.split(',')) : [];
}

const SCOPE = `a.name like 'perf-%' or a.name like 'mixed-%'`;

// 1. Account level: counter per (account, month) = sum of accepted units in the log for that month.
const accountRows = psql(`
  select a.id, coalesce(c.period_start::text, l.period_start::text) as period,
         coalesce(c.consumed, 0) as counter, coalesce(l.units, 0) as logged
  from accounts a
  left join account_usage c on c.account_id = a.id
  full join (
    select account_id, period_start, sum(units) as units
    from request_log where accepted group by account_id, period_start
  ) l on l.account_id = a.id and l.period_start = c.period_start
  where ${SCOPE};`);

// 2. User level: counter per (user, month) = sum of accepted units of that user in that month.
const userRows = psql(`
  select u.id, coalesce(c.period_start::text, l.period_start::text) as period,
         coalesce(c.consumed, 0) as counter, coalesce(l.units, 0) as logged
  from users u join accounts a on a.id = u.account_id
  left join user_usage c on c.user_id = u.id
  full join (
    select user_id, period_start, sum(units) as units
    from request_log where accepted group by user_id, period_start
  ) l on l.user_id = u.id and l.period_start = c.period_start
  where ${SCOPE};`);

// 3. Account counter = sum of its users' counters, per month.
const sumRows = psql(`
  select a.id, c.period_start::text, c.consumed,
         coalesce((select sum(consumed) from user_usage where account_id = a.id and period_start = c.period_start), 0)
  from accounts a join account_usage c on c.account_id = a.id
  where ${SCOPE};`);

const totals = psql(`
  select count(distinct a.id), count(l.id)
  from accounts a left join request_log l on l.account_id = a.id
  where ${SCOPE};`)[0] ?? ['0', '0'];
const [accounts, requests] = totals.map(Number);

let bad = 0;
const check = (label, rows, a, b) => {
  for (const r of rows) {
    if (r[a] !== r[b]) {
      bad++;
      console.error(`MISMATCH (${label}) ${r.join(' | ')}`);
    }
  }
};
check('account counter vs log', accountRows, 2, 3);
check('user counter vs log', userRows, 2, 3);
check('account counter vs sum of users', sumRows, 2, 3);

console.log(`${accounts} test accounts, ${requests} logged requests, ${accountRows.length} account-months, ${userRows.length} user-months checked`);
if (accounts === 0 || requests === 0) {
  console.error('FAIL: no perf-*/mixed-* accounts or no requests found, nothing was verified');
  process.exit(1);
}
if (bad) {
  console.error(`${bad} mismatches`);
  process.exit(1);
}
console.log('OK: per account/user/month, counters = accepted units in the log, and account = sum of users');