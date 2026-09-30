-- Owned by plugin: troops
CREATE TABLE troops_garrison (
	settlement_id TEXT NOT NULL,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (settlement_id, unit)
);

-- One training batch at a time per settlement.
CREATE TABLE troops_training (
	settlement_id TEXT PRIMARY KEY,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count > 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);
