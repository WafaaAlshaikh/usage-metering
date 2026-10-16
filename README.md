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

<!-- ## Endpoints (summary)

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

Errors always look like `{ "error": { "code", "message", "details"? } }`. A rejected consume is HTTP 200 with `accepted: false` and the rule that blocked it. -->

## API reference

Base URL `http://localhost:3000`. All bodies are JSON. Every route except `GET /health` and `POST /accounts` needs the header `x-api-key: <key>`. `POST /accounts` needs `x-admin-token: <ADMIN_TOKEN>` when that variable is set (the Compose file sets `dev-admin-token`).

The examples use `curl` (on Windows PowerShell write `curl.exe`, and put JSON in a here-string or escape the quotes).

### Get an API key

```bash
curl -s -X POST localhost:3000/accounts \
  -H 'content-type: application/json' -H 'x-admin-token: dev-admin-token' \
  -d '{"name":"Acme"}'
```

```json
{ "id": "…", "name": "Acme", "apiKeyPrefix": "mk_5Zq1a", "planId": "…", "createdAt": "…", "apiKey": "mk_…" }
```

The raw `apiKey` is shown **once**; only its SHA-256 hash is stored. The account starts on the predefined `Starter` plan; pass `"planName":"Pro"` to start on another predefined account plan. The key identifies the calling account on every later request, so an account can only see and change its own data.

```bash
KEY=mk_...   # paste the key
```

### Users

```bash
# register (default plan: Basic; or pass a planId of a predefined user plan or one of your own)
curl -s -X POST localhost:3000/users -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"alice"}'
# → 201 {"userId":"alice","planId":"…","createdAt":"…","reactivated":false}

curl -s "localhost:3000/users?limit=50" -H "x-api-key: $KEY"        # {"users":[…],"nextCursor":null|"<last userId>"}
curl -s localhost:3000/users/alice -H "x-api-key: $KEY"             # user with its current plan and limits
curl -s -X PUT localhost:3000/users/alice/plan -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"planId":"<plan id>"}'
curl -s -X DELETE localhost:3000/users/alice -H "x-api-key: $KEY"   # 204, soft delete
```

Next page of `/users`: `?after=<nextCursor>`. Registering an existing active `externalId` is a 409 `user_exists`; registering a deleted one re-activates it with its old usage (`reactivated: true`).

### Plans

A plan has a `kind` (`account` or `user`), a `name`, and two optional limits: `monthlyAllowance` and `maxUnitsPerRequest`. `null` means "no limit".

```bash
curl -s "localhost:3000/plans?kind=user" -H "x-api-key: $KEY"       # predefined + your own (?includeArchived=true to see archived)
curl -s -X POST localhost:3000/plans -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"kind":"user","name":"Gold","monthlyAllowance":2000,"maxUnitsPerRequest":100}'
curl -s -X PATCH localhost:3000/plans/<id> -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"maxUnitsPerRequest":50}'                                    # missing field = unchanged, null = remove the limit
curl -s -X DELETE localhost:3000/plans/<id> -H "x-api-key: $KEY"    # archives it
curl -s -X PUT localhost:3000/account/plan -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"planId":"<account plan id>"}'
curl -s localhost:3000/account -H "x-api-key: $KEY"                 # the account and its current plan
```

Predefined plans are read-only (403 `plan_read_only`). Another account's plan behaves like a plan that does not exist (404). Several users can share one plan; each keeps its own usage.

### Consume

```bash
curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"alice","units":10,"requestId":"doc-8841"}'
```

```json
{
  "requestId": "doc-8841", "userId": "alice", "units": 10,
  "accepted": true, "replayed": false, "period": "2026-10", "rejection": null,
  "account": { "planId": "…", "limits": { "monthlyAllowance": 10000, "maxUnitsPerRequest": 100 }, "remaining": 9990 },
  "user":    { "planId": "…", "limits": { "monthlyAllowance": 1000,  "maxUnitsPerRequest": 20 },  "remaining": 990 }
}
```

`units` must be a positive whole number (at most 10^12). A rejection is still HTTP **200**: the call worked and the decision is in the body.

```json
{ "accepted": false, "rejection": { "scope": "user", "rule": "max_per_request" }, "…": "…" }
```

`scope` is `account` or `user`; `rule` is `max_per_request` or `monthly_allowance`. A rejection consumes nothing, and `remaining` is what is left after the decision. The `limits` shown are the ones the decision was made under.

### Usage and history

```bash
curl -s "localhost:3000/usage?period=2026-09&limit=100" -H "x-api-key: $KEY"
curl -s "localhost:3000/history?accepted=false&userId=alice&limit=20" -H "x-api-key: $KEY"
```

`/usage` (default: current UTC month) returns the account's `consumed`/`remaining` and a page of its users (`?limit`, `?after=<last userId>`; the account totals repeat on every page). `/history` lists decisions newest first, filters `userId`, `period`, `accepted`, pages with `?cursor=<nextCursor>`, and every row carries the plans and limits that applied at that moment.

### Errors

Always `{ "error": { "code": "…", "message": "…", "details": … } }`.

| HTTP | code | When |
|---|---|---|
| 400 | `validation_error` / `bad_request` | Bad body, query, period, cursor, or malformed JSON |
| 401 | `unauthorized` | Missing or wrong API key (or admin token); same answer for both |
| 403 | `plan_read_only` | Editing or archiving a predefined plan |
| 404 | `not_found` | Unknown route, user, or plan (including other accounts' users and plans) |
| 409 | `idempotency_conflict` | Same `requestId` with a different user or units |
| 409 | `user_exists`, `plan_archived`, `plan_name_taken` | Conflicts on registration, assignment, naming |
| 410 | `gone` | The user was deleted |
| 500 | `internal_error` | A bug; details are logged, never returned |

## Retries and idempotency

`requestId` is the idempotency key, unique per account. Send the same `requestId` again (same user, same units) after a timeout or a network error and you get the original decision back with `replayed: true`; the units are counted once, even if retries arrive at the same moment. A rejected request is replayed as the same rejection.

Reusing a `requestId` for a different user or amount is a client bug, not a retry, and returns 409 `idempotency_conflict`. Use a new `requestId` for every new action; a request that was rejected is not "retried" by sending it again with the same id.

How it stays correct: each consume is one database transaction that locks the account's usage row and then the user's (always in that order, so requests cannot deadlock), checks the `requestId`, reads the plans, decides, updates both counters, and writes the log row. Either everything is stored or nothing is. The database also enforces `UNIQUE (account_id, request_id)` as a last line of defence; the rare race where the same `requestId` arrives on both sides of a month boundary is handled by one internal re-run that finds and replays the first result.

## Changing plans and rules

- An edit (`PATCH /plans/:id`) is a single `UPDATE`; the next consume that takes its locks sees the new limits. Editing a custom plan affects every account or user assigned to it, with no redeploy and no client change.
- Switching a plan (`PUT /users/:id/plan`, `PUT /account/plan`) keeps the usage already consumed: counters belong to the user/account and the month, not to the plan. It never gives a fresh allowance.
- If an allowance is reduced below what was already consumed, `remaining` shows 0 and further consumption at that level is rejected until the next month or until the allowance is raised.
- History is never rewritten: each logged decision stores the plan ids and limits it was made under.
- Archiving a plan ("deleting" it) leaves current users on it, keeps their history, and blocks assigning it to anyone new.

### Rules and how they combine

Two rule types, for both account and user plans: `monthly_allowance` (units per UTC calendar month) and `max_per_request`. A request is accepted only if **all four** checks pass (user and account, each with both rules). The reported reason is the first failing check in this order: user per-request, account per-request, user monthly, account monthly. No further rule types were added: a reliable, well-explained core was preferred. A new rule would be one more pure check in `domain/rules.ts` (covered by unit tests without a database) plus a column on `plans` and on the logged limits.

## Main design decisions

- **Counters instead of summing the log.** `account_usage` and `user_usage` hold consumed units per month, so a decision touches two small rows however much history exists. The log is the audit trail and the idempotency record.
- **Correctness through row locks.** Locking the account counter then the user counter inside one transaction makes concurrent decisions exact. The price is that requests of one account run one after another (see Performance); different accounts run in parallel.
- **A pure decision function.** `domain/rules.ts` has no database or clock, so every rule combination is unit tested directly.
- **The database enforces ownership.** Plan kind, plan ownership, and "this user belongs to this account" are foreign keys and checks, so a bug in the service cannot create cross-account data. Tests attack these constraints directly.
- **Layers.** `http/` (routes, validation, auth, error mapping) → `services/` (transactions and business flow) → `repo/` (queries) → `domain/` (pure rules, errors, periods).
- **API keys:** 256-bit random, only the SHA-256 hash stored, looked up through a unique index on every request.


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

- One API key per account; no rotation or revocation.
- `POST /accounts` is open when `ADMIN_TOKEN` is not set (convenient locally; always set it elsewhere). Accounts cannot be deleted or renamed.
- Any account may pick any predefined plan; there is no billing or approval.
- No rate limiting on the API itself, and request history is kept forever (no retention or archiving).
- Units are 64-bit in the database but JavaScript numbers in the service (exact up to 2^53); requests are capped at 10^12 units.
- All requests of one account serialise on its usage row. That is required for an exact shared allowance and was measured (see Performance).
- The month of a request comes from the service's clock (UTC); other timestamps come from the database clock. With several service instances, clock drift could assign a request near midnight UTC to the neighbouring month.
- `/usage` computes `remaining` from the current plan limits, also for past months; `/history` has the limits of the time.
- Reads are not locked: usage numbers are as of the moment each query ran.
- Performance numbers are single runs on a shared laptop.

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
