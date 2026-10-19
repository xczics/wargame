-- The usage guard (1.4.1): one row, whether the game is paused near a paid limit (R2 beyond its free tier is billed),
-- when it last checked, and what it found.
CREATE TABLE usage_guard_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	tripped INTEGER NOT NULL DEFAULT 0 CHECK (tripped IN (0, 1)),
	checked_at INTEGER NOT NULL DEFAULT 0,
	usage TEXT NOT NULL DEFAULT '{}'
);
