-- Owned by plugin: equipment. Pieces not worn are stored in a settlement (its armory); NULL (pieces
-- from before this) = the owner's capital, fixed the next time the piece is touched.
ALTER TABLE equipment_items ADD COLUMN settlement_id TEXT;
CREATE INDEX equipment_items_settlement ON equipment_items (settlement_id);
