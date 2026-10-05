CREATE TABLE "pool_pending_swaps" (
	"chain_id" integer NOT NULL,
	"raw_id" text NOT NULL,
	"pool_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	CONSTRAINT "pool_pending_swaps_chain_id_raw_id_pk" PRIMARY KEY("chain_id","raw_id")
);
--> statement-breakpoint
CREATE TABLE "pool_sync_cursors" (
	"chain_id" integer NOT NULL,
	"stream" text NOT NULL,
	"lane" text NOT NULL,
	"block_number" bigint DEFAULT 0 NOT NULL,
	"log_index" integer DEFAULT -1 NOT NULL,
	"raw_id" text DEFAULT '' NOT NULL,
	"processed_watermark" bigint,
	CONSTRAINT "pool_sync_cursors_chain_id_stream_lane_pk" PRIMARY KEY("chain_id","stream","lane"),
	CONSTRAINT "pool_sync_cursors_stream" CHECK ("pool_sync_cursors"."stream" IN ('initialize', 'swap')),
	CONSTRAINT "pool_sync_cursors_lane" CHECK ("pool_sync_cursors"."lane" IN ('tail', 'history'))
);
--> statement-breakpoint
CREATE TABLE "pool_trades" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"timestamp" integer NOT NULL,
	"amount0_raw" numeric(78, 0) NOT NULL,
	"amount1_raw" numeric(78, 0) NOT NULL,
	"sqrt_price_x96" numeric(78, 0) NOT NULL,
	"trader_address" text NOT NULL,
	"sender_address" text NOT NULL,
	"fee" integer NOT NULL,
	CONSTRAINT "pool_trades_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
ALTER TABLE "pool_trades" ADD CONSTRAINT "pool_trades_chain_id_protocol_pool_id_pool_catalog_chain_id_protocol_pool_id_fk" FOREIGN KEY ("chain_id","protocol","pool_id") REFERENCES "public"."pool_catalog"("chain_id","protocol","pool_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_pending_swaps_pool_idx" ON "pool_pending_swaps" USING btree ("chain_id","pool_id");--> statement-breakpoint
CREATE INDEX "pool_trades_pool_time_idx" ON "pool_trades" USING btree ("chain_id","protocol","pool_id","timestamp");--> statement-breakpoint
CREATE INDEX "pool_trades_pool_block_idx" ON "pool_trades" USING btree ("chain_id","protocol","pool_id","block_number");