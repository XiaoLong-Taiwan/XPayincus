DROP TABLE IF EXISTS "proxy_sites";

DROP TYPE IF EXISTS "ProxySiteStatus";

ALTER TABLE "hosts"
  DROP COLUMN IF EXISTS "caddy_enabled",
  DROP COLUMN IF EXISTS "caddy_username",
  DROP COLUMN IF EXISTS "caddy_password",
  DROP COLUMN IF EXISTS "caddy_port";

ALTER TABLE "packages"
  DROP COLUMN IF EXISTS "site_limit";

ALTER TABLE "instances"
  DROP COLUMN IF EXISTS "site_limit";

ALTER TABLE "package_plans"
  DROP COLUMN IF EXISTS "site_limit";
