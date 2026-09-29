ALTER TABLE "trades" ADD COLUMN "trader_address" text;--> statement-breakpoint
CREATE INDEX "trades_trader_idx" ON "trades" USING btree ("chain_id","trader_address");