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
 * Integrity enforced by the database itself (not only by service code):
 *  - a plan assigned to an account/user is of the right kind (account vs user);
 *  - a custom plan can only be assigned inside the account that owns it; predefined plans are
 *    available to everyone (see "owner key" below);
 *  - usage rows and request-log rows always pair a user with the account that user belongs to;
 *  - request_log can only reference an account-kind plan as the account plan and a user-kind
 *    plan as the user plan.
 * NOT enforced by the database (the service checks it): an archived plan must not be assigned to
 * anyone new. Existing assignments keep working.
 *
 * Owner key
 * ---------
 * "Plan is predefined OR owned by my account" cannot be written as a plain foreign key because
 * predefined plans have account_id = NULL. So plans get a generated `owner_key` (the owning
 * account id, or SYSTEM_OWNER_KEY for predefined plans), and accounts/users store the owner key
 * of the plan they use. A composite FK (plan_id, kind, owner_key) proves the stored key is the
 * plan's real owner, and a CHECK proves that owner is "me" or "system".
 *
 * Usage is stored as counters (not derived by SUM over request_log) so a decision only has to
 * touch two small rows no matter how much history exists.
 *
 * Months are stored as the first day of the UTC month (a real `date`), e.g. 2026-10-01.
 *
 * `updated_at` has no trigger: code that updates a row sets it, always from the DATABASE clock
 * (now()) so created_at/updated_at never disagree when the app server's clock drifts. Plans use
 * $onUpdate(now()); the usage counters set it in the single UPDATE statement that changes them.
 */

/** Owner key of predefined plans. Reserved: no account may use it as its id (see accounts). */
export const SYSTEM_OWNER_KEY = '00000000-0000-0000-0000-000000000000';

export const planKind = pgEnum('plan_kind', ['account', 'user']);
export const ruleScope = pgEnum('rule_scope', ['account', 'user']);
export const ruleType = pgEnum('rule_type', ['max_per_request', 'monthly_allowance']);
/** Largest integer a JavaScript number holds exactly (2^53 - 1). Counters may never pass it. */
export const MAX_SAFE_COUNTER = 9_007_199_254_740_991;

const periodColumn = (name: string) => date(name, { mode: 'string' }).notNull();
const isFirstOfMonth = (col: AnyPgColumn) => sql`extract(day from ${col}) = 1`;
const systemKey = sql.raw(`'${SYSTEM_OWNER_KEY}'::uuid`);

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
    // Set when a custom plan is "deleted". Archived plans keep working for whoever already uses
    // them, keep their history, and cannot be assigned to anyone new (checked by the service).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // account_id, or SYSTEM_OWNER_KEY when account_id is NULL. Computed by the database.
    ownerKey: uuid('owner_key')
      .notNull()
      .generatedAlwaysAs(sql`coalesce(account_id, '${sql.raw(SYSTEM_OWNER_KEY)}'::uuid)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    // Targets of the composite foreign keys below.
    unique('plans_id_kind_uq').on(t.id, t.kind),
    unique('plans_id_kind_owner_uq').on(t.id, t.kind, t.ownerKey),
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
    check('plans_predefined_not_archived', sql`not ${t.isPredefined} or ${t.archivedAt} is null`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // SHA-256 of the API key. The key itself is shown once at creation and never stored.
    // One key per account: rotation / multiple keys are out of scope (see README limitations).
    apiKeyHash: text('api_key_hash').notNull(),
    // First characters of the key, to help humans recognise which key is which.
    apiKeyPrefix: text('api_key_prefix').notNull(),
    accountPlanId: uuid('account_plan_id').notNull(),
    // Always 'account'. Together with the composite FK below, the database refuses to assign a
    // user-kind plan to an account.
    accountPlanKind: planKind('account_plan_kind').notNull().default('account'),
    // Owner key of the assigned plan: this account's id (custom plan) or SYSTEM_OWNER_KEY.
    accountPlanOwnerKey: uuid('account_plan_owner_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_api_key_hash_uq').on(t.apiKeyHash),
    foreignKey({
      name: 'accounts_plan_fk',
      columns: [t.accountPlanId, t.accountPlanKind, t.accountPlanOwnerKey],
      foreignColumns: [plans.id, plans.kind, plans.ownerKey],
    }),
    check('accounts_plan_kind_is_account', sql`${t.accountPlanKind} = 'account'`),
    check(
      'accounts_plan_owner_is_self_or_system',
      sql`${t.accountPlanOwnerKey} in (${t.id}, ${systemKey})`,
    ),
    check('accounts_id_not_system_owner', sql`${t.id} <> ${systemKey}`),
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
    // Owner key of the assigned plan: the user's account id (custom plan) or SYSTEM_OWNER_KEY.
    userPlanOwnerKey: uuid('user_plan_owner_key').notNull(),
    // Soft delete. The row, its usage and its history stay. The same external_id registering
    // again re-activates this row (keeps usage), so delete + re-register is not a way to get a
    // fresh allowance.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('users_account_external_uq').on(t.accountId, t.externalId),
    // Target of the composite foreign keys in user_usage and request_log.
    unique('users_id_account_uq').on(t.id, t.accountId),
    index('users_plan_idx').on(t.userPlanId),
    foreignKey({
      name: 'users_plan_fk',
      columns: [t.userPlanId, t.userPlanKind, t.userPlanOwnerKey],
      foreignColumns: [plans.id, plans.kind, plans.ownerKey],
    }),
    check('users_plan_kind_is_user', sql`${t.userPlanKind} = 'user'`),
    check(
      'users_plan_owner_is_own_account_or_system',
      sql`${t.userPlanOwnerKey} in (${t.accountId}, ${systemKey})`,
    ),
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
    check('account_usage_consumed_safe', sql`${t.consumed} <= ${sql.raw(String(MAX_SAFE_COUNTER))}`),
  ],
);

export const userUsage = pgTable(
  'user_usage',
  {
    userId: uuid('user_id').notNull(),
    // Denormalised so "all users of an account for a month" is a single index scan.
    // The composite FK below guarantees it is the account this user belongs to.
    accountId: uuid('account_id').notNull(),
    periodStart: periodColumn('period_start'),
    consumed: bigint('consumed', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.periodStart] }),
    foreignKey({
      name: 'user_usage_user_account_fk',
      columns: [t.userId, t.accountId],
      foreignColumns: [users.id, users.accountId],
    }),
    index('user_usage_account_period_idx').on(t.accountId, t.periodStart),
    check('user_usage_consumed_nonneg', sql`${t.consumed} >= 0`),
    check('user_usage_period_is_month_start', isFirstOfMonth(t.periodStart)),
    check('user_usage_consumed_safe', sql`${t.consumed} <= ${sql.raw(String(MAX_SAFE_COUNTER))}`),
  ],
);

export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    userId: uuid('user_id').notNull(),
    // Caller-supplied idempotency key, unique per account.
    requestId: text('request_id').notNull(),
    units: bigint('units', { mode: 'number' }).notNull(),
    accepted: boolean('accepted').notNull(),
    // Set only when rejected: which side and which rule blocked the request.
    rejectedBy: ruleScope('rejected_by'),
    rejectedRule: ruleType('rejected_rule'),
    periodStart: periodColumn('period_start'),

    // Plans in force when the decision was made. The kind columns are constants that, through
    // the composite FKs below, make the database refuse a user plan as the account plan (or the
    // other way round). Plan ownership is not repeated here: both ids were read from the
    // account/user rows, whose own constraints already guarantee it.
    accountPlanId: uuid('account_plan_id').notNull(),
    accountPlanKind: planKind('account_plan_kind').notNull().default('account'),
    userPlanId: uuid('user_plan_id').notNull(),
    userPlanKind: planKind('user_plan_kind').notNull().default('user'),
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
    foreignKey({
      name: 'request_log_user_account_fk',
      columns: [t.userId, t.accountId],
      foreignColumns: [users.id, users.accountId],
    }),
    foreignKey({
      name: 'request_log_account_plan_fk',
      columns: [t.accountPlanId, t.accountPlanKind],
      foreignColumns: [plans.id, plans.kind],
    }),
    foreignKey({
      name: 'request_log_user_plan_fk',
      columns: [t.userPlanId, t.userPlanKind],
      foreignColumns: [plans.id, plans.kind],
    }),
    index('request_log_account_created_idx').on(t.accountId, t.createdAt.desc(), t.id.desc()),
    index('request_log_user_created_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    index('request_log_account_period_idx').on(t.accountId, t.periodStart),
    check('request_log_account_plan_kind_is_account', sql`${t.accountPlanKind} = 'account'`),
    check('request_log_user_plan_kind_is_user', sql`${t.userPlanKind} = 'user'`),
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
export type AccountUsage = typeof accountUsage.$inferSelect;
export type UserUsage = typeof userUsage.$inferSelect;
export type RequestLogRow = typeof requestLog.$inferSelect;