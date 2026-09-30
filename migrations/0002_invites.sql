-- Owned by plugin: invites
CREATE TABLE invites_codes (
	code TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	max_uses INTEGER NOT NULL DEFAULT 1,
	uses INTEGER NOT NULL DEFAULT 0,
	note TEXT,
	revoked_at INTEGER
);

CREATE TABLE invites_redemptions (
	code TEXT NOT NULL REFERENCES invites_codes (code),
	user_id TEXT NOT NULL,
	redeemed_at INTEGER NOT NULL,
	PRIMARY KEY (code, user_id)
);
