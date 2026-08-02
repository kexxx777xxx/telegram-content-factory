CREATE TYPE "public"."ai_action" AS ENUM('topics', 'post_text', 'svg', 'svg_repair', 'image_prompt');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('gemini');--> statement-breakpoint
CREATE TYPE "public"."image_mode" AS ENUM('svg', 'image_model', 'none');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('generate_post', 'generate_and_publish', 'publish_post', 'replenish_topics', 'prune', 'backup');--> statement-breakpoint
CREATE TYPE "public"."key_preference" AS ENUM('project_then_global', 'project_only', 'global_only');--> statement-breakpoint
CREATE TYPE "public"."key_scope" AS ENUM('global', 'project');--> statement-breakpoint
CREATE TYPE "public"."miss_policy" AS ENUM('publish_late', 'skip');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('planned', 'generating', 'ready', 'awaiting_approval', 'publishing', 'published', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."prompt_scope" AS ENUM('global', 'project', 'model');--> statement-breakpoint
CREATE TYPE "public"."publish_mode" AS ENUM('auto', 'approval');--> statement-breakpoint
CREATE TYPE "public"."topic_source" AS ENUM('ai', 'manual');--> statement-breakpoint
CREATE TYPE "public"."topic_status" AS ENUM('new', 'queued', 'used', 'rejected');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "ai_provider" DEFAULT 'gemini' NOT NULL,
	"label" text NOT NULL,
	"secret_enc" text NOT NULL,
	"scope" "key_scope" NOT NULL,
	"project_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"daily_request_budget" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"post_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"type" "job_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_chain_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"provider" "ai_provider" DEFAULT 'gemini' NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_id" uuid,
	"key_preference" "key_preference" DEFAULT 'project_then_global' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"action" "ai_action" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"topic_id" uuid,
	"status" "post_status" DEFAULT 'planned' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"topic_title" text,
	"text_html" text,
	"svg_source" text,
	"image_path" text,
	"image_kind" text,
	"tg_message_id" integer,
	"permalink" text,
	"generation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'paused' NOT NULL,
	"timezone" text DEFAULT 'Europe/Kyiv' NOT NULL,
	"language" text DEFAULT 'uk' NOT NULL,
	"persona" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"telegram_channel_id" text NOT NULL,
	"telegram_channel_username" text,
	"telegram_bot_token_enc" text,
	"admin_chat_id" text,
	"image_mode" "image_mode" DEFAULT 'svg' NOT NULL,
	"publish_mode" "publish_mode" DEFAULT 'auto' NOT NULL,
	"posts_buffer" integer DEFAULT 3 NOT NULL,
	"topics_buffer_min" integer DEFAULT 10 NOT NULL,
	"lead_time_minutes" integer DEFAULT 180 NOT NULL,
	"miss_policy" "miss_policy" DEFAULT 'publish_late' NOT NULL,
	"schedule" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "ai_action" NOT NULL,
	"scope" "prompt_scope" NOT NULL,
	"project_id" uuid,
	"model" text,
	"version" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_state" (
	"api_key_id" uuid NOT NULL,
	"model" text NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_state_api_key_id_model_pk" PRIMARY KEY("api_key_id","model")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"normalized_hash" text NOT NULL,
	"category" text,
	"status" "topic_status" DEFAULT 'new' NOT NULL,
	"source" "topic_source" DEFAULT 'ai' NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_chain_steps" ADD CONSTRAINT "model_chain_steps_chain_id_model_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."model_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_chain_steps" ADD CONSTRAINT "model_chain_steps_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_chains" ADD CONSTRAINT "model_chains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_state" ADD CONSTRAINT "rate_limit_state_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_scope_idx" ON "api_keys" USING btree ("scope","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_project_uniq" ON "api_keys" USING btree ("project_id","provider") WHERE "api_keys"."scope" = 'project';--> statement-breakpoint
CREATE INDEX "events_recent_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("run_after","priority") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uniq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('pending', 'running') and "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_chain_steps_position_uniq" ON "model_chain_steps" USING btree ("chain_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "model_chains_scope_uniq" ON "model_chains" USING btree ("project_id","action");--> statement-breakpoint
CREATE INDEX "posts_due_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_project_idx" ON "posts" USING btree ("project_id","status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_slot_uniq" ON "posts" USING btree ("project_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uniq" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "prompts_lookup_idx" ON "prompts" USING btree ("action","scope","project_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_active_global_uniq" ON "prompts" USING btree ("action","version") WHERE "prompts"."scope" = 'global';--> statement-breakpoint
CREATE INDEX "rate_limit_blocked_idx" ON "rate_limit_state" USING btree ("blocked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_project_hash_uniq" ON "topics" USING btree ("project_id","normalized_hash");--> statement-breakpoint
CREATE INDEX "topics_available_idx" ON "topics" USING btree ("project_id","status");