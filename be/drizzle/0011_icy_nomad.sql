CREATE TABLE "launches_envio_staging" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
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
	CONSTRAINT "launches_envio_staging_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address")
);
--> statement-breakpoint
CREATE TABLE "trades_envio_staging" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"venue_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"timestamp" integer NOT NULL,
	"side" text NOT NULL,
	"token_amount_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"activity_kind" text NOT NULL,
	CONSTRAINT "trades_envio_staging_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "venues_envio_staging" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"effective_from_block" bigint NOT NULL,
	"official" boolean NOT NULL
);
