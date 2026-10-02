-- Owned by plugin: heroes. Candidates the GM placed at a settlement's venue (they stay until recruited, free).
CREATE TABLE heroes_gifts (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	venue TEXT NOT NULL,
	draft TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX heroes_gifts_place ON heroes_gifts (settlement_id, venue);
