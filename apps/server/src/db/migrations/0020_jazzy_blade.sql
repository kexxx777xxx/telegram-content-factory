ALTER TABLE "posts" ADD COLUMN "position" integer;--> statement-breakpoint
CREATE INDEX "posts_queue_idx" ON "posts" USING btree ("project_id","status","position");--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "lead_time_minutes";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "miss_policy";--> statement-breakpoint
DROP TYPE "public"."miss_policy";--> statement-breakpoint
-- Пост більше не володіє хвилиною: час лишається тільки там, де його обрала
-- людина. Усе, що планувальник роздав наперед, стає звичайною чергою.
UPDATE "posts" SET "scheduled_at" = NULL
 WHERE "status" IN ('planned', 'generating', 'ready', 'awaiting_approval');--> statement-breakpoint
-- Слоти, що згоріли за старою політикою «пропустити»: готовий текст повертається
-- в чергу, гола тема — у банк. Черга не має способу пропустити пост, тож ці
-- рядки більше нікуди не подінуться.
UPDATE "posts"
   SET "status" = (CASE WHEN "text_html" IS NOT NULL THEN 'planned' ELSE 'idea' END)::post_status,
       "scheduled_at" = NULL,
       "error" = NULL
 WHERE "status" = 'skipped';
