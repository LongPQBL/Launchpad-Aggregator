ALTER TABLE "launch_volume24h_usd" DROP CONSTRAINT "launch_volume24h_usd_rank_valid";--> statement-breakpoint
ALTER TABLE "launch_volume24h_usd" ADD CONSTRAINT "launch_volume24h_usd_rank_valid" CHECK (
    ("launch_volume24h_usd"."rank_category" = 'positive' AND "launch_volume24h_usd"."rank_order" = 0 AND "launch_volume24h_usd"."volume_usd" > 0 AND "launch_volume24h_usd"."completeness_reason" IN ('complete', 'updating'))
    OR ("launch_volume24h_usd"."rank_category" = 'zero' AND "launch_volume24h_usd"."rank_order" = 1 AND "launch_volume24h_usd"."volume_usd" = 0 AND "launch_volume24h_usd"."completeness_reason" IN ('complete', 'updating'))
    OR ("launch_volume24h_usd"."rank_category" = 'null' AND "launch_volume24h_usd"."rank_order" = 2 AND "launch_volume24h_usd"."volume_usd" IS NULL)
  );