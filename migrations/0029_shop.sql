-- Owned by plugin: shop (docs/design/gameplay.md §11). Coupons ("yuanbao") belong to the player, not a settlement.
CREATE TABLE shop_wallets (
	player_id TEXT PRIMARY KEY,
	balance INTEGER NOT NULL CHECK (balance >= 0)
);
-- Every purchase (and GM grant, offer = '' and price = -amount), for daily limits and audits.
CREATE TABLE shop_purchases (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	offer TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK (quantity >= 0),
	price INTEGER NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX shop_purchases_player ON shop_purchases (player_id, at);
