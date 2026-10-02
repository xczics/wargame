-- Owned by plugin: heroes. Talent points by attribute (JSON { attribute: points }), fixed at recruitment:
-- every level up adds them. Heroes from before: NULL (their `talent` total is spread at random each level).
ALTER TABLE heroes_heroes ADD COLUMN talents TEXT;
