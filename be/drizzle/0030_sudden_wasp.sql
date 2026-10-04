CREATE TABLE "launch_parity_repairs" (
	"source_id" text NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"failure_layer" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launch_parity_repairs_source_id_from_block_to_block_failure_layer_pk" PRIMARY KEY("source_id","from_block","to_block","failure_layer"),
	CONSTRAINT "launch_parity_repairs_layer_valid" CHECK ("launch_parity_repairs"."failure_layer" IN ('envio', 'app')),
	CONSTRAINT "launch_parity_repairs_action_valid" CHECK ("launch_parity_repairs"."action" IN ('envio_reindex', 'app_promotion')),
	CONSTRAINT "launch_parity_repairs_status_valid" CHECK ("launch_parity_repairs"."status" IN ('pending', 'done'))
);
--> statement-breakpoint
CREATE INDEX "launch_parity_repairs_pending_idx" ON "launch_parity_repairs" USING btree ("status","created_at");