CREATE TABLE "pool_source_audits" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"factory_address" text NOT NULL,
	"deployment_block" bigint NOT NULL,
	"audited_to_block" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "pool_source_audits_chain_id_protocol_pk" PRIMARY KEY("chain_id","protocol"),
	CONSTRAINT "pool_source_audits_status" CHECK ("pool_source_audits"."status" IN ('pending', 'mismatch', 'complete'))
);
--> statement-breakpoint
ALTER TABLE "pool_catalog" DROP CONSTRAINT "pool_catalog_v4_protocol";--> statement-breakpoint
ALTER TABLE "pool_sync_cursors" DROP CONSTRAINT "pool_sync_cursors_stream";--> statement-breakpoint
CREATE INDEX "pool_catalog_recent_idx" ON "pool_catalog" USING btree ("block_number","log_index","chain_id","protocol","pool_id");--> statement-breakpoint
ALTER TABLE "pool_catalog" ADD CONSTRAINT "pool_catalog_protocol" CHECK ("pool_catalog"."protocol" IN ('uniswap_v4', 'uniswap_v3', 'uniswap_v2'));--> statement-breakpoint
ALTER TABLE "pool_sync_cursors" ADD CONSTRAINT "pool_sync_cursors_stream" CHECK ("pool_sync_cursors"."stream" IN ('initialize', 'swap', 'v3_created', 'v3_swap', 'v2_created', 'v2_swap'));