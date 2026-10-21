-- One row per battle, shared by the reports that tell of it (the attacker's and the defender's mail keep only its id).
-- `refs`: how many mails still point at it; the row goes with the last of them (war-reports, mail.onRemoved).
CREATE TABLE war_reports_battles (
	id TEXT PRIMARY KEY,
	at INTEGER NOT NULL,
	-- The BattleReport, as JSON.
	data TEXT NOT NULL,
	refs INTEGER NOT NULL CHECK (refs >= 0)
);
