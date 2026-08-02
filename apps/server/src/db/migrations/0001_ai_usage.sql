CREATE TABLE "api_key_usage" (
	"api_key_id" uuid NOT NULL,
	"day" text NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_usage_api_key_id_day_model_pk" PRIMARY KEY("api_key_id","day","model")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rpm_limit" integer;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_usage_day_idx" ON "api_key_usage" USING btree ("day");