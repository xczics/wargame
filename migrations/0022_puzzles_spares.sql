-- Repeat pieces kept for the player to exchange (1.5.1, user 2026-10-19: "让玩家自己在背包里兑换哈"): before, a piece one
-- had already turned into the duplicate's reward right away in the battle. One row per piece held more than once.
CREATE TABLE puzzles_spares (
	player_id TEXT NOT NULL,
	puzzle_id TEXT NOT NULL,
	piece INTEGER NOT NULL CHECK (piece >= 0),
	count INTEGER NOT NULL CHECK (count > 0),
	PRIMARY KEY (player_id, puzzle_id, piece)
);
