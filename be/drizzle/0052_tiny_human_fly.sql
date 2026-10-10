CREATE TABLE "launch_usd_candle_buckets" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" bigint NOT NULL,
	"open" numeric(40, 20),
	"high" numeric(40, 20),
	"low" numeric(40, 20),
	"close" numeric(40, 20),
	"volume_usd" numeric(40, 6) NOT NULL,
	"trade_count" integer NOT NULL,
	"unpriced_count" integer NOT NULL,
	CONSTRAINT "launch_usd_candle_buckets_chain_id_token_address_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","token_address","interval_seconds","bucket_start"),
	CONSTRAINT "launch_usd_candle_buckets_interval_valid" CHECK ("launch_usd_candle_buckets"."interval_seconds" IN (60, 300, 3600, 14400, 86400))
);
