-- 1.0.0: inner cities (capital and cities) get 22 building slots instead of 12 (player-settlements.innerSlots).
-- Existing inner cities get the 10 more, keeping any slots items added.
UPDATE settlements_districts SET slots = slots + 10 WHERE type = 'inner';
