-- The terrain of each settlement's own tiles (1.5.1): its districts and the free tiles around it where it may build
-- outer cities, one row a settlement (user 2026-10-20: "仅入表已经建城的格子。然后index不要存坐标，还是城池的主键").
-- Production and the city page read this row instead of the whole map file (about 1 MB) in every new isolate. `codes`
-- is a JSON object {"x,y": code}; the row holds for the map version it was read from (`terrain_version.version`).
CREATE TABLE terrain_settlements (
	settlement_id TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	codes TEXT NOT NULL
);
