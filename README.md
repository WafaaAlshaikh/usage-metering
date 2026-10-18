<p align="center">
  <img
    src="docs/images/account-quota-header.png"
    width="100%"
    alt="A shared account quota"
  >
</p>

<h1 align="center">Usage Metering &amp; Quota Service</h1>

<p align="center">
  Shared account limits. Individual user quotas. Safe retries.
</p>

<p align="center">
  <a href="#example-client">Demo</a> ·
  <a href="#run-with-docker-compose">Quick Start</a> ·
  <a href="#interactive-api-documentation">Swagger</a> ·
  <a href="#api-reference">API Reference</a> ·
  <a href="#tests">Tests</a> ·
  <a href="#performance">Performance</a>
</p>

<p align="center">
  <img
    src="docs/images/user-quotas-footer.png"
    width="100%"
    alt="Individual user quotas within a shared account"
  >
</p>

## Overview

A backend service that applications call to track usage and decide whether a user can perform an action.

Each account has a shared quota, and each user has an individual quota. A request is accepted only when **both plans allow the full amount**. Accepted requests update both usage counters; rejected requests consume nothing.

For example, a document-processing application can check whether a user has enough credits before processing a document, while also enforcing the company's shared monthly allowance.

Plans can be configured through the API without redeploying the service. Usage and decision history are stored in PostgreSQL.

## Engineering Highlights

- **Two-level quota enforcement:** monthly allowances and per-request limits for both accounts and individual users.
- **Atomic accounting:** account usage, user usage, and the recorded decision are updated in one database transaction.
- **Safe retries:** repeated request IDs replay the saved decision without consuming units again, even after the user was deleted.
- **Concurrency protection:** PostgreSQL row locks prevent competing requests from overspending a shared allowance.
- **Explainable decisions:** the plan limits applied to each decision are preserved, even after plans change.
- **Verification under load:** automated tests and k6 workloads, followed by a per-account, per-user, per-month consistency check.

<details>
<summary><strong>Table of Contents</strong></summary>

- [Overview](#overview)
- [Engineering Highlights](#engineering-highlights)
- [Stack](#stack)
- [Model](#model)
- [Run with Docker Compose](#run-with-docker-compose)
- [Run locally](#run-locally-without-docker-for-the-service)
- [Tests](#tests)
- [How a request is decided](#how-a-request-is-decided)
- [Interactive API documentation](#interactive-api-documentation)
- [API reference](#api-reference)
- [Retries and idempotency](#retries-and-idempotency)
- [Changing plans and rules](#changing-plans-and-rules)
- [Main design decisions](#main-design-decisions)
- [Data model](#data-model)
- [Product assumptions and decisions](#product-assumptions-and-decisions)
- [Predefined plans](#predefined-plans)
- [Performance](#performance)
- [Known limitations](#known-limitations)
- [Example client](#example-client)
- [Project status](#project-status)

</details>

## Stack

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-202020?style=for-the-badge&logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-17212B?style=for-the-badge&logo=drizzle&logoColor=C5F74F)
![Zod](https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge&logo=zod&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-252529?style=for-the-badge&logo=vitest&logoColor=6E9F18)
![k6](https://img.shields.io/badge/k6-7D64FF?style=for-the-badge&logo=k6&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)

## Model

- **Account:** The application using the metering service.
- **User:** An end user belonging to an account.
- **Plan:** Defines usage limits and rules for an account or user.
- **Units:** The single resource being metered.

Account and user plans apply together. A request is accepted only if it satisfies both sets of limits.

## Run with Docker Compose

```bash
docker compose up --build
```

This starts PostgreSQL, the service (port 3000, with Swagger at `/docs/`) and the example client (port 4000). The service applies the migrations and seeds the predefined plans on start. `ADMIN_TOKEN` defaults to `dev-admin-token` in the Compose file. Data lives in the named volume `pgdata` and survives `docker compose down` and restarts; only `docker compose down -v` deletes it.

```bash
curl http://localhost:3000/health
```

Settings have defaults inside `docker-compose.yml`.

## Run locally (without Docker for the service)

Prerequisites: Node 22.12+ (tested on 24), Docker (for PostgreSQL only).

```powershell
docker run --name metering-db -e POSTGRES_USER=metering -e POSTGRES_PASSWORD=metering -e POSTGRES_DB=metering -p 5434:5432 -d postgres:16-alpine
cd service
npm install
$env:DATABASE_URL = "postgres://metering:metering@localhost:5434/metering"
npm run dev
```

On start the service applies the migrations and seeds the predefined plans (safe to repeat). Stop the Compose service first, because both use port 3000. For local settings copy `service/.env.example` to `service/.env`.

## Tests

Unit tests need no database:

```bash
cd service && npm run test:unit
```

Integration tests need a disposable PostgreSQL database. The tests wipe it, and its name must end in `_test`. They use the container from "Run locally" (port 5434), not the Compose database:

```bash
docker run --name metering-db -e POSTGRES_USER=metering -e POSTGRES_PASSWORD=metering -e POSTGRES_DB=metering -p 5434:5432 -d postgres:16-alpine
docker exec metering-db psql -U metering -d postgres -c "create database metering_test"
cd service && npm run test:integration
```

`npm test` runs both. If integration tests fail with `ECONNREFUSED ...:5434`, the container is not running: `docker start metering-db`. Override the database with `TEST_DATABASE_URL`.

## How a request is decided

Two rule types exist for both account plans and user plans: a monthly allowance (units per UTC calendar month) and a maximum per request. A request is accepted only if every rule of both plans allows the full amount; a rejection consumes nothing. Accepted units are added to both the user's and the account's usage for the current UTC month.

## Interactive API documentation

When the full service is running, open **http://localhost:3000/docs/** for Swagger UI.
Every business endpoint is documented, including request constraints, response
schemas, pagination, errors, and accepted/rejected/replayed consumption examples.

- Download OpenAPI JSON: http://localhost:3000/openapi.json
- Download OpenAPI YAML: http://localhost:3000/openapi.yaml
- Import either file into Postman or another OpenAPI-compatible client.

Create an account, save the returned API key, then use **Authorize → ApiKey** and
paste the raw key (without a `Bearer` prefix). When `ADMIN_TOKEN` is configured,
use **AdminToken** for account creation. Real keys are never embedded in the
specification, and Swagger UI does not persist authorization across page reloads.
The documentation pages themselves are public and need no key.

**Try it out sends real requests.** It can create records, change plans, delete
users, and consume units. Use a disposable demo account. A quota rejection is
HTTP 200 with `accepted: false`; it is not a failed HTTP request.

For a documentation-only preview without PostgreSQL:

```bash
cd service
npm install
npm run docs:preview
```

Open http://localhost:5000/docs/. This mode disables **Try it out** and does not
start the metering API. It assumes admin-protected provisioning for illustration.
Run the full service to execute requests; its specification reflects whether
`ADMIN_TOKEN` is actually configured.

Request schemas are generated from the existing Zod definitions. Response schemas
and descriptions live in `service/src/http/docs/`; they do not replace runtime
validation or install response serializers. When changing an endpoint, update its
documentation and run `npx vitest run tests/unit/docs.test.ts` from `service/`.

## API reference

Base URL `http://localhost:3000`. All bodies are JSON. Every route except `GET /health`, `POST /accounts` and the documentation pages needs the header `x-api-key: <key>`. `POST /accounts` needs `x-admin-token: <ADMIN_TOKEN>` when that variable is set (the Compose file sets `dev-admin-token`).

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
curl -s -X DELETE localhost:3000/plans/<id> -H "x-api-key: $KEY"   # archives it
curl -s -X PUT localhost:3000/account/plan -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"planId":"<account plan id>"}'
curl -s localhost:3000/account -H "x-api-key: $KEY"                # the account and its current plan
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
| 410 | `gone` | New consumption for a deleted user |
| 500 | `internal_error` | A bug; details are logged, never returned |
| 503 | `busy` | Connection pool or row-lock wait timed out under overload. `Retry-After: 1`; retrying with the same `requestId` is safe |

## Retries and idempotency

`requestId` is the idempotency key, unique per account. Send the same `requestId` again (same user, same units) after a timeout or a network error and you get the original decision back with `replayed: true`; the units are counted once, even if retries arrive at the same moment. A rejected request is replayed as the same rejection. A saved result is returned even if the user was deleted afterwards; new consumption for a deleted user is still refused (410).

Reusing a `requestId` for a different user or amount is a client bug, not a retry, and returns 409 `idempotency_conflict`. Use a new `requestId` for every new action; a request that was rejected is not "retried" by sending it again with the same id. A 503 means nothing was counted: retry with the same `requestId`.

How it stays correct: each consume is one database transaction that locks the account's usage row and then the user's (always in that order, so requests cannot deadlock), checks the `requestId`, reads the plans, decides, updates both counters, and writes the log row. Either everything is stored or nothing is. The database also enforces `UNIQUE (account_id, request_id)` as a last line of defence; the rare race where the same `requestId` arrives on both sides of a month boundary is handled by one internal re-run that finds and replays the first result.

## Changing plans and rules

- An edit (`PATCH /plans/:id`) is a single `UPDATE`; the next consume that takes its locks sees the new limits. Editing a custom plan affects every account or user assigned to it, with no redeploy and no client change.
- A request's plans are fixed when it gets the usage locks: an update that completed before that moment applies to it, one that completes later applies to the next request.
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
- **Layers.** `http/` (routes, validation, auth, error mapping, OpenAPI docs) → `services/` (transactions and business flow) → `repo/` (queries) → `domain/` (pure rules, errors, periods).
- **API keys:** 256-bit random, only the SHA-256 hash stored, looked up through a unique index on every request.

## Data model

- `plans`: rule sets. Predefined plans have no owner and are read-only; custom plans belong to one account.
- `accounts`: one API key each (stored as a SHA-256 hash), one account plan.
- `users`: belong to an account, identified by the caller's `external_id`, one user plan.
- `account_usage` / `user_usage`: consumed units per UTC month (counters, so a decision touches two small rows regardless of history size).
- `request_log`: every request, accepted or rejected, with the plans and limits that were applied.

The database enforces: plan kinds, plan ownership (an account can only use predefined plans or its own), that a user and the account in usage and log rows belong together, and that counters never exceed 2^53 - 1. Checks and foreign keys live in the schema; see the comments in `service/src/db/schema.ts`.

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
11. A requestId is unique per account. Retrying the same user and units returns the original decision (`replayed: true`) and counts the units once, even if the user was deleted in between. The same requestId with a different user or amount is rejected with 409.
12. Each consume runs in one database transaction that locks the account usage row and then the user usage row (always in that order). The decision is made under the locks, so concurrent requests can never exceed an allowance. The cost: requests of one account are processed one after another.
13. Plans are read after the locks are taken, so a decision uses the plans as they are at decision time, and the request log stores the limits that were applied. A request's plans are fixed when it gets the locks: a plan update that completed before that moment applies to it, one that completes later applies to the next request.
14. A user that does not exist in the calling account returns 404 (the same answer for another account's user, so nothing leaks). New consumption for a soft-deleted user returns 410.
15. API keys are random (256 bits), shown once at account creation, and only their SHA-256 hash is stored. A fast hash is enough because the key cannot be guessed, and it allows looking the account up through a unique index on every request (bcrypt-style salted hashes would not).
16. Predefined plans are read-only (403 `plan_read_only`). Another account's plan is a 404, the same answer as a plan that does not exist.
17. "Deleting" a custom plan archives it. Current users keep it, nobody new can get it, and its name stays reserved.
18. Any account may pick any predefined plan for itself or its users; billing is out of scope.
19. `/usage` computes `remaining` from the plan limits in force now, also for past months. The limits that applied at each decision are in `/history`.
20. A deleted user with usage in the requested month is still listed in `/usage` (marked `deleted`) so users add up to the account total; one without usage is hidden.
21. Reads take no row locks, so they never slow consumes down. Each `/usage` response is read in one repeatable-read snapshot, so the listed users add up to the account total even while consumes run.
22. History cursors keep `created_at` as microsecond text plus the row id, so pages never skip or repeat a row.
23. `request_log.created_at` is taken with `clock_timestamp()` while the usage locks are held, so history order equals decision order (`now()` would be the start of the transaction, before waiting for the lock).
24. When the service is overloaded (no database connection within 5 s, a lock wait over 5 s, or a statement over 15 s) it answers 503 `busy` instead of hanging. Because `requestId` is idempotent, the caller can retry safely.
25. The month of a request is the month at the moment it is decided (when it holds the usage locks), read from the database clock. A request that waits for a lock across midnight UTC is re-run on the new month's counters, so its counters, response period and history row always agree.
26. The OpenAPI document is written by hand from the existing Zod request schemas and is used only for documentation; it never validates or serialises live traffic. The documentation pages are public, like `/health`.

## Predefined plans

| Kind | Name | Monthly allowance | Max per request |
|---|---|---:|---:|
| account | Starter | 10,000 | 100 |
| account | Pro | 1,000,000 | 1,000 |
| user | Basic | 1,000 | 20 |
| user | Premium | 5,000 | 200 |

## Performance

Load tested with [k6](https://k6.io) on a laptop (6 cores shared by k6, the service and PostgreSQL). Method, commands and every run: [`perf/README.md`](perf/README.md).

Current code (month decided at lock time), k6 on the host, 20 VUs for 30 s, every request accepted:

| Scenario | consumes/s | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| One hot account (20 users) | ~62 | 54 ms | 1583 ms | 2659 ms |
| 50 accounts (5 users each) | ~164 | 112 ms | 187 ms | 264 ms |

- The same load spread over 50 accounts gives 2 to 3x the throughput and a much lower p95 than hitting one account. Requests of one account are serialised on its shared usage counter; that is what keeps the shared allowance exact under concurrency. Requests of different accounts do not wait for each other.
- Deciding the month at lock time (see assumption 25) cost roughly 13% to 21% throughput compared with the earlier code (different session, so approximate). We kept it for correctness.
- Removing round trips earlier (about 10 queries per consume down to 7) gave, back to back in one session, +25% throughput and a p95 cut by more than half on the hot account, and +39% on 50 accounts (single runs).
- Absolute numbers on this laptop varied about 2x between sessions; compare runs only within a session. All series are in `perf/README.md`.
- A mixed workload (quota rejections, repeated `requestId`s, and a plan edit every second under load) ran at ~85 consumes/s. Afterwards `perf/verify.mjs` confirmed, per account, user and month, that counters equal the accepted units in the log and that each account equals the sum of its users.
- Concurrency is also covered by automated tests (200 parallel requests never exceed an allowance; 20 parallel retries count once).
- Under overload the service answers 503 (`Retry-After`) instead of queueing forever; a retry with the same `requestId` is safe.

## Known limitations

- One API key per account; no rotation or revocation.
- `POST /accounts` is open when `ADMIN_TOKEN` is not set (convenient locally; always set it elsewhere). Accounts cannot be deleted or renamed.
- Any account may pick any predefined plan; there is no billing or approval.
- No rate limiting on the API itself, and request history is kept forever (no retention or archiving).
- Usage counters are 64-bit in the database but JavaScript numbers in the service. A CHECK constraint keeps each counter at or below 2^53 - 1, so precision is never lost silently; the database refuses the write instead (reaching it would take about 9,000 requests of the 10^12 cap).
- All requests of one account serialise on its usage row. That is required for an exact shared allowance and was measured (see Performance).
- `/usage` computes `remaining` from the current plan limits, also for past months; `/history` has the limits of the time.
- Migrations run on service start. Starting several instances at the same moment could race; run a single instance, or migrate before scaling out.
- Swagger "Try it out" and the example client's API explorer send real requests; the client's `/api/proxy` forwards any service route with the demo account's key. They are test tools, not for production.
- Performance numbers are single runs on a shared laptop; the load generator competes with the service and the database for CPU.

## Example client

A small web page (plain Node, no dependencies) with two tabs: a **Guided demo** and an **API explorer** that can call every endpoint. The browser only talks to the client's own server, which forwards requests to the service with the demo account's key, so the key never reaches the browser.

The Dashboard tab lets you use every endpoint through forms and buttons (accounts, users, plans, consume, usage, history)

```bash
docker compose up --build
open http://localhost:4000      # Windows: start http://localhost:4000
```

On start the client creates a demo account: a small account plan (100 / month, 50 per request) and users `alice` and `carol` on "Demo Basic" (80 / 20) and `bob` on "Demo Premium" (500 / 50). **Reset demo** creates a new account with a new key (old demo accounts stay in the database).

Walkthrough:

1. "alice consumes 10" is accepted.
2. "alice consumes 25" is rejected by her per-request limit (25 > 20), although both monthly allowances have room.
3. "bob consumes 50 until the shared limit stops it": his own allowance (500) has room, but the shared account allowance (100) runs out. This button uses up the whole demo account, so it starts a fresh demo account first.
4. Press **Reset demo**, then "Raise Demo Basic to 50 per request" or "Switch alice to Demo Premium", and run "alice consumes 25" again: it is now accepted, with no change in the client code. Plan changes apply to the current account, so run the alice buttons before and after the change.

In the **API explorer** you can also test error cases: choose "No key" or "Wrong key" to see 401, send a malformed JSON body to see 400, reuse a fixed `requestId` to see a replay, or change the units under the same `requestId` to see 409.

Without Docker: run the service, then `cd client && node src/server.mjs` (set `SERVICE_URL` and `ADMIN_TOKEN` if they differ from the defaults).

## Project status

All required parts are implemented:

- Account and user quota enforcement using monthly and per-request limits.
- Transactional consumption with PostgreSQL row locking and idempotency.
- API-key authentication and account-level data isolation.
- Custom plans, usage tracking, and audit history.
- Interactive OpenAPI documentation (Swagger UI) for every endpoint.
- Unit, integration, database constraint, concurrency and overload tests.
- Docker Compose setup, an example client, and k6 performance tests with a correctness check.