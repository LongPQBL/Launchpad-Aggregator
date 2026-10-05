CREATE TABLE "envio_repair_state" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- unresolved_events has no production consumer yet (introduced in this same plan, not yet deployed to
-- the live loop) — any existing row at this point is disposable test/dev data, not something to backfill.
TRUNCATE "unresolved_events";--> statement-breakpoint
ALTER TABLE "unresolved_events" ADD COLUMN "block_number" bigint NOT NULL;--> statement-breakpoint
CREATE INDEX "unresolved_events_block_idx" ON "unresolved_events" USING btree ("chain_id","stream","block_number");