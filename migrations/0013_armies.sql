-- Owned by plugin: armies. An army is a group of units away from home.
CREATE TABLE armies_marches (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	from_settlement TEXT NOT NULL,
	target_x INTEGER NOT NULL,
	target_y INTEGER NOT NULL,
	-- "outbound" until it reaches the target, then "returning".
	phase TEXT NOT NULL CHECK (phase IN ('outbound', 'returning')),
	-- JSON { unit: count } of the units still alive.
	units TEXT NOT NULL,
	-- JSON { resource: amount } carried home.
	loot TEXT NOT NULL DEFAULT '{}',
	-- JSON battle report of what happened at the target (null until it arrives).
	report TEXT,
	departed_at INTEGER NOT NULL,
	arrives_at INTEGER NOT NULL,
	returns_at INTEGER NOT NULL
);
CREATE INDEX armies_marches_player ON armies_marches (player_id);
