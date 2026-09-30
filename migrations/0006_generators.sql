-- Owned by plugin: generators
CREATE TABLE generators_owned (
	player_id TEXT NOT NULL,
	generator TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (player_id, generator)
);

CREATE INDEX generators_owned_generator ON generators_owned (generator, count);
