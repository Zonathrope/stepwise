-- Worker leases: which worker is executing a running run, and when it last proved it is alive
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "claimed_by" text;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;

-- The reaper scans running runs by heartbeat age
CREATE INDEX IF NOT EXISTS "runs_running_heartbeat_idx"
  ON "runs" ("heartbeat_at")
  WHERE "status" = 'running';
