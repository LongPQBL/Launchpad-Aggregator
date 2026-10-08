CREATE TABLE "pool_tvl_snapshots" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"core_amount0_raw" numeric(78, 0) NOT NULL,
	"core_amount1_raw" numeric(78, 0) NOT NULL,
	"sqrt_price_x96" numeric(78, 0) NOT NULL,
	"quote_address" text NOT NULL,
	"tvl_usd" numeric(78, 30) NOT NULL,
	CONSTRAINT "pool_tvl_snapshots_chain_id_protocol_pool_id_block_number_pk" PRIMARY KEY("chain_id","protocol","pool_id","block_number"),
	CONSTRAINT "pool_tvl_snapshots_protocol" CHECK ("pool_tvl_snapshots"."protocol" = 'uniswap_v4')
);
--> statement-breakpoint
CREATE INDEX "pool_tvl_snapshots_captured_at_idx" ON "pool_tvl_snapshots" USING btree ("captured_at");