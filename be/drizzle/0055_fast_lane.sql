CREATE TABLE "fast_lane_rows" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"stream" text NOT NULL,
	"raw" jsonb NOT NULL,
	"block_number" bigint NOT NULL,
	"written_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fast_lane_rows_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "fast_lane_state" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fast_lane_rows_written_idx" ON "fast_lane_rows" USING btree ("written_at");