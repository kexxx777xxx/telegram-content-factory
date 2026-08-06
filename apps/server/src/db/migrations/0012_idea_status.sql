-- Step one of merging topics into posts: make `idea` a post status.
--
-- The type is rebuilt rather than extended with `ALTER TYPE ... ADD VALUE`.
-- Postgres accepts that statement inside a transaction but refuses to *use* the
-- new label until the transaction commits — and the migrator runs every pending
-- file in one transaction, so 0013 could never reference 'idea'. Swapping the
-- type wholesale has no such rule.

ALTER TABLE "posts" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "post_status" RENAME TO "post_status_old";
--> statement-breakpoint
CREATE TYPE "post_status" AS ENUM(
  'idea', 'planned', 'generating', 'ready', 'awaiting_approval',
  'publishing', 'published', 'failed', 'skipped'
);
--> statement-breakpoint
ALTER TABLE "posts"
  ALTER COLUMN "status" TYPE "post_status" USING "status"::text::"post_status";
--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "status" SET DEFAULT 'planned';
--> statement-breakpoint
DROP TYPE "post_status_old";
--> statement-breakpoint

CREATE TYPE "post_source" AS ENUM('ai', 'manual');
--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "scheduled_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "normalized_hash" text;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "source" "post_source" DEFAULT 'ai' NOT NULL;
