-- Which billing plan a key is on.
--
-- Batch is a paid-plan feature. Without knowing the plan the switch could be
-- turned on for a free key, and the failure surfaced hours later at submit —
-- when a post was already counting on the cheap tier.
--
-- Only the `tier` statements are here. drizzle-kit regenerated the whole
-- topics→posts diff alongside them, because 0012 and 0013 were hand-written and
-- left no meta snapshots for it to compare against; those statements are
-- already applied and were removed. The snapshot beside this file *is* kept —
-- it is the accurate current state, and future `db:generate` runs diff from it.

CREATE TYPE "public"."key_tier" AS ENUM('free', 'paid');
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tier" "key_tier" DEFAULT 'free' NOT NULL;
--> statement-breakpoint

-- A key already batching is demonstrably on the paid plan: the vendor would
-- have rejected the submissions otherwise. Marking it free would silently
-- switch batching off for it.
UPDATE "api_keys" SET "tier" = 'paid' WHERE "batch_enabled" = true;
