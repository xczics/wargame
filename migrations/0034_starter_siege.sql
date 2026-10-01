-- Owned by plugin: starter-siege (docs/design/gameplay.md §3.13).
-- Wall works (moat...) by level.
CREATE TABLE starter_siege_works (
	settlement_id TEXT NOT NULL,
	work TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 1),
	PRIMARY KEY (settlement_id, work)
);
-- Siege defences built, by kind.
CREATE TABLE starter_siege_devices (
	settlement_id TEXT NOT NULL,
	device TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (settlement_id, device)
);
-- What is being built at a wall (one job at a time): a batch of defences or a work's next level.
CREATE TABLE starter_siege_queue (
	settlement_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('device', 'work')),
	item TEXT NOT NULL,
	amount INTEGER NOT NULL CHECK (amount >= 1),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);
