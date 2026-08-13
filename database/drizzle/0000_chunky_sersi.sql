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
	CONSTRAINT "candles_symbol_resolution_time_pk" PRIMARY KEY("symbol","resolution","time"),
	CONSTRAINT "candles_resolution_check" CHECK ("candles"."resolution" = 1)
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
	"candles_inserted" integer DEFAULT 0,
	"trading_day" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "symbol_access_log" (
	"symbol" text PRIMARY KEY NOT NULL,
	"last_accessed" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_state" (
	"symbol" text NOT NULL,
	"resolution" integer DEFAULT 1 NOT NULL,
	"last_checked" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok" timestamp with time zone,
	"status" text DEFAULT 'unknown' NOT NULL,
	"issue" text,
	CONSTRAINT "validation_state_symbol_resolution_pk" PRIMARY KEY("symbol","resolution")
);
--> statement-breakpoint
CREATE TABLE "nse_options_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"expiry_type" text NOT NULL,
	"strike" double precision NOT NULL,
	"option_type" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nse_options_candles_underlying_expiry_date_strike_option_type_time_pk" PRIMARY KEY("underlying","expiry_date","strike","option_type","time"),
	CONSTRAINT "nse_options_expiry_type_check" CHECK ("nse_options_candles"."expiry_type" IN ('weekly','monthly')),
	CONSTRAINT "nse_options_option_type_check" CHECK ("nse_options_candles"."option_type" IN ('CE','PE'))
);
--> statement-breakpoint
CREATE TABLE "mcx_options_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"strike" double precision NOT NULL,
	"option_type" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcx_options_candles_underlying_expiry_date_strike_option_type_time_pk" PRIMARY KEY("underlying","expiry_date","strike","option_type","time"),
	CONSTRAINT "mcx_options_option_type_check" CHECK ("mcx_options_candles"."option_type" IN ('CE','PE'))
);
--> statement-breakpoint
CREATE TABLE "nse_futures_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nse_futures_candles_underlying_expiry_date_time_pk" PRIMARY KEY("underlying","expiry_date","time")
);
--> statement-breakpoint
CREATE TABLE "mcx_futures_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcx_futures_candles_underlying_expiry_date_time_pk" PRIMARY KEY("underlying","expiry_date","time")
);
--> statement-breakpoint
CREATE TABLE "bse_options_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"expiry_type" text NOT NULL,
	"strike" double precision NOT NULL,
	"option_type" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bse_options_candles_underlying_expiry_date_strike_option_type_time_pk" PRIMARY KEY("underlying","expiry_date","strike","option_type","time"),
	CONSTRAINT "bse_options_expiry_type_check" CHECK ("bse_options_candles"."expiry_type" IN ('weekly','monthly')),
	CONSTRAINT "bse_options_option_type_check" CHECK ("bse_options_candles"."option_type" IN ('CE','PE'))
);
--> statement-breakpoint
CREATE TABLE "bse_futures_candles" (
	"underlying" text NOT NULL,
	"expiry_date" date NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"oi" bigint,
	"symbol" text NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bse_futures_candles_underlying_expiry_date_time_pk" PRIMARY KEY("underlying","expiry_date","time")
);
--> statement-breakpoint
CREATE INDEX "idx_candles_symbol_res_time" ON "candles" USING btree ("symbol","resolution","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_candles_inserted_at" ON "candles" USING btree ("inserted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_repair_log_symbol_time" ON "repair_log" USING btree ("symbol","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_repair_log_symbol_day" ON "repair_log" USING btree ("symbol","trading_day","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_symbol_access_log_last_accessed" ON "symbol_access_log" USING btree ("last_accessed" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_nse_options_symbol_time" ON "nse_options_candles" USING btree ("symbol","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcx_options_symbol_time" ON "mcx_options_candles" USING btree ("symbol","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_nse_futures_symbol_time" ON "nse_futures_candles" USING btree ("symbol","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcx_futures_symbol_time" ON "mcx_futures_candles" USING btree ("symbol","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_bse_options_symbol_time" ON "bse_options_candles" USING btree ("symbol","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_bse_futures_symbol_time" ON "bse_futures_candles" USING btree ("symbol","time" DESC NULLS LAST);