CREATE TABLE "lifecycle_transitions" (
	"source_log_id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"source_id" text NOT NULL,
	"phase" integer NOT NULL,
	"kind" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "v4_pool_fee" integer;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "v4_tick_spacing" integer;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "effective_from_log_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "effective_to_log_index" integer;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_transitions_token_position_idx" ON "lifecycle_transitions" USING btree ("chain_id","token_address","block_number","log_index");