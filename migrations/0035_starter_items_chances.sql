-- Owned by plugin: starter-items (docs/design/gameplay.md §11.2).
-- Failed attempts of "may raise" items per target (e.g. one building's cap), for the pity rule.
-- A row stops counting once expires_at passes (a sweep deletes it).
CREATE TABLE starter_items_pity (
	player_id TEXT NOT NULL,
	target TEXT NOT NULL,
	fails INTEGER NOT NULL CHECK (fails >= 0),
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, target)
);
CREATE INDEX starter_items_pity_expires ON starter_items_pity (expires_at);
-- Outer cities a settlement may build beyond its research limit, won with expansion permits.
CREATE TABLE starter_items_outer (
	settlement_id TEXT PRIMARY KEY,
	extra INTEGER NOT NULL CHECK (extra >= 0)
);
