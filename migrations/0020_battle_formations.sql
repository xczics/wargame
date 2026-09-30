-- Owned by plugin: battle
-- A settlement's defence formation: JSON array of the unit family in each lane (5 lanes).
-- Settlements without a row use a default derived from their id until one is saved.
CREATE TABLE battle_formations (
	settlement_id TEXT PRIMARY KEY,
	lanes TEXT NOT NULL
);
