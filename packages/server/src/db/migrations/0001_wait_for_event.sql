-- step.waitForEvent: filter describing the event a "waiting" run is parked on
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "waiting_for" jsonb;

CREATE INDEX IF NOT EXISTS "runs_waiting_event_idx"
  ON "runs" (("waiting_for"->>'event'))
  WHERE "status" = 'waiting';
