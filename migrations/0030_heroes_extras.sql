-- Numbers other plugins keep on a hero, given when it is granted (JSON { "<pluginId>.<name>": n }), e.g. a GM's
-- number of accessories for a heroine (starter-equipment). NULL: none.
ALTER TABLE heroes_heroes ADD COLUMN extras TEXT;
