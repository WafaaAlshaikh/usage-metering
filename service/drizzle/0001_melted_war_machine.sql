ALTER TABLE "accounts" DROP CONSTRAINT "accounts_plan_kind_fk";
--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_account_plan_id_plans_id_fk";
--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_user_plan_id_plans_id_fk";
--> statement-breakpoint
ALTER TABLE "user_usage" DROP CONSTRAINT "user_usage_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_usage" DROP CONSTRAINT "user_usage_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_plan_kind_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "account_plan_owner_key" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "owner_key" uuid GENERATED ALWAYS AS (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "account_plan_kind" "plan_kind" DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "user_plan_kind" "plan_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_plan_owner_key" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_fk" FOREIGN KEY ("account_plan_id","account_plan_kind","account_plan_owner_key") REFERENCES "public"."plans"("id","kind","owner_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."users"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_plan_fk" FOREIGN KEY ("account_plan_id","account_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_plan_fk" FOREIGN KEY ("user_plan_id","user_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."users"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_fk" FOREIGN KEY ("user_plan_id","user_plan_kind","user_plan_owner_key") REFERENCES "public"."plans"("id","kind","owner_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_id_kind_owner_uq" UNIQUE("id","kind","owner_key");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_account_uq" UNIQUE("id","account_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_owner_is_self_or_system" CHECK ("accounts"."account_plan_owner_key" in ("accounts"."id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_not_system_owner" CHECK ("accounts"."id" <> '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_predefined_not_archived" CHECK (not "plans"."is_predefined" or "plans"."archived_at" is null);--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_plan_kind_is_account" CHECK ("request_log"."account_plan_kind" = 'account');--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_plan_kind_is_user" CHECK ("request_log"."user_plan_kind" = 'user');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_owner_is_own_account_or_system" CHECK ("users"."user_plan_owner_key" in ("users"."account_id", '00000000-0000-0000-0000-000000000000'::uuid));