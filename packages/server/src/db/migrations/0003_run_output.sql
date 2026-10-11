-- Handler return value, stored when a run completes
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "output" jsonb;
