-- Owned by plugin: shop. Coupons are whole numbers: SQLite would store 2.5 in an INTEGER column as a
-- REAL, so refuse anything but an integer at the database (the code already only writes integers).
CREATE TRIGGER shop_wallets_integer_insert BEFORE INSERT ON shop_wallets
WHEN typeof(NEW.balance) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_wallets.balance must be an integer');
END;
CREATE TRIGGER shop_wallets_integer_update BEFORE UPDATE OF balance ON shop_wallets
WHEN typeof(NEW.balance) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_wallets.balance must be an integer');
END;
CREATE TRIGGER shop_purchases_integer_insert BEFORE INSERT ON shop_purchases
WHEN typeof(NEW.price) != 'integer' OR typeof(NEW.quantity) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_purchases price and quantity must be integers');
END;
