ALTER TABLE "provisioning_jobs"
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "error_detail" TEXT,
  ADD COLUMN "error_request_id" TEXT,
  ADD COLUMN "error_retryable" BOOLEAN;
