-- City system. Replaces the per-player economy of 0005/0006 (dev-only data) with
-- per-settlement pools, buildings with levels, a timeline and the world map.

-- generators is superseded by the buildings plugin.
DROP TABLE generators_owned;

-- resources: balances now belong to a "holder" entity (e.g. "settlement:<id>"), not a player.
DROP TABLE resources_balances;
CREATE TABLE resources_balances (
	holder TEXT NOT NULL,
	resource TEXT NOT NULL,
	-- May go slightly negative through upkeep (down to the GM-tunable debt limit), never
	-- through spending: the resources plugin checks that before writing.
	amount REAL NOT NULL,
	-- Net rate per second at settle time; only used by GM reports to estimate in SQL.
	rate REAL NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (holder, resource)
);
CREATE INDEX resources_balances_resource ON resources_balances (resource, amount);

-- Owned by plugin: timeline. Events due at a time for an entity, processed lazily in order.
CREATE TABLE timeline_events (
	id TEXT PRIMARY KEY,
	entity TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX timeline_events_entity_due ON timeline_events (entity, due_at);
CREATE INDEX timeline_events_due ON timeline_events (due_at);

-- Owned by plugin: world-map. Only occupied tiles are stored (the map is 1024x1024).
CREATE TABLE world_map_tiles (
	x INTEGER NOT NULL CHECK (x BETWEEN -511 AND 512),
	y INTEGER NOT NULL CHECK (y BETWEEN -511 AND 512),
	-- Occupying entity, e.g. "settlement:<id>".
	entity TEXT NOT NULL,
	PRIMARY KEY (x, y)
);
CREATE INDEX world_map_tiles_entity ON world_map_tiles (entity);

-- Owned by plugin: settlements.
CREATE TABLE settlements_settlements (
	id TEXT PRIMARY KEY,
	-- Registered settlement kind, e.g. "capital", "city", "fortress-resource", "npc-outpost".
	kind TEXT NOT NULL,
	-- NULL for NPC settlements.
	owner_id TEXT,
	name TEXT NOT NULL,
	-- Centre tile.
	x INTEGER NOT NULL,
	y INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX settlements_settlements_owner ON settlements_settlements (owner_id, kind);

CREATE TABLE settlements_districts (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL REFERENCES settlements_settlements (id) ON DELETE CASCADE,
	-- District type declared by the settlement kind: "inner", "outer", "core", ...
	type TEXT NOT NULL,
	-- Order within the settlement (inner = 0, outer cities 1..N in build order).
	idx INTEGER NOT NULL,
	-- Building slots. Fixed for inner/core, rolled at random for outer; items can raise it.
	slots INTEGER NOT NULL CHECK (slots >= 0),
	x INTEGER NOT NULL,
	y INTEGER NOT NULL,
	UNIQUE (settlement_id, idx)
);

-- Owned by plugin: buildings.
CREATE TABLE buildings_slots (
	district_id TEXT NOT NULL,
	slot INTEGER NOT NULL CHECK (slot >= 0),
	settlement_id TEXT NOT NULL,
	building TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 0),
	-- Per-instance level cap raised by breakthroughs (items); NULL = the building's regular cap.
	cap INTEGER,
	PRIMARY KEY (district_id, slot)
);
CREATE INDEX buildings_slots_settlement ON buildings_slots (settlement_id);
CREATE INDEX buildings_slots_building ON buildings_slots (building, level);

CREATE TABLE buildings_construction (
	district_id TEXT NOT NULL,
	slot INTEGER NOT NULL,
	settlement_id TEXT NOT NULL,
	building TEXT NOT NULL,
	target_level INTEGER NOT NULL CHECK (target_level >= 1),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	PRIMARY KEY (district_id, slot)
);
CREATE INDEX buildings_construction_settlement ON buildings_construction (settlement_id);
