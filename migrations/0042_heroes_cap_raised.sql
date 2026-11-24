-- Heroes given past the limit (a GM mail, a puzzle) raise it to as many as there are, for good (user 2026-11-24:
-- "我建议设计成'可以撑高'的形式"): how much, per player; no row = none.
CREATE TABLE heroes_cap_raised (
	player_id TEXT PRIMARY KEY,
	extra INTEGER NOT NULL CHECK (extra > 0)
);
