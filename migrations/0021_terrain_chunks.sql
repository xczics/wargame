-- Owned by plugin: terrain
-- The map's terrain in 32 x 32 chunks: `data` is 1024 one-character terrain codes, row by row
-- (x fastest). Chunks without a row are all the default terrain.
CREATE TABLE terrain_chunks (
	cx INTEGER NOT NULL CHECK (cx >= 0 AND cx < 32),
	cy INTEGER NOT NULL CHECK (cy >= 0 AND cy < 32),
	data TEXT NOT NULL CHECK (length(data) = 1024),
	PRIMARY KEY (cx, cy)
);
