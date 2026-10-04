CREATE TABLE "candle_cache_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"backfill_complete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "candle_cache_state_singleton" CHECK ("candle_cache_state"."id" = 1)
);
