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

Fixtures are created in `setup()` with very large limits, so no request is rejected by the rules and the measurement is about throughput and latency, not about the decisions. Every request has a unique `requestId`. Only `/consume` calls are measured (tagged `name:consume`); the setup traffic is excluded.

`verify.mjs` runs after each test. For every account created by the tests (`perf-*`) it checks that
`account_usage = sum(user_usage) = sum(units of accepted request_log rows)`.
If concurrent requests had lost or double-counted a unit, this would fail.

## How to reproduce

Run everything from the repository root.

    # quiet logs (per-request logging distorts the numbers)
    $env:LOG_LEVEL = "warn"            # PowerShell; use LOG_LEVEL=warn on bash
    docker compose up -d --build
    Remove-Item Env:LOG_LEVEL

    # clean slate (deletes ALL data, including the demo account)
    docker compose exec -T db psql -U metering -d metering -c "truncate request_log, user_usage, account_usage, users, accounts, plans cascade;"
    docker compose restart service client      # re-seeds the predefined plans and the demo

    k6 run -e RESULT=my-hot  perf/k6/consume-hot-account.js
    k6 run -e RESULT=my-many perf/k6/consume-many-accounts.js
    node perf/verify.mjs

Options: `-e VUS=40`, `-e DURATION=60s`, `-e ACCOUNTS=100`, `-e BASE_URL=...`, `-e ADMIN_TOKEN=...`. Results are written to `perf/results/<RESULT>.json`.

## Environment of the recorded runs

Laptop, AMD Ryzen 5 4500U (6 cores), 7.4 GB RAM, Windows 11, Docker Desktop (WSL2, 6 CPUs and 3.5 GB for Docker). k6, the service and PostgreSQL all share the same 6 cores. One run per scenario. Treat absolute numbers as laptop numbers; the comparison between runs is what matters.

## Results

| Run | consumes/s | p50 | p95 | p99 |
|---|---|---|---|---|
| baseline, hot account | 32 | 134 ms | 1701 ms | 2219 ms |
| baseline, 50 accounts | 59 | 247 ms | 426 ms | 529 ms |
| after optimisation 1, hot account | 40 | 509 ms | 759 ms | 1485 ms |
| after optimisation 1, 50 accounts | 82 | 170 ms | 319 ms | 526 ms |
| after optimisation 1, hot, `DB_POOL_MAX=10` | 37 | 482 ms | 777 ms | 1221 ms |

Correctness after every run: `verify.mjs` printed OK (account counter = sum of user counters = sum of accepted log rows).

## What we learned

1. **The hot account is the bottleneck by design.** A consume must read and update the shared account counter without another request doing the same at that moment, otherwise the shared allowance could be exceeded. So requests of one account run one after another, which shows up as a long latency tail (baseline p95 1.7 s vs 0.4 s with many accounts). Requests of different accounts do not block each other.
2. **The disk was not the problem.** A standalone commit took 5 to 8 ms on this machine, which cannot explain the baseline. During the runs the service and the database each used about one core: the time went into the number of round trips per request.
3. **Optimisation 1: fewer queries per consume, same decisions.** The usage rows for a month used to be created with two INSERTs on every request; now they are created only by the first request of a month (the normal path is just the lock). The two counter UPDATEs became one statement. A consume went from about 10 queries to 7. Result: 50 accounts +39% throughput; hot account +25% throughput and p95 cut by more than half, because the lock is held for a shorter time.
4. **Pool size made no measurable difference** (20 vs 10 connections, within noise of a single run), so the default stays 20.
5. **Why we stopped here.** The remaining cost is the transaction itself and the per-account serialisation, which is what guarantees correct totals. Merging more queries would give a smaller gain (we estimate 10 to 15%, not measured) with more risk for correctness.

## Limitations of these measurements

- One run per scenario on a shared laptop; differences of a few percent (like the pool test) are noise.
- The load generator competes with the service and the database for CPU.
- All requests are accepted. Rejections do the same work (lock, decision, log row), so their cost should be similar, but it was not measured separately.
- Throughput was not tested above 20 VUs, and not with several service instances (that would need a shared database and the same locking, which already works across processes because the lock is in PostgreSQL).