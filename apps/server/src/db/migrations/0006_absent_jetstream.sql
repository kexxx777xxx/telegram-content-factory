CREATE TYPE "public"."post_log_phase" AS ENUM('request', 'response', 'note');--> statement-breakpoint
CREATE TABLE "post_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action" "ai_action" NOT NULL,
	"model" text NOT NULL,
	"key_label" text,
	"phase" "post_log_phase" NOT NULL,
	"content" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "log_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "log_responses" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "log_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_logs" ADD CONSTRAINT "post_logs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_logs" ADD CONSTRAINT "post_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_logs_post_idx" ON "post_logs" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "post_logs_created_idx" ON "post_logs" USING btree ("created_at");