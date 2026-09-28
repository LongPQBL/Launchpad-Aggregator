ALTER TABLE "launches" ADD COLUMN "source_log_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "source_log_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "source_log_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE cascade ON UPDATE no action;