CREATE TABLE "unresolved_events" (
	"chain_id" integer NOT NULL,
	"stream" text NOT NULL,
	"raw_id" text NOT NULL,
	"reason" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unresolved_events_chain_id_stream_raw_id_pk" PRIMARY KEY("chain_id","stream","raw_id"),
	CONSTRAINT "unresolved_events_valid_stream" CHECK ("unresolved_events"."stream" IN
    ('v1-launch', 'v1-swap', 'v2-launch', 'v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap')),
	CONSTRAINT "unresolved_events_retry_count_valid" CHECK ("unresolved_events"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "unresolved_events_due_idx" ON "unresolved_events" USING btree ("next_retry_at");