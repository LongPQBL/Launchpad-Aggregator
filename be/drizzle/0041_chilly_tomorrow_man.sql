CREATE TABLE "launch_volume24h_jobs" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"revision" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launch_volume24h_jobs_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address"),
	CONSTRAINT "launch_volume24h_jobs_revision_positive" CHECK ("launch_volume24h_jobs"."revision" >= 1),
	CONSTRAINT "launch_volume24h_jobs_attempts_valid" CHECK ("launch_volume24h_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "launch_volume24h_usd" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"volume_usd" numeric(78, 30),
	"rank_category" text NOT NULL,
	"rank_order" smallint NOT NULL,
	"completeness_reason" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"window_end" bigint NOT NULL,
	"next_expiry_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"launch_block" bigint NOT NULL,
	"launch_tx_hash" text NOT NULL,
	"launch_log_index" integer NOT NULL,
	CONSTRAINT "launch_volume24h_usd_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address"),
	CONSTRAINT "launch_volume24h_usd_rank_valid" CHECK (
    ("launch_volume24h_usd"."rank_category" = 'positive' AND "launch_volume24h_usd"."rank_order" = 0 AND "launch_volume24h_usd"."volume_usd" > 0 AND "launch_volume24h_usd"."completeness_reason" = 'complete')
    OR ("launch_volume24h_usd"."rank_category" = 'zero' AND "launch_volume24h_usd"."rank_order" = 1 AND "launch_volume24h_usd"."volume_usd" = 0 AND "launch_volume24h_usd"."completeness_reason" = 'complete')
    OR ("launch_volume24h_usd"."rank_category" = 'null' AND "launch_volume24h_usd"."rank_order" = 2 AND "launch_volume24h_usd"."volume_usd" IS NULL)
  ),
	CONSTRAINT "launch_volume24h_usd_reason_valid" CHECK ("launch_volume24h_usd"."completeness_reason" IN ('complete', 'incomplete_coverage', 'unpriced_trade', 'updating'))
);
--> statement-breakpoint
ALTER TABLE "launch_volume24h_jobs" ADD CONSTRAINT "launch_volume24h_jobs_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_volume24h_usd" ADD CONSTRAINT "launch_volume24h_usd_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launch_volume24h_jobs_due_idx" ON "launch_volume24h_jobs" USING btree ("due_at","lease_until");--> statement-breakpoint
CREATE INDEX "launch_volume24h_usd_rank_idx" ON "launch_volume24h_usd" USING btree ("rank_order","volume_usd" DESC NULLS LAST,"launch_block" DESC NULLS LAST,"launch_tx_hash" DESC NULLS LAST,"launch_log_index" DESC NULLS LAST);