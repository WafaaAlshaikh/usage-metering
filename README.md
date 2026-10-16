# Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether their users may perform an action. Accounts and their users each have a plan; every request must satisfy both.

> Work in progress. This file is updated with every set of commits; see "Status" at the bottom.

## Stack

TypeScript, Fastify, PostgreSQL, Drizzle ORM, Zod, Vitest, k6, Docker Compose.

## Run locally (current state)

Prerequisites: Node 22.12+ (tested on 24), Docker.

    docker run --name metering-db -e POSTGRES_USER=metering -e POSTGRES_PASSWORD=metering -e POSTGRES_DB=metering -p 5434:5432 -d postgres:16-alpine
    cd service
    npm install
    $env:DATABASE_URL = "postgres://metering:metering@localhost:5434/metering"   (PowerShell)
    npm run dev

On start the service applies the migrations and seeds the predefined plans (safe to repeat). `GET /health` returns `{"status":"ok"}`.

## Run with Docker Compose

    docker compose up --build

This starts PostgreSQL and the service (the example client is added to this file once it exists). The service applies the migrations and seeds the predefined plans on start. Stop any local `npm run dev` first, because both use port 3000.

    curl http://localhost:3000/health

Settings have defaults inside `docker-compose.yml`; for local development without Docker copy `service/.env.example` to `service/.env`.

## Tests

    docker exec metering-db psql -U metering -d postgres -c "create database metering_test"
    cd service
    npm test

Integration tests run against a real PostgreSQL database whose name must end in `_test` (they wipe it). Override with `TEST_DATABASE_URL`.


## Performance

Load tested with k6 on a laptop (6 cores, shared by k6, the service and PostgreSQL). Full method, commands, and numbers are in [`perf/README.md`](perf/README.md).

| Scenario (20 VUs, 30 s) | consumes/s | p95 latency |
|---|---|---|
| One hot account, before optimisation | 32 | 1701 ms |
| One hot account, after | 40 | 759 ms |
| 50 accounts, before | 59 | 426 ms |
| 50 accounts, after | 82 | 319 ms |

- Requests of one account are serialised on its shared usage counter. That is what keeps the shared allowance exact under concurrency; requests of different accounts run in parallel.
- The optimisation removed round trips (about 10 queries per consume down to 7) without changing any decision.
- After every run, `perf/verify.mjs` confirmed that the account counter equals the sum of the user counters and the sum of accepted requests in the log.
- Concurrency is also covered by automated tests (200 parallel requests never exceed an allowance; 20 parallel retries count once).

## How a request is decided

Two rule types exist for both account plans and user plans: a monthly allowance (units per UTC calendar month) and a maximum per request. A request is accepted only if every rule of both plans allows the full amount; a rejection consumes nothing. Accepted units are added to both the user's and the account's usage for the current UTC month.

## Endpoints (summary)

All routes except `GET /health` and `POST /accounts` need the header `x-api-key`. `POST /accounts` needs `x-admin-token` when `ADMIN_TOKEN` is set.

| Method | Path | Purpose |
|---|---|---|
| POST | `/accounts` | Create an account; returns the API key once |
| GET | `/account` | Current account and its plan |
| PUT | `/account/plan` | Change the account plan |
| POST | `/users` | Register a user (re-activates a deleted one) |
| GET | `/users`, `/users/:id` | List (cursor pagination) / inspect with plan |
| PUT | `/users/:id/plan` | Change a user's plan |
| DELETE | `/users/:id` | Soft delete |
| GET | `/plans`, `/plans/:id` | Predefined plans and your own (`?kind=`, `?includeArchived=`) |
| POST / PATCH / DELETE | `/plans`, `/plans/:id` | Create / edit / archive a custom plan |
| POST | `/consume` | Decide and record one request |
| GET | `/usage` | Consumed and remaining, account plus a page of users (`?period=YYYY-MM`, `?limit`, `?after`) |
| GET | `/history` | Request outcomes, newest first (`?userId`, `?period`, `?accepted`, `?limit`, `?cursor`) |

Errors always look like `{ "error": { "code", "message", "details"? } }`. A rejected consume is HTTP 200 with `accepted: false` and the rule that blocked it.

## Predefined plans

| Kind | Name | Monthly allowance | Max per request |
|---|---|---|---|
| account | Starter | 10,000 | 100 |
| account | Pro | 1,000,000 | 1,000 |
| user | Basic | 1,000 | 20 |
| user | Premium | 5,000 | 200 |

## Data model

- `plans`: rule sets. Predefined plans have no owner and are read-only; custom plans belong to one account.
- `accounts`: one API key each (stored as a SHA-256 hash), one account plan.
- `users`: belong to an account, identified by the caller's `external_id`, one user plan.
- `account_usage` / `user_usage`: consumed units per UTC month (counters, so a decision touches two small rows regardless of history size).
- `request_log`: every request, accepted or rejected, with the plans and limits that were applied.

The database enforces: plan kinds, plan ownership (an account can only use predefined plans or its own), and that a user and the account in usage and log rows belong together. Checks and foreign keys live in the schema; see the comments in `service/src/db/schema.ts`.

## Product assumptions and decisions

1. One resource: "units" (for example document-processing credits).
2. A month is a UTC calendar month. Usage rows are keyed by the first day of the month.
3. A plan limit of `NULL` means "no limit" for that rule.
4. When several rules would reject a request, one is reported in a fixed order: user per-request, account per-request, user monthly, account monthly. Per-request violations come first because retrying or waiting can never fix them.
5. If a plan is edited so the allowance falls below what was already consumed, remaining shows 0 and further consumption is rejected at that level.
6. Plan edits apply to new requests. Switching plans never resets usage, because usage is stored per user and month, not per plan.
7. Every logged decision stores the limits it was made under, so history stays explainable after a plan changes.
8. Custom plans are private to their account. Predefined plans are shared and read-only.
9. Deleting a user or a custom plan is a soft delete. A deleted user keeps its usage and history; registering the same `external_id` again re-activates the same row, so delete and re-register cannot be used to get a fresh allowance. An archived plan keeps working for whoever already uses it but cannot be assigned to anyone new.
10. `updated_at` values come from the database clock so they stay consistent when the app server clock drifts.
11. A requestId is unique per account. Retrying the same user and units returns the original decision (`replayed: true`) and counts the units once. The same requestId with a different user or amount is rejected with 409.
12. Each consume runs in one database transaction that locks the account usage row and then the user usage row (always in that order). The decision is made under the locks, so concurrent requests can never exceed an allowance. The cost: requests of one account are processed one after another.
13. Plans are read after the locks are taken, so a decision uses the plans as they are at decision time, and the request log stores the limits that were applied.
14. A user that does not exist in the calling account returns 404 (the same answer for another account's user, so nothing leaks). A soft-deleted user returns 410.
15. API keys are random (256 bits), shown once at account creation, and only their SHA-256 hash is stored. A fast hash is enough because the key cannot be guessed, and it allows looking the account up through a unique index on every request (bcrypt-style salted hashes would not).
16. Predefined plans are read-only (403 `plan_read_only`). Another account's plan is a 404, the same answer as a plan that does not exist.
17. "Deleting" a custom plan archives it. Current users keep it, nobody new can get it, and its name stays reserved.
18. Any account may pick any predefined plan for itself or its users; billing is out of scope.
19. `/usage` computes `remaining` from the plan limits in force now, also for past months. The limits that applied at each decision are in `/history`.
20. A deleted user with usage in the requested month is still listed in `/usage` (marked `deleted`) so users add up to the account total; one without usage is hidden.
21. Reads take no locks, so they never slow consumes down. Numbers are as of the moment each query ran.
22. History cursors keep `created_at` as microsecond text plus the row id, so pages never skip or repeat a row.

## Known limitations

- One API key per account; no rotation or multiple keys.
- Accounts cannot be deleted.
- Units are stored as 64-bit integers but handled as JavaScript numbers (exact up to 2^53).
- All requests of one account serialize on that account's usage row (the shared allowance requires it). Measured in the performance section once available.

## Example client

A small web page (plain Node, no dependencies) that calls the service with an account's API key on behalf of three users. The browser only talks to the client's own server, so the API key never reaches it.

    docker compose up --build
    open http://localhost:4000

On start the client creates a demo account: a small account plan (100 / month, 50 per request) and users `alice` and `carol` on "Demo Basic" (80 / 20) and `bob` on "Demo Premium" (500 / 50). **Reset demo** creates a new account with a new key (old demo accounts stay in the database).

Walkthrough: (1) alice 10 is accepted; (2) alice 25 is rejected by her per-request limit; (3) bob's requests are rejected by the shared account allowance although he has his own allowance left; (4) raise "Demo Basic" to 50 per request or switch alice to "Demo Premium", repeat (2), and the outcome changes without any client change.

Without Docker: run the service, then `cd client && node src/server.mjs` (set `SERVICE_URL` and `ADMIN_TOKEN` if they differ from the defaults).

## Status

- [x] Schema, migrations, predefined plans
- [x] Rule evaluation (pure functions) with unit tests
- [x] Database constraint tests
- [x] Docker Compose (service and database; client to be added)
- [x] Consume (transaction, locking, idempotency) with concurrency tests
- [x] API-key auth, error handling, account isolation tests
- [x] Accounts, users, custom plans, plan assignment, archiving
- [x] Usage and history endpoints (pagination, past months)
- [x] Example client
- [x] Load tests (k6) and results
- [ ] Full API reference
