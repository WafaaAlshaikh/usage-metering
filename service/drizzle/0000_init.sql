CREATE TYPE "public"."plan_kind" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TYPE "public"."rule_scope" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TYPE "public"."rule_type" AS ENUM('max_per_request', 'monthly_allowance');--> statement-breakpoint
CREATE TABLE "account_usage" (
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_account_id_period_start_pk" PRIMARY KEY("account_id","period_start"),
	CONSTRAINT "account_usage_consumed_nonneg" CHECK ("account_usage"."consumed" >= 0),
	CONSTRAINT "account_usage_period_is_month_start" CHECK (extract(day from "account_usage"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"account_plan_id" uuid NOT NULL,
	"account_plan_kind" "plan_kind" DEFAULT 'account' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_plan_kind_is_account" CHECK ("accounts"."account_plan_kind" = 'account')
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" "plan_kind" NOT NULL,
	"name" text NOT NULL,
	"monthly_allowance" bigint,
	"max_units_per_request" bigint,
	"is_predefined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_id_kind_uq" UNIQUE("id","kind"),
	CONSTRAINT "plans_allowance_nonneg" CHECK ("plans"."monthly_allowance" is null or "plans"."monthly_allowance" >= 0),
	CONSTRAINT "plans_max_positive" CHECK ("plans"."max_units_per_request" is null or "plans"."max_units_per_request" > 0),
	CONSTRAINT "plans_predefined_has_no_owner" CHECK ("plans"."is_predefined" = ("plans"."account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"units" bigint NOT NULL,
	"accepted" boolean NOT NULL,
	"rejected_by" "rule_scope",
	"rejected_rule" "rule_type",
	"period_start" date NOT NULL,
	"account_plan_id" uuid NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"account_monthly_allowance" bigint,
	"account_max_per_request" bigint,
	"user_monthly_allowance" bigint,
	"user_max_per_request" bigint,
	"account_remaining_after" bigint,
	"user_remaining_after" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_log_account_request_uq" UNIQUE("account_id","request_id"),
	CONSTRAINT "request_log_units_positive" CHECK ("request_log"."units" > 0),
	CONSTRAINT "request_log_rejection_consistent" CHECK (("request_log"."accepted" and "request_log"."rejected_by" is null and "request_log"."rejected_rule" is null)
          or (not "request_log"."accepted" and "request_log"."rejected_by" is not null and "request_log"."rejected_rule" is not null)),
	CONSTRAINT "request_log_period_is_month_start" CHECK (extract(day from "request_log"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_user_id_period_start_pk" PRIMARY KEY("user_id","period_start"),
	CONSTRAINT "user_usage_consumed_nonneg" CHECK ("user_usage"."consumed" >= 0),
	CONSTRAINT "user_usage_period_is_month_start" CHECK (extract(day from "user_usage"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"user_plan_kind" "plan_kind" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_account_external_uq" UNIQUE("account_id","external_id"),
	CONSTRAINT "users_plan_kind_is_user" CHECK ("users"."user_plan_kind" = 'user')
);
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_kind_fk" FOREIGN KEY ("account_plan_id","account_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_plan_id_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_kind_fk" FOREIGN KEY ("user_plan_id","user_plan_kind") REFERENCES "public"."plans"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_api_key_hash_uq" ON "accounts" USING btree ("api_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_custom_name_uq" ON "plans" USING btree ("account_id","kind","name") WHERE "plans"."account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_predefined_name_uq" ON "plans" USING btree ("kind","name") WHERE "plans"."account_id" is null;--> statement-breakpoint
CREATE INDEX "plans_account_idx" ON "plans" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "request_log_account_created_idx" ON "request_log" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_log_user_created_idx" ON "request_log" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_log_account_period_idx" ON "request_log" USING btree ("account_id","period_start");--> statement-breakpoint
CREATE INDEX "user_usage_account_period_idx" ON "user_usage" USING btree ("account_id","period_start");--> statement-breakpoint
CREATE INDEX "users_plan_idx" ON "users" USING btree ("user_plan_id");