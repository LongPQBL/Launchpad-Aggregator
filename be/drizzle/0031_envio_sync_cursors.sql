CREATE TABLE "envio_sync_cursors" (
	"chain_id" integer NOT NULL,
	"stream" text NOT NULL,
	"lane" text NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"raw_id" text NOT NULL,
	"processed_watermark" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envio_sync_cursors_chain_id_stream_lane_pk" PRIMARY KEY("chain_id","stream","lane"),
	CONSTRAINT "envio_sync_cursors_valid_stream" CHECK ("envio_sync_cursors"."stream" IN
    ('v1-launch', 'v1-swap', 'v2-launch', 'v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap')),
	CONSTRAINT "envio_sync_cursors_valid_lane" CHECK ("envio_sync_cursors"."lane" IN ('tail', 'history'))
);
