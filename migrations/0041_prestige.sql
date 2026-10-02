-- Owned by plugin: prestige (docs/design/gameplay.md §12.1). One row per player.
-- value: prestige now (falls when bandits win); best: the highest it has been (ranks never fall);
-- recent: prestige gained lately, decaying with time from recent_at (a closed-form "last day").
CREATE TABLE prestige_players (
	player_id TEXT PRIMARY KEY,
	value REAL NOT NULL CHECK (value >= 0),
	best REAL NOT NULL CHECK (best >= value),
	recent REAL NOT NULL CHECK (recent >= 0),
	recent_at INTEGER NOT NULL
);
