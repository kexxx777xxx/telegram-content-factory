CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "post_max_chars" integer DEFAULT 1024 NOT NULL;--> statement-breakpoint
-- The length limit was written into the shipped prompt as a literal 1024, so an
-- existing installation would keep asking for 1024 characters no matter what the
-- new setting says. Prompts still carrying that exact line are switched to the
-- variable; an operator who rewrote the sentence is left alone.
UPDATE "prompts"
SET "body" = replace("body", 'Тримайся в межах 1024 символів', 'Тримайся в межах {{maxChars}} символів')
WHERE "action" = 'post_text' AND "body" LIKE '%Тримайся в межах 1024 символів%';