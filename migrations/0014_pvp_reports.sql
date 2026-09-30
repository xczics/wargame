-- Owned by plugin: pvp. Battle reports from the defender's side.
CREATE TABLE pvp_reports (
	id TEXT PRIMARY KEY,
	defender_id TEXT NOT NULL,
	attacker_id TEXT NOT NULL,
	settlement_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	report TEXT NOT NULL
);
CREATE INDEX pvp_reports_defender ON pvp_reports (defender_id, at);
