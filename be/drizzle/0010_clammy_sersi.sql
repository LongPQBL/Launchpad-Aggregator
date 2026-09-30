CREATE TABLE "scan_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"lane" text NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"elapsed_ms" integer,
	"request_count" integer,
	"error_reason" text,
	CONSTRAINT "scan_jobs_valid_range" CHECK ("scan_jobs"."from_block" <= "scan_jobs"."to_block"),
	CONSTRAINT "scan_jobs_valid_lane" CHECK ("scan_jobs"."lane" IN ('certified', 'provisional'))
);
--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_jobs_source_lane_range" ON "scan_jobs" USING btree ("source_id","lane","from_block","to_block");--> statement-breakpoint
CREATE INDEX "scan_jobs_claim_idx" ON "scan_jobs" USING btree ("status","lease_until","source_id");