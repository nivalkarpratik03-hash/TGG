-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "symbol_access_log" (
	"symbol" text PRIMARY KEY NOT NULL,
	"last_accessed" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repair_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"resolution" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"detail" text,
	"candles_deleted" integer DEFAULT 0,
	"candles_inserted" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "validation_state" (
	"symbol" text NOT NULL,
	"resolution" integer NOT NULL,
	"last_checked" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok" timestamp with time zone,
	"status" text DEFAULT 'unknown' NOT NULL,
	"issue" text,
	CONSTRAINT "validation_state_pkey" PRIMARY KEY("resolution","symbol")
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"symbol" text NOT NULL,
	"resolution" integer NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"validated" boolean DEFAULT true NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candles_pkey" PRIMARY KEY("resolution","symbol","time")
);
--> statement-breakpoint
CREATE INDEX "idx_symbol_access_log_last_accessed" ON "symbol_access_log" USING btree ("last_accessed" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_repair_log_symbol_time" ON "repair_log" USING btree ("symbol" text_ops,"started_at" text_ops);--> statement-breakpoint
CREATE INDEX "candles_symbol_time_idx" ON "candles" USING btree ("symbol" text_ops,"time" text_ops);--> statement-breakpoint
CREATE INDEX "candles_time_idx" ON "candles" USING btree ("time" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_candles_inserted_at" ON "candles" USING btree ("inserted_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_candles_symbol_res_time" ON "candles" USING btree ("symbol" text_ops,"resolution" text_ops,"time" int4_ops);
*/