CREATE TYPE "public"."log_kind" AS ENUM('topic_created', 'topics_replenished', 'model_request', 'model_response', 'generation_step', 'publish', 'note');--> statement-breakpoint
CREATE TYPE "public"."log_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TABLE "logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid,
	"topic_id" uuid,
	"kind" "log_kind" NOT NULL,
	"action" "ai_action",
	"model" text,
	"key_label" text,
	"source" "log_source",
	"message" text NOT NULL,
	"detail" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "log_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logs_post_idx" ON "logs" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_project_idx" ON "logs" USING btree ("project_id","created_at");
--> statement-breakpoint
UPDATE "projects" -- carry the old pair of switches over to the single one
   SET "log_enabled" = true
 WHERE "log_retention_days" IS NOT NULL AND false;
