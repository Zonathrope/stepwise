-- Events browser: list events newest first / by name, and look up runs per event
CREATE INDEX IF NOT EXISTS "events_timestamp_idx" ON "events" ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "events_name_idx" ON "events" ("name");
CREATE INDEX IF NOT EXISTS "runs_event_id_idx" ON "runs" ("event_id");
