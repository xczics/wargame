-- queues: jobs waiting their turn at a settlement (troops training, wall defences). Takes over from
-- troops_queue and starter_siege_queue, whose rows move here the first time a settlement is used.
CREATE TABLE queues_jobs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	owner TEXT NOT NULL,
	line TEXT NOT NULL,
	seq INTEGER NOT NULL,
	payload TEXT NOT NULL,
	cost TEXT NOT NULL,
	started_at INTEGER,
	finishes_at INTEGER,
	CHECK (finishes_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX queues_jobs_owner ON queues_jobs (owner, seq);
