-- Trade routes after the 1.7.0 playtest (docs/design/gameplay.md §17.2; user 2026-11-20).
-- A team called home is on its way back (no more moves, fights or buying) until its time is up: "召回时不可秒召回".
ALTER TABLE trade_routes_expeditions ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0;
-- Trade orders a player opened for good with a drop in a fight ("商单……战斗时也要随机掉落").
CREATE TABLE trade_routes_unlocked (
	player_id TEXT NOT NULL,
	order_id TEXT NOT NULL,
	PRIMARY KEY (player_id, order_id)
);
-- Lairs beaten this time out (JSON [node]): each can be fought again every time out ("可以反复刷的节点").
ALTER TABLE trade_routes_expeditions ADD COLUMN raided TEXT NOT NULL DEFAULT '[]';
