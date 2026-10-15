CREATE TABLE "fast_lane_venue_coverage" (
	"chain_id" integer NOT NULL,
	"venue_id" text NOT NULL,
	"envio_bridge_block" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fast_lane_venue_coverage_chain_id_venue_id_pk" PRIMARY KEY("chain_id","venue_id")
);
--> statement-breakpoint
ALTER TABLE "fast_lane_state" ADD COLUMN "coverage_block" bigint;--> statement-breakpoint
ALTER TABLE "fast_lane_venue_coverage" ADD CONSTRAINT "fast_lane_venue_coverage_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fast_lane_venue_coverage_chain_idx" ON "fast_lane_venue_coverage" USING btree ("chain_id","envio_bridge_block");
--> statement-breakpoint
INSERT INTO "fast_lane_venue_coverage" ("chain_id", "venue_id", "envio_bridge_block")
SELECT v.chain_id, v.id, GREATEST(s.confirmed_to_block, COALESCE(state.last_block, s.confirmed_to_block))
FROM venues v
JOIN sources s ON s.id = v.source_id
LEFT JOIN fast_lane_state state ON state.chain_id = v.chain_id
WHERE v.official = true AND v.kind IN ('curve', 'v3_pool', 'v4_pool')
ON CONFLICT (chain_id, venue_id) DO NOTHING;
