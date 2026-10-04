CREATE TABLE "candle_unpriced_buckets" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"bucket_start" integer NOT NULL,
	CONSTRAINT "candle_unpriced_buckets_chain_id_token_address_bucket_start_pk" PRIMARY KEY("chain_id","token_address","bucket_start")
);
