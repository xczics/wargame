-- Owned by plugin: research
CREATE TABLE research_levels (
	player_id TEXT NOT NULL,
	tech TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 0),
	PRIMARY KEY (player_id, tech)
);

-- At most one research in progress per player.
CREATE TABLE research_progress (
	player_id TEXT PRIMARY KEY,
	tech TEXT NOT NULL,
	target_level INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);
