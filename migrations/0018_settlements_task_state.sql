-- What a settlements background task last did, kept across restarts (1.4.1): `topUpSlots` stores the fixed district
-- sizes it has topped every player's settlement up to, so it scans again only when those sizes change (a GM rule).
CREATE TABLE settlements_task_state (
	task TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
