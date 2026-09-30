CREATE TABLE "lifecycle_transitions_envio_staging" (
	"source_log_id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"phase" integer NOT NULL,
	"kind" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launches_envio_staging" ALTER COLUMN "quote_asset_symbol" DROP NOT NULL;