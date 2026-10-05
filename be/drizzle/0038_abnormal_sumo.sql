CREATE TABLE "pool_candle_dirty_buckets" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"bucket_start" integer NOT NULL,
	CONSTRAINT "pool_candle_dirty_buckets_chain_id_protocol_pool_id_bucket_start_pk" PRIMARY KEY("chain_id","protocol","pool_id","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "pool_candles" (
	"chain_id" integer NOT NULL,
	"protocol" text NOT NULL,
	"pool_id" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"bucket_start" integer NOT NULL,
	"open_sqrt_price_x96" numeric(78, 0) NOT NULL,
	"high_sqrt_price_x96" numeric(78, 0) NOT NULL,
	"low_sqrt_price_x96" numeric(78, 0) NOT NULL,
	"close_sqrt_price_x96" numeric(78, 0) NOT NULL,
	"trade_count" integer NOT NULL,
	CONSTRAINT "pool_candles_chain_id_protocol_pool_id_interval_seconds_bucket_start_pk" PRIMARY KEY("chain_id","protocol","pool_id","interval_seconds","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "pool_candles" ADD CONSTRAINT "pool_candles_chain_id_protocol_pool_id_pool_catalog_chain_id_protocol_pool_id_fk" FOREIGN KEY ("chain_id","protocol","pool_id") REFERENCES "public"."pool_catalog"("chain_id","protocol","pool_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_candle_dirty_oldest_idx" ON "pool_candle_dirty_buckets" USING btree ("bucket_start");
--> statement-breakpoint
CREATE FUNCTION enqueue_pool_candle_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO pool_candle_dirty_buckets (chain_id, protocol, pool_id, bucket_start)
    VALUES (OLD.chain_id, OLD.protocol, OLD.pool_id, (OLD.timestamp / 60) * 60)
    ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO pool_candle_dirty_buckets (chain_id, protocol, pool_id, bucket_start)
    VALUES (NEW.chain_id, NEW.protocol, NEW.pool_id, (NEW.timestamp / 60) * 60)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER pool_trades_dirty_candles AFTER INSERT OR UPDATE OR DELETE ON pool_trades
FOR EACH ROW EXECUTE FUNCTION enqueue_pool_candle_dirty();
--> statement-breakpoint
INSERT INTO pool_candle_dirty_buckets (chain_id, protocol, pool_id, bucket_start)
SELECT DISTINCT chain_id, protocol, pool_id, (timestamp / 60) * 60 FROM pool_trades
ON CONFLICT DO NOTHING;
