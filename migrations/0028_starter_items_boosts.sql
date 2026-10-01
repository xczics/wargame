-- Owned by plugin: starter-items. Timed production boosts on settlements (harvest prayer); a row is
-- active until its end event removes it (the engine settles production up to that moment first).
CREATE TABLE starter_items_boosts (
	settlement_id TEXT PRIMARY KEY,
	percent REAL NOT NULL CHECK (percent >= 0),
	until INTEGER NOT NULL
);
