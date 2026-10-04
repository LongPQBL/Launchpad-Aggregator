CREATE TABLE "price_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"job_type" text NOT NULL,
	"quote_asset_address" text,
	"feed_address" text,
	"range_start" integer,
	"range_end" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_jobs_valid_type" CHECK ("price_jobs"."job_type" IN ('feed_resolution', 'round_backfill')),
	CONSTRAINT "price_jobs_valid_status" CHECK ("price_jobs"."status" IN ('pending', 'done', 'failed')),
	CONSTRAINT "price_jobs_type_shape" CHECK (
    ("price_jobs"."job_type" = 'feed_resolution' AND "price_jobs"."quote_asset_address" IS NOT NULL AND "price_jobs"."feed_address" IS NULL)
    OR ("price_jobs"."job_type" = 'round_backfill' AND "price_jobs"."feed_address" IS NOT NULL AND "price_jobs"."range_start" IS NOT NULL AND "price_jobs"."range_end" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_jobs_dedup_idx" ON "price_jobs" USING btree ("chain_id","job_type",coalesce("quote_asset_address", ''),coalesce("feed_address", ''),coalesce("range_start", -1),coalesce("range_end", -1));--> statement-breakpoint
CREATE INDEX "price_jobs_claim_idx" ON "price_jobs" USING btree ("status","next_attempt_at","lease_until");