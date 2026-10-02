-- Owned by plugin: starter-items. Permanent player stat bonuses won with items (e.g. +1 hero limit).
CREATE TABLE starter_items_stats (
	player_id TEXT NOT NULL,
	stat TEXT NOT NULL,
	amount REAL NOT NULL,
	PRIMARY KEY (player_id, stat)
);
