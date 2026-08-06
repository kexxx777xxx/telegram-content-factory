CREATE TYPE "public"."batch_state" AS ENUM('pending', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'collect_batch' BEFORE 'publish_post';--> statement-breakpoint
CREATE TABLE "batch_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid,
	"api_key_id" uuid NOT NULL,
	"action" "ai_action" NOT NULL,
	"model" text NOT NULL,
	"provider_name" text NOT NULL,
	"state" "batch_state" DEFAULT 'pending' NOT NULL,
	"prompt_id" uuid,
	"prompt_version" integer,
	"result_text" text,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "batch_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_jobs_state_idx" ON "batch_jobs" USING btree ("state","deadline");--> statement-breakpoint
CREATE INDEX "batch_jobs_post_idx" ON "batch_jobs" USING btree ("post_id","action");