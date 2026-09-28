CREATE TABLE "observed_blocks" (
	"chain_id" integer NOT NULL,
	"number" bigint NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "observed_blocks_chain_id_number_pk" PRIMARY KEY("chain_id","number")
);
