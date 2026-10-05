ALTER TABLE "launches" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "token_decimals" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "quote_asset_symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "quote_asset_decimals" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "core_metadata_read_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "core_metadata_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "core_metadata_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "launches_core_metadata_due_idx" ON "launches" USING btree ("core_metadata_retry_at","launch_block") WHERE "launches"."platform" = 'pons' AND "launches"."core_metadata_read_state" = 'pending';--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_core_metadata_read_state_valid" CHECK ("launches"."core_metadata_read_state" IN ('pending', 'done'));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_core_metadata_retry_count_valid" CHECK ("launches"."core_metadata_retry_count" >= 0);--> statement-breakpoint
-- Every row written before this migration came from the old synchronous-RPC sync path, which never
-- inserted a launch without fully known name/symbol/decimals/quote-asset metadata. The new
-- 'pending' default from ADD COLUMN above would otherwise make the enrichment worker re-fetch RPC
-- data for every existing launch for no reason.
UPDATE "launches" SET "core_metadata_read_state" = 'done'
  WHERE "name" IS NOT NULL AND "symbol" IS NOT NULL AND "token_decimals" IS NOT NULL
    AND "quote_asset_symbol" IS NOT NULL AND "quote_asset_decimals" IS NOT NULL;