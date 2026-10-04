CREATE TABLE "quote_usd_price_rounds" (
	"chain_id" integer NOT NULL,
	"feed_address" text NOT NULL,
	"round_id" numeric(30, 0) NOT NULL,
	"answer_raw" numeric(78, 0) NOT NULL,
	"decimals" integer NOT NULL,
	"started_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "quote_usd_price_rounds_chain_id_feed_address_round_id_pk" PRIMARY KEY("chain_id","feed_address","round_id")
);
--> statement-breakpoint
CREATE INDEX "quote_usd_price_rounds_position_idx" ON "quote_usd_price_rounds" USING btree ("chain_id","feed_address","block_number","log_index");