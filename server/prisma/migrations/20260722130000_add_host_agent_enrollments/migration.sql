CREATE TABLE "host_agent_enrollments" (
    "id" SERIAL NOT NULL,
    "host_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "host_agent_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "host_agent_enrollments_token_hash_key" ON "host_agent_enrollments"("token_hash");
CREATE INDEX "host_agent_enrollments_host_id_idx" ON "host_agent_enrollments"("host_id");
CREATE INDEX "host_agent_enrollments_expires_at_idx" ON "host_agent_enrollments"("expires_at");
ALTER TABLE "host_agent_enrollments" ADD CONSTRAINT "host_agent_enrollments_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
