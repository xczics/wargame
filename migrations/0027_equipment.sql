-- Owned by plugin: equipment (docs/design/gameplay.md §10). One row per piece, each with its own rolled numbers.
CREATE TABLE equipment_items (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	base TEXT NOT NULL,
	slot TEXT NOT NULL,
	tier INTEGER NOT NULL CHECK (tier >= 1),
	rarity TEXT NOT NULL,
	-- JSON { stat: value }, e.g. { "adv.attack": 31, "battle.attack": 2.1, "attr.might": 12 }.
	stats TEXT NOT NULL,
	-- The hero wearing it (null = in the bag).
	hero_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX equipment_items_player ON equipment_items (player_id);
-- One piece per slot per hero.
CREATE UNIQUE INDEX equipment_items_worn ON equipment_items (hero_id, slot) WHERE hero_id IS NOT NULL;
