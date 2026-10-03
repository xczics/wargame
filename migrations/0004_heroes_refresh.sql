-- heroes: a venue's candidates rolled again within its current window (by an item): which window, how often.
CREATE TABLE heroes_refresh (
	settlement_id TEXT NOT NULL,
	venue TEXT NOT NULL,
	win INTEGER NOT NULL,
	salt INTEGER NOT NULL CHECK (salt >= 0),
	PRIMARY KEY (settlement_id, venue)
);
