# Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether their users may perform an action. Accounts and their users each have a plan; every request must satisfy both.

> Work in progress. This file is updated with every set of commits; see "Status" at the bottom.

## Stack

TypeScript, Fastify, PostgreSQL, Drizzle ORM, Zod, Vitest, k6, Docker Compose.

## Run locally (current state)

Prerequisites: Node 22+, Docker.

    docker run --name metering-db -e POSTGRES_USER=metering -e POSTGRES_PASSWORD=metering -e POSTGRES_DB=metering -p 5434:5432 -d postgres:16-alpine
    cd service
    npm install
    $env:DATABASE_URL = "postgres://metering:metering@localhost:5434/metering"   (PowerShell)
    npm run dev

On start the service applies the migrations and seeds the predefined plans (safe to repeat). `GET /health` returns `{"status":"ok"}`.

## Tests

    docker exec metering-db psql -U metering -d postgres -c "create database metering_test"
    cd service
    npm test

Integration tests run against a real PostgreSQL database whose name must end in `_test` (they wipe it). Override with `TEST_DATABASE_URL`.

## How a request is decided

Two rule types exist for both account plans and user plans: a monthly allowance (units per UTC calendar month) and a maximum per request. A request is accepted only if every rule of both plans allows the full amount; a rejection consumes nothing. Accepted units are added to both the user's and the account's usage for the current UTC month.

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

## Known limitations

- One API key per account; no rotation or multiple keys.
- Accounts cannot be deleted.
- Units are stored as 64-bit integers but handled as JavaScript numbers (exact up to 2^53).
- All requests of one account serialize on that account's usage row (the shared allowance requires it). Measured in the performance section once available.

## Status

- [x] Schema, migrations, predefined plans
- [x] Rule evaluation (pure functions) with unit tests
- [x] Database constraint tests
- [ ] Docker Compose
- [ ] Consume endpoint (transaction, locking, idempotency)
- [ ] Accounts, users, plans API and API-key auth
- [ ] Usage and history endpoints
- [ ] Example client
- [ ] Load tests (k6) and results
- [ ] Full API reference