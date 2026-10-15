CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "launches_name_trgm_idx" ON "launches" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "launches_symbol_trgm_idx" ON "launches" USING gin ("symbol" gin_trgm_ops);