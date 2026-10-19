-- Beginner protection set by the GM for a player (1.5.1, user 2026-10-19: "另设GM操作，可以给制定玩家设置新手保护期（延长、重设或
-- 取消）"): until when they cannot be attacked, instead of the hours after founding their capital (0: not at all).
CREATE TABLE pvp_protection (
	player_id TEXT PRIMARY KEY,
	until INTEGER NOT NULL CHECK (until >= 0)
);
