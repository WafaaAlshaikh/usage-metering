import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema overview
 * ---------------
 * plans          rule sets. account_id IS NULL => predefined (read-only, shared by everyone).
 *                A NULL limit means "no limit for this rule".
 * accounts       calling applications. Holds the hashed API key and the assigned account plan.
 * users          end users of an account. `external_id` is the id the calling app uses.
 * account_usage  consumed units per (account, UTC month). The shared counter.
 * user_usage     consumed units per (user, UTC month).
 * request_log    one row per consume request (accepted or rejected). Also the idempotency
 *                record: UNIQUE (account_id, request_id). Stores the limits that were applied,
 *                so history stays explainable after a plan is edited.
 *
 * Usage is stored as counters (not derived by SUM over request_log) so a decision only has to
 * touch two small rows no matter how much history exists.
 *
 * Months are stored as the first day of the UTC month (a real `date`), e.g. 2026-10-01.
 */

export const planKind = pgEnum('plan_kind', ['account', 'user']);
export const ruleScope = pgEnum('rule_scope', ['account', 'user']);
export const ruleType = pgEnum('rule_type', ['max_per_request', 'monthly_allowance']);

const periodColumn = (name: string) => date(name, { mode: 'string' }).notNull();
const isFirstOfMonth = (col: AnyPgColumn) => sql`extract(day from ${col}) = 1`;

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL for predefined plans, otherwise the owning account.
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    kind: planKind('kind').notNull(),
    name: text('name').notNull(),
    monthlyAllowance: bigint('monthly_allowance', { mode: 'number' }),
    maxUnitsPerRequest: bigint('max_units_per_request', { mode: 'number' }),
    isPredefined: boolean('is_predefined').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target for the composite foreign keys below (lets the DB check a plan's kind).
    unique('plans_id_kind_uq').on(t.id, t.kind),
    uniqueIndex('plans_custom_name_uq')
      .on(t.accountId, t.kind, t.name)
      .where(sql`${t.accountId} is not null`),
    uniqueIndex('plans_predefined_name_uq')
      .on(t.kind, t.name)
      .where(sql`${t.accountId} is null`),
    index('plans_account_idx').on(t.accountId),
    check('plans_allowance_nonneg', sql`${t.monthlyAllowance} is null or ${t.monthlyAllowance} >= 0`),
    check('plans_max_positive', sql`${t.maxUnitsPerRequest} is null or ${t.maxUnitsPerRequest} > 0`),
    check('plans_predefined_has_no_owner', sql`${t.isPredefined} = (${t.accountId} is null)`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // SHA-256 of the API key. The key itself is shown once at creation and never stored.
    apiKeyHash: text('api_key_hash').notNull(),
    // First characters of the key, to help humans recognise which key is which.
    apiKeyPrefix: text('api_key_prefix').notNull(),
    accountPlanId: uuid('account_plan_id').notNull(),
    // Always 'account'. Together with the composite FK below, the database itself refuses to
    // assign a user-kind plan to an account.
    accountPlanKind: planKind('account_plan_kind').notNull().default('account'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_api_key_hash_uq').on(t.apiKeyHash),
    foreignKey({
      name: 'accounts_plan_kind_fk',
      columns: [t.accountPlanId, t.accountPlanKind],
      foreignColumns: [plans.id, plans.kind],
    }),
    check('accounts_plan_kind_is_account', sql`${t.accountPlanKind} = 'account'`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // The identifier the calling application uses for this user.
    externalId: text('external_id').notNull(),
    userPlanId: uuid('user_plan_id').notNull(),
    // Always 'user' (see accounts.account_plan_kind).
    userPlanKind: planKind('user_plan_kind').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('users_account_external_uq').on(t.accountId, t.externalId),
    index('users_plan_idx').on(t.userPlanId),
    foreignKey({
      name: 'users_plan_kind_fk',
      columns: [t.userPlanId, t.userPlanKind],
      foreignColumns: [plans.id, plans.kind],
    }),
    check('users_plan_kind_is_user', sql`${t.userPlanKind} = 'user'`),
  ],
);

export const accountUsage = pgTable(
  'account_usage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // First day of the UTC month.
    periodStart: periodColumn('period_start'),
    consumed: bigint('consumed', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.periodStart] }),
    check('account_usage_consumed_nonneg', sql`${t.consumed} >= 0`),
    check('account_usage_period_is_month_start', isFirstOfMonth(t.periodStart)),
  ],
);

export const userUsage = pgTable(
  'user_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Denormalised so "all users of an account for a month" is a single index scan.
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    periodStart: periodColumn('period_start'),
    consumed: bigint('consumed', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.periodStart] }),
    index('user_usage_account_period_idx').on(t.accountId, t.periodStart),
    check('user_usage_consumed_nonneg', sql`${t.consumed} >= 0`),
    check('user_usage_period_is_month_start', isFirstOfMonth(t.periodStart)),
  ],
);

export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Caller-supplied idempotency key, unique per account.
    requestId: text('request_id').notNull(),
    units: bigint('units', { mode: 'number' }).notNull(),
    accepted: boolean('accepted').notNull(),
    // Set only when rejected: which side and which rule blocked the request.
    rejectedBy: ruleScope('rejected_by'),
    rejectedRule: ruleType('rejected_rule'),
    periodStart: periodColumn('period_start'),

    // Plans in force when the decision was made...
    accountPlanId: uuid('account_plan_id')
      .notNull()
      .references(() => plans.id),
    userPlanId: uuid('user_plan_id')
      .notNull()
      .references(() => plans.id),
    // ...and the limits they had at that moment (NULL = no limit). Plans can be edited later,
    // so the numbers are copied here to keep every past decision explainable.
    accountMonthlyAllowance: bigint('account_monthly_allowance', { mode: 'number' }),
    accountMaxPerRequest: bigint('account_max_per_request', { mode: 'number' }),
    userMonthlyAllowance: bigint('user_monthly_allowance', { mode: 'number' }),
    userMaxPerRequest: bigint('user_max_per_request', { mode: 'number' }),

    // Remaining monthly allowance right after the decision. NULL = unlimited.
    accountRemainingAfter: bigint('account_remaining_after', { mode: 'number' }),
    userRemainingAfter: bigint('user_remaining_after', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('request_log_account_request_uq').on(t.accountId, t.requestId),
    index('request_log_account_created_idx').on(t.accountId, t.createdAt.desc(), t.id.desc()),
    index('request_log_user_created_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    index('request_log_account_period_idx').on(t.accountId, t.periodStart),
    check('request_log_units_positive', sql`${t.units} > 0`),
    check(
      'request_log_rejection_consistent',
      sql`(${t.accepted} and ${t.rejectedBy} is null and ${t.rejectedRule} is null)
          or (not ${t.accepted} and ${t.rejectedBy} is not null and ${t.rejectedRule} is not null)`,
    ),
    check('request_log_period_is_month_start', isFirstOfMonth(t.periodStart)),
  ],
);

export type Plan = typeof plans.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type User = typeof users.$inferSelect;
export type RequestLogRow = typeof requestLog.$inferSelect;