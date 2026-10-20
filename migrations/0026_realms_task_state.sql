-- What the realms' background task last finished at (1.5.1): `sites` holds the rules' version and code with which every
-- realm had all its sites, so the next runs read this row and the rules' version only, until either moves.
CREATE TABLE realms_task_state (
	task TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
