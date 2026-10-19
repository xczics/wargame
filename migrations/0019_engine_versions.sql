-- Server versions (1.4.1): when each started serving, and where the rules in force with it are kept (a file of the
-- bucket: every rule's effective value, GM overrides included, ~1.5 MB), so time before an upgrade is settled at the
-- numbers of its day (EngineContext.upgrade).
CREATE TABLE engine_versions (
	version TEXT PRIMARY KEY,
	started_at INTEGER NOT NULL,
	file TEXT NOT NULL
);
