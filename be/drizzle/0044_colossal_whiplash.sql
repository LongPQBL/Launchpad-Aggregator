CREATE TABLE "usd_candles" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" bigint NOT NULL,
	"open" numeric(40, 20) NOT NULL,
	"high" numeric(40, 20) NOT NULL,
	"low" numeric(40, 20) NOT NULL,
	"close" numeric(40, 20) NOT NULL,
	"volume_usd" numeric(40, 6) NOT NULL,
	"trade_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usd_candles_chain_id_token_address_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","token_address","interval_seconds","bucket_start"),
	CONSTRAINT "usd_candles_interval_valid" CHECK ("usd_candles"."interval_seconds" IN (60, 300, 900, 3600, 86400))
);
--> statement-breakpoint
ALTER TABLE "usd_candles" ADD CONSTRAINT "usd_candles_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;