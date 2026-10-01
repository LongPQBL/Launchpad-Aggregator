ALTER TABLE "launches" ALTER COLUMN "source_log_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" DROP CONSTRAINT "lifecycle_transitions_pkey";--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ALTER COLUMN "source_log_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "source_log_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ALTER COLUMN "source_log_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index");--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "launch_log_index" integer;--> statement-breakpoint
UPDATE "launches" SET "launch_log_index" = r.log_index FROM "raw_logs" r WHERE r.id = "launches"."source_log_id";--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "launch_log_index" SET NOT NULL;
