ALTER TABLE "launches_envio_staging" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches_envio_staging" ALTER COLUMN "symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches_envio_staging" ALTER COLUMN "lifecycle_status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trades_envio_staging" ADD COLUMN "block_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "trades_envio_staging" ADD COLUMN "price_numerator_raw" text;--> statement-breakpoint
ALTER TABLE "trades_envio_staging" ADD COLUMN "price_denominator_raw" text;