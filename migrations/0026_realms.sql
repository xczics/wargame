-- Owned by plugin: realms (docs/design/gameplay.md §9).
-- Where realms are on the map (the tile itself is held in world_map_tiles as "realm:<id>").
CREATE TABLE realms_sites (
	id TEXT PRIMARY KEY,
	realm TEXT NOT NULL,
	x INTEGER NOT NULL,
	y INTEGER NOT NULL
);
CREATE INDEX realms_sites_realm ON realms_sites (realm);

-- Realms a player has opened with a key.
CREATE TABLE realms_unlocked (
	player_id TEXT NOT NULL,
	realm TEXT NOT NULL,
	PRIMARY KEY (player_id, realm)
);

-- Adventures under way. `result` (JSON) is decided when it starts and paid out when it ends.
CREATE TABLE realms_adventures (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	hero_id TEXT NOT NULL UNIQUE,
	realm TEXT NOT NULL,
	task INTEGER NOT NULL CHECK (task >= 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	result TEXT NOT NULL
);
CREATE INDEX realms_adventures_player ON realms_adventures (player_id);

-- Heroes injured in a realm; healing_until is set once treatment starts.
CREATE TABLE realms_injuries (
	hero_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	healing_until INTEGER
);
CREATE INDEX realms_injuries_player ON realms_injuries (player_id);
