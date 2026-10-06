CREATE TABLE "security_collector_checkpoints" (
	"stream" text NOT NULL,
	"block" bigint NOT NULL,
	"hash" "bytea" NOT NULL,
	"log_index" integer DEFAULT -1 NOT NULL,
	CONSTRAINT "security_collector_checkpoints_stream_block_pk" PRIMARY KEY("stream","block")
);

--> statement-breakpoint
CREATE TABLE "security_collector_events" (
	"stream" text NOT NULL,
	"block" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"hash" "bytea" NOT NULL,
	"timestamp_s" double precision NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "security_collector_events_stream_block_log_index_pk" PRIMARY KEY("stream","block","log_index"),
	CONSTRAINT "security_collector_timestamp" CHECK ("security_collector_events"."timestamp_s" >= 0 AND "security_collector_events"."timestamp_s" < 'Infinity'::double precision)
);

