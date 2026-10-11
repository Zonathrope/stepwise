-- Handler version guard: declared handler version and the recorded step sequence per run
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "handler_version" text;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "step_journal" jsonb NOT NULL DEFAULT '[]'::jsonb;
