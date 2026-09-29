CREATE TABLE "phase_observations" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"status" text NOT NULL,
	"observed_phase" integer,
	"reason" text,
	CONSTRAINT "phase_observations_chain_id_token_address_pk" PRIMARY KEY("chain_id","token_address")
);
--> statement-breakpoint
ALTER TABLE "phase_observations" ADD CONSTRAINT "phase_observations_chain_id_token_address_launches_chain_id_token_address_fk" FOREIGN KEY ("chain_id","token_address") REFERENCES "public"."launches"("chain_id","token_address") ON DELETE cascade ON UPDATE no action;