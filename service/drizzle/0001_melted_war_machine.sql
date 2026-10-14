-- Hardening: plan ownership isolation, user/account consistency, soft delete, plan kinds in the log.
--
-- Hand-ordered (the generated file added NOT NULL columns without a backfill and created the
-- composite foreign keys before the UNIQUE constraints they point at). Safe on existing data:
-- columns are added nullable, backfilled from the plan each row already uses, then made NOT NULL.
-- If an existing row breaks a rule this migration introduces (for example a user whose plan
-- belongs to another account), the migration fails and nothing is applied.

-- 1. Drop the weaker single-column foreign keys that the composite ones replace.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_plan_kind_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_plan_kind_fk";--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_account_plan_id_plans_id_fk";--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_user_plan_id_plans_id_fk";--> statement-breakpoint
ALTER TABLE "user_usage" DROP CONSTRAINT "user_usage_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_usage" DROP CONSTRAINT "user_usage_account_id_accounts_id_fk";--> statement-breakpoint

-- 2. New columns. The owner-key columns start nullable so existing rows can be backfilled.
ALTER TABLE "plans" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "owner_key" uuid GENERATED ALWAYS AS (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "account_plan_owner_key" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_plan_owner_key" uuid;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "account_plan_kind" "plan_kind" DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "user_plan_kind" "plan_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint

-- 3. Backfill the owner keys from the plan each row already points at.
UPDATE "accounts" a SET "account_plan_owner_key" = p."owner_key" FROM "plans" p WHERE p."id" = a."account_plan_id";--> statement-breakpoint
UPDATE "users" u SET "user_plan_owner_key" = p."owner_key" FROM "plans" p WHERE p."id" = u."user_plan_id";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "account_plan_owner_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "user_plan_owner_key" SET NOT NULL;--> statement-breakpoint

-- 4. UNIQUE constraints first: they are the targets of the composite foreign keys.
ALTER TABLE "plans" ADD CONSTRAINT "plans_id_kind_owner_uq" UNIQUE("id","kind","owner_key");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_account_uq" UNIQUE("id","account_id");--> statement-breakpoint

-- 5. CHECK constraints.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_not_system_owner" CHECK ("accounts"."id" <> '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_owner_is_self_or_system" CHECK ("accounts"."account_plan_owner_key" in ("accounts"."id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_owner_is_own_account_or_system" CHECK ("users"."user_plan_owner_key" in ("users"."account_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_predefined_not_archived" CHECK (not "plans"."is_predefined" or "plans"."archived_at" is null);--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_plan_kind_is_account" CHECK ("request_log"."account_plan_kind" = 'account');--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_plan_kind_is_user" CHECK ("request_log"."user_plan_kind" = 'user');--> statement-breakpoint

-- 6. Composite foreign keys.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_fk" FOREIGN KEY ("account_plan_id","account_plan_kind","account_plan_owner_key") REFERENCES "public"."plans"("id","kind","owner_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_fk" FOREIGN KEY ("user_plan_id","user_plan_kind","user_plan_owner_key") REFERENCES "public"."plans"("id","kind","owner_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."users"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."users"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_plan_fk" FOREIGN KEY ("account_plan_id","account_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_plan_fk" FOREIGN KEY ("user_plan_id","user_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;