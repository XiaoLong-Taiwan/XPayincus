ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'paid';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'failed';
ALTER TABLE "hosting_withdrawals"
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "payment_reference" TEXT,
  ADD COLUMN "payment_proof" TEXT,
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "refunded_at" TIMESTAMP(3);

CREATE TABLE "provisioning_jobs" (
  "id" SERIAL PRIMARY KEY,
  "instance_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "phase" TEXT NOT NULL DEFAULT 'queued',
  "payload" TEXT NOT NULL,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provisioning_jobs_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "provisioning_jobs_instance_id_key" ON "provisioning_jobs"("instance_id");
CREATE INDEX "provisioning_jobs_status_idx" ON "provisioning_jobs"("status");
CREATE TABLE "provisioning_events" (
  "id" SERIAL PRIMARY KEY,
  "instance_id" INTEGER NOT NULL,
  "phase" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provisioning_events_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE
);
CREATE INDEX "provisioning_events_instance_id_id_idx" ON "provisioning_events"("instance_id", "id");
CREATE TABLE "stock_subscriptions" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "package_id" INTEGER NOT NULL REFERENCES "packages"("id") ON DELETE CASCADE,
  "plan_id" INTEGER NOT NULL REFERENCES "package_plans"("id") ON DELETE CASCADE,
  "region" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "cooldown_hours" INTEGER NOT NULL DEFAULT 24,
  "was_available" BOOLEAN NOT NULL DEFAULT false,
  "last_notified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "stock_subscriptions_user_id_plan_id_region_key" ON "stock_subscriptions"("user_id", "plan_id", "region");
CREATE INDEX "stock_subscriptions_package_id_active_idx" ON "stock_subscriptions"("package_id", "active");
CREATE TABLE "host_maintenance_plans" (
  "id" SERIAL PRIMARY KEY,
  "source_host_id" INTEGER NOT NULL REFERENCES "hosts"("id") ON DELETE RESTRICT,
  "target_host_id" INTEGER NOT NULL REFERENCES "hosts"("id") ON DELETE RESTRICT,
  "created_by" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "instance_ids" JSONB NOT NULL,
  "results" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "host_maintenance_plans_status_idx" ON "host_maintenance_plans"("status");
