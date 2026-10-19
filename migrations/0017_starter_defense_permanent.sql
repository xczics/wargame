-- 1.4: a settlement's permanent base defence (plugin starter-defense; e.g. a puzzle's reward), added to every lane after
-- every percentage. One row per settlement that has any.
CREATE TABLE starter_defense_permanent (
	settlement_id TEXT PRIMARY KEY,
	defense REAL NOT NULL CHECK (defense >= 0)
);
