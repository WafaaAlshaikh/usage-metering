import { execFileSync } from 'node:child_process';

const sql = `
select a.id,
       coalesce((select sum(consumed) from account_usage where account_id = a.id), 0) as account_total,
       coalesce((select sum(consumed) from user_usage    where account_id = a.id), 0) as users_total,
       coalesce((select sum(units) from request_log where account_id = a.id and accepted), 0) as log_total,
       (select count(*) from request_log where account_id = a.id) as log_rows
from accounts a
where a.name like 'perf-%'
order by a.created_at;`;

const out = execFileSync(
  'docker',
  ['compose', 'exec', '-T', 'db', 'psql', '-U', 'metering', '-d', 'metering', '-At', '-F', ',', '-c', sql],
  { encoding: 'utf8' },
).trim();

let bad = 0, rows = 0, units = 0;
for (const line of out ? out.split('\n') : []) {
  const [id, acc, usr, log, n] = line.split(',');
  rows += Number(n);
  units += Number(acc);
  if (acc !== usr || acc !== log) {
    bad++;
    console.error(`MISMATCH ${id}: account_usage=${acc} user_usage=${usr} request_log=${log}`);
  }
}
const accounts = out ? out.split('\n').length : 0;
console.log(`${accounts} perf accounts, ${rows} logged requests, ${units} units consumed`);
if (bad) { console.error(`${bad} accounts DISAGREE`); process.exit(1); }
console.log('OK: account_usage = sum(user_usage) = sum(accepted request_log) for every account');