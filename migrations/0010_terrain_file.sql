-- 1.4: the map is one file in the object storage (terrain/<name>.txt); this row says which one is in force.
-- NULL: none yet (worlds from before read terrain_chunks until the GM command terrain.exportToFile).
ALTER TABLE terrain_version ADD COLUMN file TEXT;
