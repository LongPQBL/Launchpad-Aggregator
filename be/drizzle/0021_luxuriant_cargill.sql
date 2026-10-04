CREATE TABLE "quote_usd_feeds" (
	"chain_id" integer NOT NULL,
	"quote_asset_address" text NOT NULL,
	"feed_address" text NOT NULL,
	"aggregator_address" text,
	"discovery_source" text NOT NULL,
	"verification_status" text NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quote_usd_feeds_chain_id_quote_asset_address_pk" PRIMARY KEY("chain_id","quote_asset_address"),
	CONSTRAINT "quote_usd_feeds_verification_status_valid" CHECK ("quote_usd_feeds"."verification_status" IN ('verified', 'unverified', 'rejected'))
);
