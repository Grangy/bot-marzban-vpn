-- Ensure one Remnawave user (uuid) can be linked only once.
-- SQLite allows multiple NULLs in UNIQUE index, so optional field is ok.
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_remnawaveUuid_key"
ON "Subscription"("remnawaveUuid");

