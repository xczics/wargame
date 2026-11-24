-- Trade by quota (user 2026-11-25: "把这些商单全部加起来，作为每日上限，玩家可以自由选择数量。然后每进行一次交易，都创建一个
-- 时间队列。可以并行N个队列"): how much a player bought today in each direction ("stone>wood"), and the deals under way,
-- several at a trade post. The old tables (an order once a day, one deal a post) stay, unused.
CREATE TABLE trade_routes_traded (
	player_id TEXT NOT NULL,
	day INTEGER NOT NULL,
	pair TEXT NOT NULL,
	amount INTEGER NOT NULL CHECK (amount > 0),
	PRIMARY KEY (player_id, day, pair)
);
CREATE TABLE trade_routes_shipments (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	player_id TEXT NOT NULL,
	resource TEXT NOT NULL,
	amount INTEGER NOT NULL CHECK (amount > 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);
CREATE INDEX trade_routes_shipments_player ON trade_routes_shipments (player_id);
-- Deals under way carry on: their id is their settlement's, as their timeline events name them.
INSERT INTO trade_routes_shipments (id, settlement_id, player_id, resource, amount, started_at, finishes_at)
	SELECT settlement_id, settlement_id, player_id, resource, amount, started_at, finishes_at FROM trade_routes_deals;
DELETE FROM trade_routes_deals;
