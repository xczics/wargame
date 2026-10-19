-- 1.4: protection from bandits (plugin bandits; items give it). While a player's `until` is ahead, no band is sent at
-- them (none drawn at all). No row = never protected; an expired row does no harm.
CREATE TABLE bandits_protection (
	player_id TEXT PRIMARY KEY,
	until INTEGER NOT NULL CHECK (until >= 0)
);
