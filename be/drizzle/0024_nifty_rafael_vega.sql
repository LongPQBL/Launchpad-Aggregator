CREATE TABLE "candle_dirty_buckets" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"bucket_start" integer NOT NULL,
	CONSTRAINT "candle_dirty_buckets_chain_id_token_address_bucket_start_pk" PRIMARY KEY("chain_id","token_address","bucket_start")
);
--> statement-breakpoint
CREATE INDEX "candle_dirty_buckets_oldest_idx" ON "candle_dirty_buckets" USING btree ("bucket_start");
--> statement-breakpoint
CREATE FUNCTION mark_candle_dirty_from_trade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    INSERT INTO candle_dirty_buckets (chain_id, token_address, bucket_start)
    VALUES (OLD.chain_id, OLD.token_address, (OLD.timestamp / 60) * 60)
    ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    INSERT INTO candle_dirty_buckets (chain_id, token_address, bucket_start)
    VALUES (NEW.chain_id, NEW.token_address, (NEW.timestamp / 60) * 60)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trades_mark_candle_dirty
AFTER INSERT OR UPDATE OR DELETE ON trades
FOR EACH ROW EXECUTE FUNCTION mark_candle_dirty_from_trade();
