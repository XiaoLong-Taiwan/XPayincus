ALTER TABLE "ssh_keys"
ADD COLUMN "private_key_encrypted" TEXT,
ADD COLUMN "registration_token_hash" TEXT,
ADD COLUMN "registration_token_expires_at" TIMESTAMP(3),
ADD COLUMN "private_key_consumed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "ssh_keys_registration_token_hash_key" ON "ssh_keys"("registration_token_hash");
