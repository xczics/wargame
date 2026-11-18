-- Rebirth (docs/design/gameplay.md §17.1): how many times each hero was reborn. No row: never.
CREATE TABLE rebirth_heroes (
	hero_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 1)
);
CREATE INDEX rebirth_heroes_player ON rebirth_heroes (player_id);
