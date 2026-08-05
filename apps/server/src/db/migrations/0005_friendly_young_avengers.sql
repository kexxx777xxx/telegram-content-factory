ALTER TABLE "api_keys" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_default_uniq" ON "api_keys" USING btree ("provider") WHERE "api_keys"."is_default";
--> statement-breakpoint
UPDATE "api_keys" -- no default key means nothing generates: promote the oldest
   SET "is_default" = true
 WHERE "id" IN (
   SELECT DISTINCT ON ("provider") "id"
     FROM "api_keys"
    WHERE "enabled"
    ORDER BY "provider", "created_at"
 );
