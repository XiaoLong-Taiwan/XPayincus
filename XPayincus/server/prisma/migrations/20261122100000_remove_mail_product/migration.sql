DO $$
BEGIN
  IF to_regclass('public.mail_subscription_aff_bindings') IS NOT NULL THEN
    DELETE FROM "mail_subscription_aff_bindings";
  END IF;
END $$;
ALTER TABLE "aff_logs" DROP CONSTRAINT IF EXISTS "aff_logs_mail_subscription_id_fkey";
DROP INDEX IF EXISTS "aff_logs_mail_subscription_id_idx";
ALTER TABLE "aff_logs" DROP COLUMN IF EXISTS "mail_subscription_id";
DROP TABLE IF EXISTS "mail_subscription_aff_bindings";
DROP TABLE IF EXISTS "mail_accounts";
DROP TABLE IF EXISTS "mail_domains";
DROP TABLE IF EXISTS "mail_subscriptions";
DROP TABLE IF EXISTS "mail_plans";
DROP TABLE IF EXISTS "mail_sources";
DROP TYPE IF EXISTS "MailDomainStatus";
DROP TYPE IF EXISTS "MailSubscriptionStatus";
DROP TYPE IF EXISTS "MailBillingCycle";
