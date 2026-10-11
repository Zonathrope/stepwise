-- Function concurrency limits (optionally per key), enforced at pickup across workers
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "concurrency_key" text;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "concurrency_limit" integer;

-- Pickup counts executing runs per key
CREATE INDEX IF NOT EXISTS "runs_running_concurrency_key_idx"
  ON "runs" ("concurrency_key")
  WHERE "status" = 'running' AND "concurrency_key" IS NOT NULL;
