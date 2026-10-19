-- Values worked out from the database that change only when their tables do (`api.derived`, 2026-10-19): e.g. a
-- settlement's production rates, their breakdown and its storage cap, read back as one row instead of a dozen tables.
-- A row holds while the tables it read (`codes`, their owner's versions adding up to `sum`) and the rules are unchanged.
CREATE TABLE engine_derived (
	key TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	rules INTEGER NOT NULL,
	salt TEXT NOT NULL,
	codes TEXT NOT NULL,
	sum INTEGER NOT NULL CHECK (sum >= 0),
	value TEXT NOT NULL
);
-- All of a player's are read at once (a page shows several settlements' numbers).
CREATE INDEX engine_derived_owner ON engine_derived (owner);
