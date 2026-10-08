CREATE TABLE IF NOT EXISTS "events" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "data" jsonb NOT NULL,
  "timestamp" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "runs" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_name" text NOT NULL,
  "event_id" text NOT NULL REFERENCES "events"("id"),
  "status" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "retry_after" timestamp with time zone,
  "error" text
);

CREATE TABLE IF NOT EXISTS "steps" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "runs"("id"),
  "name" text NOT NULL,
  "status" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "output" jsonb,
  "error" text
);

CREATE INDEX ON "runs" ("integration_name");
CREATE INDEX ON "runs" ("status");
CREATE INDEX ON "runs" ("started_at" DESC);
CREATE INDEX ON "runs" ("retry_after");
CREATE INDEX ON "steps" ("run_id");
