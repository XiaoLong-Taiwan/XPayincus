CREATE TYPE "HostingAccessApplicationStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "hosting_access_applications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" "HostingAccessApplicationStatus" NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(1000) NOT NULL,
    "review_reason" VARCHAR(1000),
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hosting_access_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hosting_access_applications_user_id_key" ON "hosting_access_applications"("user_id");
CREATE INDEX "hosting_access_applications_status_created_at_idx" ON "hosting_access_applications"("status", "created_at" DESC);
CREATE INDEX "hosting_access_applications_reviewed_by_id_idx" ON "hosting_access_applications"("reviewed_by_id");
ALTER TABLE "hosting_access_applications" ADD CONSTRAINT "hosting_access_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hosting_access_applications" ADD CONSTRAINT "hosting_access_applications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
