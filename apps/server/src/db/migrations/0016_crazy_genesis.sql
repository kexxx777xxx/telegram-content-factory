CREATE TYPE "public"."batch_mode" AS ENUM('partial', 'batch_only', 'off');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "batch_mode" "batch_mode" DEFAULT 'partial' NOT NULL;