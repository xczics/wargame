-- The starter trade routes laid out anew after the 1.7.0 playtest (about a hundred places a chapter, each its own land;
-- user 2026-11-20: "关于这次大改之后的线上数据：进度清空；已获得的道具、经验不收回；商单收回。"): what was won is gone, and
-- with it the trade orders the key places opened; those opened by drops are taken back too. Items and experience stay.
-- Deals under way were paid for: they finish. A team on the road is put back at its route's start (the places it knew
-- are no more) and comes home when its time is up, as ever.
DELETE FROM trade_routes_cleared;
DELETE FROM trade_routes_unlocked;
UPDATE trade_routes_expeditions SET node = route || '-0', supplied = '[]', raided = '[]';
