-- research: one queue per settlement instead of one per player. The UNIQUE constraint makes
-- "two settlements of the same player researching the same tech at once" impossible, even
-- under concurrent commands.
DROP TABLE research_progress;
CREATE TABLE research_queue (
	settlement_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	tech TEXT NOT NULL,
	target_level INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	UNIQUE (player_id, tech)
);
