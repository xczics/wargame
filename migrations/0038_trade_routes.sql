-- Trade routes (docs/design/gameplay.md §17.2).
-- Nodes a player cleared (its enemies beaten, or visited when it had none): for good.
CREATE TABLE trade_routes_cleared (
	player_id TEXT NOT NULL,
	route TEXT NOT NULL,
	node TEXT NOT NULL,
	PRIMARY KEY (player_id, route, node)
);
-- A player's team on the road (one at most).
CREATE TABLE trade_routes_expeditions (
	player_id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	route TEXT NOT NULL,
	node TEXT NOT NULL,
	stamina REAL NOT NULL CHECK (stamina >= 0),
	started_at INTEGER NOT NULL,
	ends_at INTEGER NOT NULL,
	-- JSON [{ hero, units: { unit: count } }]: each hero's column, what is left of it.
	team TEXT NOT NULL,
	-- JSON { unit: count }: the auxiliaries the team shares.
	auxiliaries TEXT NOT NULL DEFAULT '{}',
	-- JSON [node]: supply points that gave this time out.
	supplied TEXT NOT NULL DEFAULT '[]',
	-- JSON: the last fight (every strike, for the browser to play), what it brought and cost; NULL: none yet.
	last_battle TEXT
);
-- Trade orders a player filled, by day (each order once a day: "每天刷新").
CREATE TABLE trade_routes_orders (
	player_id TEXT NOT NULL,
	order_id TEXT NOT NULL,
	day INTEGER NOT NULL,
	PRIMARY KEY (player_id, order_id, day)
);
-- A deal under way at a settlement's trade post (one at a time): what comes in when it is done.
CREATE TABLE trade_routes_deals (
	settlement_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	order_id TEXT NOT NULL,
	resource TEXT NOT NULL,
	amount INTEGER NOT NULL CHECK (amount > 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);
-- What a player bought from a merchant on a route, by day.
CREATE TABLE trade_routes_bought (
	player_id TEXT NOT NULL,
	merchant TEXT NOT NULL,
	goods TEXT NOT NULL,
	day INTEGER NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 1),
	PRIMARY KEY (player_id, merchant, goods, day)
);
