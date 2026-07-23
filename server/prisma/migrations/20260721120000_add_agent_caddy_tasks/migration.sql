ALTER TABLE "hosts"
ADD COLUMN "caddy_ca_certificate" TEXT,
ADD COLUMN "caddy_task_id" TEXT,
ADD COLUMN "caddy_task_status" TEXT,
ADD COLUMN "caddy_task_username" TEXT,
ADD COLUMN "caddy_task_password_encrypted" TEXT,
ADD COLUMN "caddy_task_port" INTEGER,
ADD COLUMN "caddy_task_requested_at" TIMESTAMP(3),
ADD COLUMN "caddy_task_completed_at" TIMESTAMP(3),
ADD COLUMN "caddy_task_error" TEXT;

CREATE UNIQUE INDEX "hosts_caddy_task_id_key" ON "hosts"("caddy_task_id");
