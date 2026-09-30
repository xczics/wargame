-- Owned by plugin: gm
CREATE TABLE gm_config (
	key TEXT PRIMARY KEY,
	-- JSON-encoded override, validated by the owning plugin's config parser before being stored.
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL
);

CREATE TABLE gm_audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	detail TEXT
);
