DROP TABLE "post_logs" CASCADE;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "log_requests";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "log_responses";--> statement-breakpoint
DROP TYPE "public"."post_log_phase";