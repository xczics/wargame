-- Owned by plugin: heroes. Levels and growth (docs/design/gameplay.md §5.5).
ALTER TABLE heroes_heroes ADD COLUMN level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1);
-- Experience towards the next level.
ALTER TABLE heroes_heroes ADD COLUMN exp INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0);
-- Attribute points gained automatically at each level up (rolled at recruitment).
ALTER TABLE heroes_heroes ADD COLUMN talent INTEGER NOT NULL DEFAULT 3 CHECK (talent >= 0);
-- Free points not yet spent by the player.
ALTER TABLE heroes_heroes ADD COLUMN free_points INTEGER NOT NULL DEFAULT 0 CHECK (free_points >= 0);
-- JSON { attribute: points } spent from free points; already included in `attrs` (kept apart so it can be refunded).
ALTER TABLE heroes_heroes ADD COLUMN alloc TEXT NOT NULL DEFAULT '{}';
