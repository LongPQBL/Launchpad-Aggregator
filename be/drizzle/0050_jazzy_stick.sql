CREATE TABLE "chart_rollup_state" (
	"name" text PRIMARY KEY NOT NULL,
	"completed_through" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_volume_buckets" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"venue_kind" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" bigint NOT NULL,
	"volume_usd" numeric(40, 6) NOT NULL,
	"trade_count" integer NOT NULL,
	"unpriced_count" integer NOT NULL,
	CONSTRAINT "launch_volume_buckets_chain_id_token_address_venue_kind_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","token_address","venue_kind","interval_seconds","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "pool_tvl_buckets" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" bigint NOT NULL,
	"tvl_usd" numeric(78, 30) NOT NULL,
	"last_captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pool_tvl_buckets_chain_id_protocol_pool_id_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","protocol","pool_id","interval_seconds","bucket_start"),
	CONSTRAINT "pool_tvl_buckets_protocol" CHECK ("pool_tvl_buckets"."protocol" = 'uniswap_v4')
);
--> statement-breakpoint
CREATE TABLE "pool_volume_buckets" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" bigint NOT NULL,
	"trade_count" integer NOT NULL,
	"usd_scaled0" numeric(80, 12),
	"unpriced0" integer NOT NULL,
	"usd_scaled1" numeric(80, 12),
	"unpriced1" integer NOT NULL,
	CONSTRAINT "pool_volume_buckets_chain_id_protocol_pool_id_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","protocol","pool_id","interval_seconds","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "usd_candles" DROP CONSTRAINT "usd_candles_interval_valid";--> statement-breakpoint
CREATE INDEX "launch_volume_unpriced_idx" ON "launch_volume_buckets" USING btree ("chain_id","token_address") WHERE "launch_volume_buckets"."unpriced_count" > 0;--> statement-breakpoint
ALTER TABLE "usd_candles" ADD CONSTRAINT "usd_candles_interval_valid" CHECK ("usd_candles"."interval_seconds" IN (60, 300, 900, 3600, 14400, 86400));
--> statement-breakpoint
INSERT INTO candles (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, quote_volume_raw)
SELECT chain_id, token_address, 14400, (bucket_start / 14400) * 14400,
  (array_agg(open ORDER BY bucket_start))[1],
  (array_agg(high ORDER BY high::numeric DESC))[1],
  (array_agg(low ORDER BY low::numeric ASC))[1],
  (array_agg(close ORDER BY bucket_start DESC))[1],
  sum(quote_volume_raw)
FROM candles WHERE interval_seconds = 3600
GROUP BY chain_id, token_address, (bucket_start / 14400) * 14400
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO pool_candles (chain_id, protocol, pool_id, interval_seconds, bucket_start,
  open_sqrt_price_x96, high_sqrt_price_x96, low_sqrt_price_x96, close_sqrt_price_x96, trade_count)
SELECT chain_id, protocol, pool_id, 14400, (bucket_start / 14400) * 14400,
  (array_agg(open_sqrt_price_x96 ORDER BY bucket_start))[1], max(high_sqrt_price_x96), min(low_sqrt_price_x96),
  (array_agg(close_sqrt_price_x96 ORDER BY bucket_start DESC))[1], sum(trade_count)
FROM pool_candles WHERE interval_seconds = 3600
GROUP BY chain_id, protocol, pool_id, (bucket_start / 14400) * 14400
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO pool_tvl_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd, last_captured_at)
SELECT DISTINCT ON (s.chain_id, s.protocol, s.pool_id, i.step, (extract(epoch FROM s.captured_at)::bigint / i.step) * i.step)
  s.chain_id, s.protocol, s.pool_id, i.step, (extract(epoch FROM s.captured_at)::bigint / i.step) * i.step, s.tvl_usd, s.captured_at
FROM pool_tvl_snapshots s CROSS JOIN (VALUES (3600), (14400), (86400)) AS i(step)
ORDER BY s.chain_id, s.protocol, s.pool_id, i.step, (extract(epoch FROM s.captured_at)::bigint / i.step) * i.step, s.captured_at DESC
ON CONFLICT DO NOTHING;
