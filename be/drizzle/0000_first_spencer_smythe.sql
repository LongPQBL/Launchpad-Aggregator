CREATE TABLE "candles" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" integer NOT NULL,
	"open" text NOT NULL,
	"high" text NOT NULL,
	"low" text NOT NULL,
	"close" text NOT NULL,
	"quote_volume_raw" numeric(78, 0) NOT NULL,
	CONSTRAINT "candles_chain_id_token_address_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","token_address","interval_seconds","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"platform" text NOT NULL,
	"protocol_version" text NOT NULL,
	"factory_address" text NOT NULL,
	"deployer_address" text NOT NULL,
	"launch_block" bigint NOT NULL,
	"launch_tx_hash" text NOT NULL,
	"quote_asset_address" text NOT NULL,
	"quote_asset_symbol" text NOT NULL,
	"quote_asset_decimals" integer NOT NULL,
	"lifecycle_status" text NOT NULL,
	CONSTRAINT "launches_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address")
);
--> statement-breakpoint
CREATE TABLE "raw_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"source_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"address" text NOT NULL,
	"topics" jsonb NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"version" text NOT NULL,
	"factory_address" text NOT NULL,
	"start_block" bigint NOT NULL,
	"scanned_to_block" bigint NOT NULL,
	"confirmed_to_block" bigint NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"venue_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"timestamp" integer NOT NULL,
	"side" text NOT NULL,
	"token_amount_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"quote_asset_address" text NOT NULL,
	"source_event" text NOT NULL,
	"price_numerator_raw" numeric(78, 0),
	"price_denominator_raw" numeric(78, 0),
	CONSTRAINT "trades_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"source_id" text NOT NULL,
	"effective_from_block" bigint NOT NULL,
	"effective_to_block" bigint,
	"official" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_logs" ADD CONSTRAINT "raw_logs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launches_source_block_idx" ON "launches" USING btree ("source_id","launch_block");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_logs_chain_block_tx_log_idx" ON "raw_logs" USING btree ("chain_id","block_hash","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "raw_logs_source_block_idx" ON "raw_logs" USING btree ("source_id","block_number");--> statement-breakpoint
CREATE INDEX "trades_token_block_idx" ON "trades" USING btree ("chain_id","token_address","block_number");--> statement-breakpoint
CREATE INDEX "venues_token_idx" ON "venues" USING btree ("chain_id","token_address");