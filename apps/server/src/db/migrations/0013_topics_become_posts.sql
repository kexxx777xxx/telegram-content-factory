-- Step two: move every topic into `posts` and drop the table.
--
-- A topic was always a post that only had its subject. Keeping them apart meant
-- two APIs and two lists for rows an operator reads as one thing, so the row
-- moves and the distinction becomes a status.

-- Topics already bound to a post: fold their fields into that post.
UPDATE "posts" p
   SET "normalized_hash" = t."normalized_hash",
       "category"        = t."category",
       "source"          = t."source"::text::"post_source"
  FROM "topics" t
 WHERE p."topic_id" = t."id";
--> statement-breakpoint

-- Unbound topics become idea rows. `rejected` keeps its hash so the same
-- subject is not proposed again, but lands in `skipped` — the post-side name
-- for "decided against".
INSERT INTO "posts" ("project_id", "status", "scheduled_at", "topic_title",
                     "normalized_hash", "category", "source", "created_at", "updated_at")
SELECT t."project_id",
       CASE WHEN t."status" = 'rejected' THEN 'skipped'::"post_status"
            ELSE 'idea'::"post_status" END,
       NULL,
       t."title",
       t."normalized_hash",
       t."category",
       t."source"::text::"post_source",
       t."created_at",
       now()
  FROM "topics" t
 WHERE NOT EXISTS (SELECT 1 FROM "posts" p WHERE p."topic_id" = t."id")
   AND t."status" <> 'used';
--> statement-breakpoint

-- `used` topics with no post are history with nothing to attach to; their hash
-- still has to block a repeat, so they land as skipped rows carrying it.
INSERT INTO "posts" ("project_id", "status", "scheduled_at", "topic_title",
                     "normalized_hash", "category", "source", "created_at", "updated_at")
SELECT t."project_id", 'skipped'::"post_status", NULL, t."title",
       t."normalized_hash", t."category", t."source"::text::"post_source",
       t."created_at", now()
  FROM "topics" t
 WHERE NOT EXISTS (SELECT 1 FROM "posts" p WHERE p."topic_id" = t."id")
   AND t."status" = 'used'
   AND NOT EXISTS (
     SELECT 1 FROM "posts" p2
      WHERE p2."project_id" = t."project_id"
        AND p2."normalized_hash" = t."normalized_hash"
   );
--> statement-breakpoint

ALTER TABLE "logs" DROP COLUMN IF EXISTS "topic_id";
--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN IF EXISTS "topic_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "topics";
--> statement-breakpoint
DROP TYPE IF EXISTS "topic_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "topic_source";
--> statement-breakpoint

CREATE UNIQUE INDEX "posts_project_hash_uniq"
    ON "posts" ("project_id", "normalized_hash")
 WHERE "normalized_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "posts_idea_idx" ON "posts" ("project_id", "status", "created_at");
