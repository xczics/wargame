-- The map's versions by block of 32 x 32 tiles (user 2026-10-22: the map window is worked out again only when what it
-- shows changed): every change of a stored tile or of a settlement on the map moves its block on, by trigger, so the
-- window's stamp (world-map) sees others' moves too. Camps' states are moved on by their plugin (worldMap.changed).
CREATE TABLE world_map_versions (
	block TEXT PRIMARY KEY,
	version INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER world_map_versions_tile_insert AFTER INSERT ON world_map_tiles BEGIN
	INSERT INTO world_map_versions (block, version) VALUES (((NEW.x + 511) / 32) || ',' || ((NEW.y + 511) / 32), 1)
	ON CONFLICT (block) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER world_map_versions_tile_delete AFTER DELETE ON world_map_tiles BEGIN
	INSERT INTO world_map_versions (block, version) VALUES (((OLD.x + 511) / 32) || ',' || ((OLD.y + 511) / 32), 1)
	ON CONFLICT (block) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER world_map_versions_tile_update AFTER UPDATE ON world_map_tiles BEGIN
	INSERT INTO world_map_versions (block, version) VALUES (((NEW.x + 511) / 32) || ',' || ((NEW.y + 511) / 32), 1)
	ON CONFLICT (block) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER world_map_versions_settlement AFTER UPDATE OF name, owner_id, kind ON settlements_settlements BEGIN
	INSERT INTO world_map_versions (block, version) VALUES (((NEW.x + 511) / 32) || ',' || ((NEW.y + 511) / 32), 1)
	ON CONFLICT (block) DO UPDATE SET version = version + 1;
END;
