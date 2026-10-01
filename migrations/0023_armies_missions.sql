-- Owned by plugin: armies
-- What a march is for (attack, transfer, found a settlement... registered by plugins),
-- the mission's own data (e.g. the kind of settlement to found and what it cost), and the
-- supplies carried to the destination.
ALTER TABLE armies_marches ADD COLUMN mission TEXT NOT NULL DEFAULT 'attack';
ALTER TABLE armies_marches ADD COLUMN mission_data TEXT NOT NULL DEFAULT '{}';
ALTER TABLE armies_marches ADD COLUMN cargo TEXT NOT NULL DEFAULT '{}';
