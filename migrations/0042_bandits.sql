-- Owned by plugin: bandits (docs/design/gameplay.md §12.2-12.4).
-- A row once a player's bandit timeline is running (its next spawn is a timeline event).
CREATE TABLE bandits_players (
	player_id TEXT PRIMARY KEY,
	next_at INTEGER NOT NULL
);
-- Bands on their way to a player's settlement; deleted when they arrive and fight.
CREATE TABLE bandits_raids (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	settlement_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 1),
	lanes TEXT NOT NULL,
	heroes TEXT NOT NULL,
	appeared_at INTEGER NOT NULL,
	arrives_at INTEGER NOT NULL
);
CREATE INDEX bandits_raids_player ON bandits_raids (player_id, arrives_at);
CREATE INDEX bandits_raids_settlement ON bandits_raids (settlement_id);
