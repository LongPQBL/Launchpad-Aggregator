CREATE TABLE "envio_chain_progress" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"head_block" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
