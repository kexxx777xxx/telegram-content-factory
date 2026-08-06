ALTER TABLE "api_keys" ADD COLUMN "slot" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "image_style" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "api_keys" k -- number existing keys by age, oldest first
   SET "slot" = n.rn
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at") AS rn FROM "api_keys") n
 WHERE k."id" = n."id";
