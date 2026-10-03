-- items: failures counted towards pity (chances with a sure try), for any plugin's items. Takes over from
-- starter_items_pity (kept this version, dropped in a later one); targets are now namespaced by plugin.
CREATE TABLE items_pity (
	player_id TEXT NOT NULL,
	target TEXT NOT NULL,
	fails INTEGER NOT NULL CHECK (fails >= 0),
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, target)
);
CREATE INDEX items_pity_expires ON items_pity (expires_at);
INSERT INTO items_pity (player_id, target, fails, expires_at)
	SELECT player_id, 'starter-items:' || target, fails, expires_at FROM starter_items_pity;
