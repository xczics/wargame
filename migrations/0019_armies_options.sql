-- Owned by plugin: armies
-- Extra orders given at departure by other plugins (JSON { key: value }), e.g. a battle formation.
ALTER TABLE armies_marches ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
