-- Owned by plugin: armies
-- Upkeep paid up front for the whole round trip (JSON { resource: amount }), so a recall can refund the unused part.
ALTER TABLE armies_marches ADD COLUMN provisions TEXT NOT NULL DEFAULT '{}';
