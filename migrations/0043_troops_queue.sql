-- Owned by plugin: troops (docs/design/gameplay.md §2.5 "training plans"). One queue per settlement and
-- barracks type (`line` = the units' trainedAt): the first batch trains (started_at / finishes_at set), the
-- rest wait in `seq` order. `cost` (JSON) is what was paid, returned if a waiting plan is cancelled.
CREATE TABLE troops_queue (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	line TEXT NOT NULL,
	seq INTEGER NOT NULL,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count > 0),
	cost TEXT NOT NULL,
	started_at INTEGER,
	finishes_at INTEGER
);
CREATE INDEX troops_queue_settlement ON troops_queue (settlement_id, line, seq);
-- The batch training now moves over; its id is the settlement id, so the pending "trained" event (which
-- names only the settlement) still finds it. Its line ('') is filled in from the unit by the code.
INSERT INTO troops_queue (id, settlement_id, line, seq, unit, count, cost, started_at, finishes_at)
SELECT settlement_id, settlement_id, '', 0, unit, count, '{}', started_at, finishes_at FROM troops_training;
DELETE FROM troops_training;
