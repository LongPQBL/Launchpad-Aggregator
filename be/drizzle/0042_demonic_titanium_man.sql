CREATE TABLE "launch_volume24h_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"backfill_complete_at" timestamp with time zone,
	"worker_heartbeat_at" timestamp with time zone,
	CONSTRAINT "launch_volume24h_state_singleton" CHECK ("launch_volume24h_state"."id" = 1)
);
