ALTER TABLE "hosts"
ADD COLUMN "monitoring_visible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "monitoring_display_name" TEXT,
ADD COLUMN "monitoring_category" TEXT;
