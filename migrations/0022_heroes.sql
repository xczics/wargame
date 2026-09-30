-- Owned by plugin: heroes
CREATE TABLE heroes_heroes (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	-- Name parts (source language); the client translates and joins them.
	surname TEXT NOT NULL,
	given TEXT NOT NULL,
	gender TEXT NOT NULL CHECK (gender IN ('m', 'f')),
	-- Recruitment venue it came from (attributes only; afterwards all heroes are alike).
	origin TEXT NOT NULL,
	-- JSON { attribute: value }.
	attrs TEXT NOT NULL,
	-- Settlement it is attached to.
	home TEXT NOT NULL,
	-- Current duty ("idle" by default) and what it is about (a settlement, an army...).
	duty TEXT NOT NULL DEFAULT 'idle',
	duty_target TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX heroes_heroes_player ON heroes_heroes (player_id);
CREATE INDEX heroes_heroes_duty ON heroes_heroes (duty, duty_target);

-- Candidates already recruited: candidates are derived from (settlement, venue, refresh window `win`),
-- so only the taken ones are stored.
CREATE TABLE heroes_taken (
	settlement_id TEXT NOT NULL,
	venue TEXT NOT NULL,
	win INTEGER NOT NULL,
	slot INTEGER NOT NULL,
	PRIMARY KEY (settlement_id, venue, win, slot)
);

-- A settlement's order of defending heroes (JSON array of hero ids); none = strongest first.
CREATE TABLE heroes_defense (
	settlement_id TEXT PRIMARY KEY,
	heroes TEXT NOT NULL
);
