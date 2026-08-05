ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "model_chain_steps" DROP CONSTRAINT "model_chain_steps_api_key_id_api_keys_id_fk";
--> statement-breakpoint
DROP INDEX "api_keys_scope_idx";--> statement-breakpoint
DROP INDEX "api_keys_project_uniq";--> statement-breakpoint
ALTER TABLE "model_chains" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "model_chains" ADD CONSTRAINT "model_chains_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_enabled_idx" ON "api_keys" USING btree ("enabled");--> statement-breakpoint
UPDATE "projects" p -- carry old project-scoped keys to the new project setting
   SET "api_key_id" = k."id"
  FROM "api_keys" k
 WHERE k."project_id" = p."id" AND k."scope" = 'project' AND k."enabled";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "model_chain_steps" DROP COLUMN "key_preference";--> statement-breakpoint
ALTER TABLE "model_chain_steps" DROP COLUMN "api_key_id";--> statement-breakpoint
DROP TYPE "public"."key_preference";--> statement-breakpoint
DROP TYPE "public"."key_scope";