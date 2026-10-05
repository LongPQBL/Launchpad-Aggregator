ALTER TABLE "launches" DROP CONSTRAINT "launches_source_log_id_raw_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" DROP CONSTRAINT "lifecycle_transitions_source_log_id_raw_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "trades" DROP CONSTRAINT "trades_source_log_id_raw_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "venues" DROP CONSTRAINT "venues_source_log_id_raw_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_source_log_id_raw_logs_id_fk" FOREIGN KEY ("source_log_id") REFERENCES "public"."raw_logs"("id") ON DELETE set null ON UPDATE no action;