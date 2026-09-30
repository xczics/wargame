-- Owned by plugin: items
CREATE TABLE items_inventory (
	player_id TEXT NOT NULL,
	item TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (player_id, item)
);
