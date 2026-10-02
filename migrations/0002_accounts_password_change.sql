-- Accounts that must change their password before playing (the GM after logging in with the initial
-- GM_PASSWORD). Every account's password, the GM's included, is a hash in accounts_users.
ALTER TABLE accounts_users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1));
