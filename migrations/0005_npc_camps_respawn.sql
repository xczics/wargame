-- npc-camps: a world's camps are placed when its map is imported; afterwards only uprooted ones are tracked,
-- and a background task replaces them elsewhere.
CREATE TABLE npc_camps_respawn (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	removed_at INTEGER NOT NULL
);
-- The seeding of the world's camps: "pass" (the density it is for), "cursor" (next block), "done" (the density
-- of the last finished pass). A world short of camps (or a new density) is seeded a few blocks a minute.
CREATE TABLE npc_camps_seeding (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
