-- Owned by plugin: accounts
CREATE TABLE accounts_users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	-- PBKDF2-SHA256, base64. Empty for the GM row: the GM authenticates against the GM_PASSWORD secret.
	password_hash TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE accounts_sessions (
	-- SHA-256 of the cookie token; the raw token is never stored.
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES accounts_users (id) ON DELETE CASCADE,
	-- 1 if this session was opened with the GM_PASSWORD secret.
	gm INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX accounts_sessions_user ON accounts_sessions (user_id);
