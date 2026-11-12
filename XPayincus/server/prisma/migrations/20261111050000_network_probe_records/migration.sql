CREATE TABLE "network_probe_records" (
  "id" TEXT PRIMARY KEY,
  "owner_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "package_id" INTEGER NOT NULL,
  "host_id" INTEGER NOT NULL,
  "target_id" VARCHAR(40) NOT NULL,
  "target_host" VARCHAR(253) NOT NULL,
  "target_label" VARCHAR(80) NOT NULL,
  "source" TEXT NOT NULL CHECK ("source" IN ('browser', 'manual-local')),
  "method" TEXT NOT NULL CHECK ("method" IN ('https', 'tcp', 'icmp')),
  "port" INTEGER,
  "measured_at" TIMESTAMP(3) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified" BOOLEAN NOT NULL DEFAULT FALSE CHECK ("verified" = FALSE),
  "samples" JSONB NOT NULL CHECK (jsonb_typeof("samples") = 'array' AND jsonb_array_length("samples") BETWEEN 1 AND 10),
  CHECK (("source" = 'browser' AND "method" = 'https') OR ("source" = 'manual-local' AND "method" IN ('tcp', 'icmp'))),
  CHECK (("method" = 'tcp' AND "port" IS NOT NULL AND "port" BETWEEN 1 AND 65535) OR ("method" <> 'tcp' AND "port" IS NULL))
);
CREATE INDEX "network_probe_records_owner_scope_time_idx" ON "network_probe_records" ("owner_id", "package_id", "host_id", "recorded_at" DESC);
CREATE INDEX "network_probe_records_recorded_at_idx" ON "network_probe_records" ("recorded_at" DESC);
