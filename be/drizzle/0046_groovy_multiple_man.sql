CREATE TABLE "launch_curve_reserves" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"quote_reserve_raw" numeric(78, 0) NOT NULL,
	"token_reserve_raw" numeric(78, 0) NOT NULL,
	"last_block_number" bigint NOT NULL,
	"last_log_index" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "launch_curve_reserves_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address")
);
--> statement-breakpoint
ALTER TABLE "launch_curve_reserves" ADD CONSTRAINT "launch_curve_reserves_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;