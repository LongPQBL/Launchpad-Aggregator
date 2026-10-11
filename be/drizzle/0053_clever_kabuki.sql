ALTER TABLE "pool_tvl_buckets" DROP CONSTRAINT "pool_tvl_buckets_protocol";--> statement-breakpoint
ALTER TABLE "pool_tvl_snapshots" DROP CONSTRAINT "pool_tvl_snapshots_protocol";--> statement-breakpoint
ALTER TABLE "pool_tvl_buckets" ADD CONSTRAINT "pool_tvl_buckets_protocol" CHECK ("pool_tvl_buckets"."protocol" IN ('uniswap_v4', 'uniswap_v3', 'uniswap_v2'));--> statement-breakpoint
ALTER TABLE "pool_tvl_snapshots" ADD CONSTRAINT "pool_tvl_snapshots_protocol" CHECK ("pool_tvl_snapshots"."protocol" IN ('uniswap_v4', 'uniswap_v3', 'uniswap_v2'));