-- Owned by plugin: starter-levies. Training quota per player and unit (won with levy orders, spent by training).
CREATE TABLE starter_levies_quota (
	player_id TEXT NOT NULL,
	unit TEXT NOT NULL,
	quota INTEGER NOT NULL CHECK (quota >= 0),
	PRIMARY KEY (player_id, unit)
);
