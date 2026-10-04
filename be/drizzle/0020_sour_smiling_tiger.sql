CREATE TABLE "metadata_enrichment_budget" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	CONSTRAINT "metadata_enrichment_budget_singleton" CHECK ("metadata_enrichment_budget"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "metadata_enrichment_budget" ("id", "last_started_at") VALUES (1, NULL);--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "logo_read_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "description_read_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "socials_read_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "timestamp_read_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "metadata_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "metadata_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "metadata_lease_id" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "metadata_lease_until" timestamp with time zone;--> statement-breakpoint
UPDATE "launches" SET
  "logo_read_state" = CASE WHEN "logo_uri" IS NULL THEN 'pending' ELSE 'done' END,
  "description_read_state" = CASE WHEN "description" IS NULL THEN 'pending' ELSE 'done' END,
  "socials_read_state" = CASE WHEN "website_url" IS NULL AND "twitter_url" IS NULL THEN 'pending' ELSE 'done' END,
  "timestamp_read_state" = CASE WHEN "launch_timestamp" IS NULL THEN 'pending' ELSE 'done' END;--> statement-breakpoint
CREATE INDEX "launches_metadata_due_idx" ON "launches" USING btree ("metadata_retry_at","launch_block") WHERE "launches"."platform" = 'pons' AND
    ("launches"."logo_read_state" = 'pending' OR "launches"."description_read_state" = 'pending' OR
     "launches"."socials_read_state" = 'pending' OR "launches"."timestamp_read_state" = 'pending');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_logo_read_state_valid" CHECK ("launches"."logo_read_state" IN ('pending', 'done'));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_description_read_state_valid" CHECK ("launches"."description_read_state" IN ('pending', 'done'));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_socials_read_state_valid" CHECK ("launches"."socials_read_state" IN ('pending', 'done'));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_timestamp_read_state_valid" CHECK ("launches"."timestamp_read_state" IN ('pending', 'done'));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_metadata_retry_count_valid" CHECK ("launches"."metadata_retry_count" >= 0);
