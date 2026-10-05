CREATE TABLE "pool_catalog" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"currency0" text NOT NULL,
	"currency1" text NOT NULL,
	"fee" integer NOT NULL,
	"tick_spacing" integer NOT NULL,
	"hooks" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"verified" boolean NOT NULL,
	"coverage_status" text DEFAULT 'backfilling' NOT NULL,
	CONSTRAINT "pool_catalog_chain_id_protocol_pool_id_pk" PRIMARY KEY("chain_id","protocol","pool_id"),
	CONSTRAINT "pool_catalog_v4_protocol" CHECK ("pool_catalog"."protocol" = 'uniswap_v4'),
	CONSTRAINT "pool_catalog_verified" CHECK ("pool_catalog"."verified" = true),
	CONSTRAINT "pool_catalog_currency_order" CHECK ("pool_catalog"."currency0" < "pool_catalog"."currency1"),
	CONSTRAINT "pool_catalog_coverage_status" CHECK ("pool_catalog"."coverage_status" IN ('backfilling', 'caught_up', 'incomplete'))
);
--> statement-breakpoint
CREATE TABLE "pool_members" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"token_address" text NOT NULL,
	CONSTRAINT "pool_members_chain_id_protocol_pool_id_token_address_pk" PRIMARY KEY("chain_id","protocol","pool_id","token_address")
);
--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_chain_id_protocol_pool_id_pool_catalog_chain_id_protocol_pool_id_fk" FOREIGN KEY ("chain_id","protocol","pool_id") REFERENCES "public"."pool_catalog"("chain_id","protocol","pool_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_members_token_idx" ON "pool_members" USING btree ("chain_id","token_address");