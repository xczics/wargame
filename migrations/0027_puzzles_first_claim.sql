-- When a player first completed a puzzle (1.5.1, the album: user 2026-10-20 "首次拼成日期可以记，老记录显示不出来的，可以用回退
-- 文案"). Rows from before stay NULL: the album says the day is no longer known.
ALTER TABLE puzzles_claims ADD COLUMN first_at INTEGER CHECK (first_at IS NULL OR first_at >= 0);
