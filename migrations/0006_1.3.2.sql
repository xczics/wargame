-- 1.3.2: every schema and data change of this version, in one file (applied in this order).

-- mail: the unread count (on every page) reads only the unread rows instead of every message of the player.
CREATE INDEX mail_messages_unread ON mail_messages (player_id, read);

-- bandits: before 1.3.2, a band that arrived in the same catch-up that sent it lost its arrival event and stayed on
-- the map for good (read on every sync). Drop those: bands whose arrival is no longer scheduled.
DELETE FROM bandits_raids
WHERE NOT EXISTS (
	SELECT 1 FROM timeline_events WHERE type = 'bandits.arrive' AND json_extract(payload, '$.raid') = bandits_raids.id
);

-- equipment: what each hero wears, summed, in one row per player (bonuses read it on every sync instead of the pieces).
-- JSON { heroId: { stat: total } }; rewritten whenever a piece goes on or off.
CREATE TABLE equipment_totals (
	player_id TEXT PRIMARY KEY,
	totals TEXT NOT NULL
);
-- From the pieces worn now.
INSERT INTO equipment_totals (player_id, totals)
SELECT player_id, json_group_object(hero_id, json(sums))
FROM (
	SELECT player_id, hero_id, json_group_object(key, total) AS sums
	FROM (
		SELECT i.player_id, i.hero_id, j.key, SUM(j.value) AS total
		FROM equipment_items i, json_each(i.stats) j
		WHERE i.hero_id IS NOT NULL
		GROUP BY i.player_id, i.hero_id, j.key
	)
	GROUP BY player_id, hero_id
)
GROUP BY player_id;

-- settlements: slots added beyond a district's size (a wall's slot at founding, land grants), so that raising the
-- size by rule (fortress slots 6 / 3 -> 30 / 15 in 1.3.2) tops districts up to size + these, not to the size alone.
ALTER TABLE settlements_districts ADD COLUMN extra_slots INTEGER NOT NULL DEFAULT 0 CHECK (extra_slots >= 0);
-- Districts of players' settlements so far: what they have beyond the default sizes they were made with (inner 22,
-- resource fortress 6, military fortress 3; outer cities are rolled, their extras unknown and never topped up).
UPDATE settlements_districts
SET extra_slots = MAX(0, slots - (
	SELECT CASE
		WHEN settlements_districts.type = 'inner' THEN 22
		WHEN s.kind = 'fortress-resource' THEN 6
		WHEN s.kind = 'fortress-military' THEN 3
	END
	FROM settlements_settlements s WHERE s.id = settlements_districts.settlement_id
))
WHERE settlement_id IN (
	SELECT id FROM settlements_settlements
	WHERE owner_id IS NOT NULL AND kind IN ('capital', 'city', 'fortress-resource', 'fortress-military')
) AND type IN ('inner', 'core');

-- heroes: the building level a venue's candidates are rolled at when the building went up during their window
-- (they keep the level the window began with); NULL = the level now.
ALTER TABLE heroes_refresh ADD COLUMN level INTEGER;

-- npc-camps: camps placed next to a new capital (1.3.2): not counted in the world's seeding, not replaced once uprooted.
ALTER TABLE npc_camps_levels ADD COLUMN starter INTEGER NOT NULL DEFAULT 0 CHECK (starter IN (0, 1));

-- terrain: the map's version, in the URL its chunks are served under (browsers keep them); moved on by any change.
CREATE TABLE terrain_version (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version INTEGER NOT NULL
);
INSERT INTO terrain_version (id, version) VALUES (1, 1);

-- gm: the rules' version, moved on with every change of the overrides (static views are baked per version).
CREATE TABLE gm_config_version (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version INTEGER NOT NULL CHECK (version >= 0)
);
INSERT INTO gm_config_version (id, version) VALUES (1, 0);
