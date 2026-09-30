-- Owned by the kernel engine: optimistic locks for units of work (see src/kernel/engine.ts).
CREATE TABLE engine_locks (
	-- e.g. "player:<id>"; later "city:<id>" etc.
	entity TEXT PRIMARY KEY,
	version INTEGER NOT NULL
);

-- A commit must move the version by exactly one from what it read. If another commit
-- got there first, abort the whole batch; the engine retries on fresh data.
CREATE TRIGGER engine_locks_cas BEFORE UPDATE ON engine_locks
WHEN NEW.version != OLD.version + 1
BEGIN
	SELECT RAISE(ABORT, 'version_conflict');
END;
