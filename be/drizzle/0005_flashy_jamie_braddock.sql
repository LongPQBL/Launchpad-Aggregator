CREATE TABLE "source_gaps" (
	"source_id" text NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "source_gaps_source_id_from_block_to_block_pk" PRIMARY KEY("source_id","from_block","to_block")
);
--> statement-breakpoint
ALTER TABLE "source_gaps" ADD CONSTRAINT "source_gaps_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;