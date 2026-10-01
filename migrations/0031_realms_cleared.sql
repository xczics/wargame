-- Owned by plugin: realms. Tasks a player has cleared at least once (their possible drops are shown from then on).
CREATE TABLE realms_cleared (
	player_id TEXT NOT NULL,
	realm TEXT NOT NULL,
	task INTEGER NOT NULL,
	PRIMARY KEY (player_id, realm, task)
);
