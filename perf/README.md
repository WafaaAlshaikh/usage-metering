# Performance tests

Load tests for `POST /consume` with [k6](https://k6.io), plus a correctness check that runs after the load.

## Requirements

- Docker (the stack runs with `docker compose`), Node 22.12+ (for `verify.mjs`)
- k6 v1.x or newer (`winget install k6` on Windows, `brew install k6` on macOS)

## What is tested

| Script | Load | What it shows |
|---|---|---|
| `k6/consume-hot-account.js` | 20 VUs, 30 s, **one** account with 20 users | Worst case: every request needs the same shared account counter, so they run one after another |
| `k6/consume-many-accounts.js` | 20 VUs, 30 s, **50** accounts with 5 users each | Same load spread over many accounts: requests of different accounts do not wait for each other |
| `k6/consume-mixed.js` | 20 VUs + 1 plan editor, 30 s, one account with 20 users | Correctness under pressure: small limits so many requests are **rejected**, every 4th request repeats a previous `requestId` (**retries**), and the user plan allowance is **edited every second** during the run |

The first two create fixtures in `setup()` with very large limits, so no request is rejected by the rules and the measurement is about throughput and latency. Every request has a unique `requestId`. Only `/consume` calls are measured (tagged `name:consume`); the setup traffic is excluded. The mixed scenario is mainly a correctness test; its latency numbers include rejections, replays and plan updates.

`verify.mjs` runs after each test, over every account created by these scripts (`perf-*` and `mixed-*`). It fails if no such account or no request exists, and checks:

- per account and month: `account_usage` = sum of the units of accepted `request_log` rows;
- per user and month: `user_usage` = sum of that user's accepted units in the log;
- per account and month: `account_usage` = sum of its users' `user_usage`.

If concurrent requests had lost or double-counted a unit, this would fail.

## How to reproduce

Run everything from the repository root.

**Option 1: k6 in Docker (no k6 install needed)**

```powershell
$net = docker inspect (docker compose ps -q service) --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'

docker run --rm -i --network $net -v "${PWD}:/work" -w /work `
  -e BASE_URL=http://service:3000 grafana/k6 run perf/k6/consume-hot-account.js

docker run --rm -i --network $net -v "${PWD}:/work" -w /work `
  -e BASE_URL=http://service:3000 grafana/k6 run perf/k6/consume-many-accounts.js

node perf/verify.mjs
```

The network name is read from the running service container, so it does not depend on the repository folder name. Results were the same as with k6 installed on the host (series B and C below).

**Option 2: k6 installed locally**

```powershell
# Quiet logs (per-request logging distorts the numbers)
$env:LOG_LEVEL = "warn"
docker compose up -d --build
Remove-Item Env:LOG_LEVEL

# Clean slate (deletes ALL data, including the demo account)
docker compose exec -T db psql -U metering -d metering -c "truncate request_log, user_usage, account_usage, users, accounts, plans cascade;"
docker compose restart service client  # Re-seeds the predefined plans and the demo

k6 run -e RESULT=my-hot   perf/k6/consume-hot-account.js
k6 run -e RESULT=my-many  perf/k6/consume-many-accounts.js
k6 run -e RESULT=my-mixed perf/k6/consume-mixed.js
node perf/verify.mjs
```

Options: `-e VUS=40`, `-e DURATION=60s`, `-e ACCOUNTS=100`, `-e BASE_URL=...`, `-e ADMIN_TOKEN=...`. Results are written to `perf/results/<RESULT>.json`. `verify.mjs` checks every test account ever created, so the counts grow with each run unless you truncate as shown above.

## Environment of the recorded runs

Laptop, AMD Ryzen 5 4500U (6 cores), 7.4 GB RAM, Windows 11, Docker Desktop (WSL2, 6 CPUs and 3.5 GB for Docker). k6, the service and PostgreSQL all share the same 6 cores. One run per scenario. Treat absolute numbers as laptop numbers; the comparison between runs is what matters.

## Results

### Series A: k6 on the host (through Docker Desktop's port forwarding)

| Run | consumes/s | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| baseline, hot account | 32 | 134 ms | 1701 ms | 2219 ms |
| baseline, 50 accounts | 59 | 247 ms | 426 ms | 529 ms |
| after optimisation 1, hot account | 40 | 509 ms | 759 ms | 1485 ms |
| after optimisation 1, 50 accounts | 82 | 170 ms | 319 ms | 526 ms |
| after optimisation 1, hot, `DB_POOL_MAX=10` | 37 | 482 ms | 777 ms | 1221 ms |

### Series B: k6 inside the Compose network, code before the month change (default log level)

| Run | consumes | consumes/s (over the 30 s scenario) | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| hot account, 20 VUs | 2141 | ~71 | 253 ms | 542 ms | 916 ms | 1385 ms |
| 50 accounts, 20 VUs | 6252 | ~208 | 87 ms | 145 ms | 286 ms | 490 ms |

### Series C: k6 installed on the host, code before the month change (default log level)

| Run | consumes | consumes/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| hot account, 20 VUs | 2153 | ~72 | 264 ms | 492 ms | 722 ms | 957 ms |

Series B and C give the same result, so where k6 runs (host or inside the Compose network) does not matter here. Series A is about 2x slower for the same decision code, and we did not identify why (possible factors: laptop power mode, Docker/WSL resources, background load, state of the database); we did not investigate it. **Compare runs only within a series (one session).**

### Series D: current code, month decided at lock time (k6 on the host, default log level)

| Run | consumes | consumes/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| hot account, 20 VUs | 1848 | ~62 | 54 ms | 1583 ms | 2659 ms | 3241 ms |
| 50 accounts, 20 VUs | 4917 | ~164 | 112 ms | 187 ms | 264 ms | 470 ms |

Compared with series B (same decision logic, month computed before the transaction), throughput is 13% lower on the hot account and 21% lower with 50 accounts. The change reads the month from the database clock before and after taking the locks (two extra round trips, about 7 to 9 queries per consume) so a request that waits across midnight UTC is counted in the month in which it is decided. We accepted the cost for correctness. Series D ran in a different session from series B, and sessions differed by up to 2x on this laptop, so the size of the drop is approximate. On the hot account the latency distribution is wider than in series B (lower median, higher p95/p99); we did not investigate why.

### Series E: mixed workload (k6 on the host, same session as series D)

| Run | consumes | consumes/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| mixed, 20 VUs + plan editor | 2555 | ~85 | 177 ms | 649 ms | 948 ms | 1259 ms |

Quota rejections, repeated `requestId`s and a plan edit every second all happened during the run. `verify.mjs` afterwards: 157 test accounts, 26,877 logged requests, 890 user-months checked, all counters equal to the accepted units in the log, and every account equal to the sum of its users.

Correctness after every run: `verify.mjs` printed OK.

## What we learned

1. **The hot account is the bottleneck by design.** A consume must read and update the shared account counter without another request doing the same at that moment, otherwise the shared allowance could be exceeded. So requests of one account run one after another, which shows up as a long latency tail. Requests of different accounts do not block each other.

2. **The disk was not the problem.** A standalone commit took 5 to 8 ms on this machine, which cannot explain the baseline. During the runs the service and the database each used about one core: the time went into the number of round trips per request.

3. **Optimisation 1: fewer queries per consume, same decisions.** The usage rows for a month used to be created with two INSERTs on every request; now they are created only by the first request of a month (the normal path is just the lock). The two counter UPDATEs became one statement. A consume went from about 10 queries to 7. Result (series A, same session): 50 accounts +39% throughput; hot account +25% throughput and p95 cut by more than half, because the lock is held for a shorter time.

4. **Pool size made no measurable difference** (20 vs 10 connections, within noise of a single run), so the default stays 20.

5. **Correctness over speed.** Deciding the month at lock time (series D) cost 13% to 21% throughput. We kept it because the brief says usage belongs to the month in which a request is processed, and a request that waits for a lock across midnight UTC would otherwise be counted in the wrong month.

6. **Why we stopped optimising.** The remaining cost is the transaction itself and the per-account serialisation, which is what guarantees correct totals. Merging more queries (for example reading the month together with the user) would give a smaller gain (we estimate about 10%, not measured) and make the code harder to follow.

7. **Absolute numbers are not stable across sessions.** The same decision code gave about 2x the throughput in a later session, and moving k6 from the host into the Compose network changed nothing. Only runs made back to back in one session are comparable. What stays the same in every series is the shape: one hot account has 2 to 3x lower throughput and a higher p95 than the same load spread over 50 accounts. In a closed loop with 20 VUs, latency is roughly VUs divided by throughput, so the hot account's latency is mostly time spent waiting in the per-account queue.

## Limitations of these measurements

- One run per scenario on a shared laptop; differences of a few percent (like the pool test) are noise.
- The load generator competes with the service and the database for CPU.
- The throughput scenarios accept all requests. Rejections do the same work (lock, decision, log row), so their cost should be similar; the mixed run includes rejections but was not compared with an accepted-only run.
- Throughput was not tested above 20 VUs, and not with several service instances (that would need a shared database and the same locking, which already works across processes because the lock is in PostgreSQL).
- The throughput is requests divided by the configured scenario length (30 s). k6's own "whole run" time includes the setup and the container clock is not steady, so it was not used.
- Series B ran with the default log level (`info`), which costs a little throughput.
- Absolute numbers on this laptop varied about 2x between sessions; the cause was not identified. The before/after of optimisation 1 (same session) shows direction and rough size, not a precise figure.