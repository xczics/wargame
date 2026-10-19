-- A puzzle's description, written by the GM, shown to players under the picture (1.5.1, user 2026-10-19: "拼图之下，'集齐
-- 可以兑换'文字之上，预留一个GM可以放的文字说明，默认为空（不显示）").
ALTER TABLE puzzles_defs ADD COLUMN description TEXT NOT NULL DEFAULT '';
