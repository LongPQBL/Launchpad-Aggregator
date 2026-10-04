CREATE TABLE "launch_parity_reports" (
	"source_id" text NOT NULL,
	"registry_version" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"fence_block" bigint NOT NULL,
	"envio_watermark" bigint NOT NULL,
	"app_watermark" bigint NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"chain_count" integer NOT NULL,
	"envio_count" integer NOT NULL,
	"app_count" integer NOT NULL,
	"first_block" bigint,
	"last_block" bigint,
	"details" jsonb NOT NULL,
	"audited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launch_parity_reports_source_id_from_block_to_block_fence_block_pk" PRIMARY KEY("source_id","from_block","to_block","fence_block"),
	CONSTRAINT "launch_parity_reports_status_valid" CHECK ("launch_parity_reports"."status" IN ('complete', 'mismatch', 'pending'))
);
--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "launch_block_hash" text;--> statement-breakpoint
CREATE INDEX "launch_parity_reports_latest_idx" ON "launch_parity_reports" USING btree ("source_id","audited_at");