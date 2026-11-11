-- Demolition (user 2026-11-11: "建筑提供拆除功能，一级一级拆"): a construction site that takes a level off. For one,
-- target_level is the level being taken off (so it stays >= 1); the building has one level fewer when it is done.
ALTER TABLE buildings_construction ADD COLUMN demolish INTEGER NOT NULL DEFAULT 0 CHECK (demolish IN (0, 1));
