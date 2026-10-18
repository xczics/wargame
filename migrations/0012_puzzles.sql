-- 1.4: puzzles (plugin puzzles). The GM makes them (a picture in the file bucket, a grid, where pieces drop, what
-- completing one brings); players collect pieces and claim the reward.
CREATE TABLE puzzles_defs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	grid INTEGER NOT NULL CHECK (grid BETWEEN 2 AND 12),
	-- draft: only the GM sees it, nothing drops; live: pieces drop; closed: no more drops, still claimable; hidden: gone.
	status TEXT NOT NULL CHECK (status IN ('draft', 'live', 'closed', 'hidden')),
	-- The picture's key in the file bucket (puzzles/<hash>.<ext>), square.
	image TEXT,
	-- Times each player may claim it (pieces are cleared on every claim).
	claim_limit INTEGER NOT NULL DEFAULT 1 CHECK (claim_limit >= 1),
	-- JSON: what a piece one already has turns into ({ kind, config }), the drop rules, the rewards.
	duplicate TEXT,
	drops TEXT NOT NULL DEFAULT '[]',
	rewards TEXT NOT NULL DEFAULT '[]',
	updated_at INTEGER NOT NULL
);
-- A piece a player has (one row a piece: duplicates turn into something else when they drop).
CREATE TABLE puzzles_pieces (
	player_id TEXT NOT NULL,
	puzzle_id TEXT NOT NULL,
	piece INTEGER NOT NULL CHECK (piece >= 0),
	PRIMARY KEY (player_id, puzzle_id, piece)
);
CREATE TABLE puzzles_claims (
	player_id TEXT NOT NULL,
	puzzle_id TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (player_id, puzzle_id)
);
