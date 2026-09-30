-- Owned by plugin: armies
-- Armies on the move carry the renamed units too (see 0015): militia -> infantry-1, spearman -> infantry-2.
UPDATE armies_marches
SET units = replace(replace(units, '"militia"', '"infantry-1"'), '"spearman"', '"infantry-2"')
WHERE units LIKE '%"militia"%' OR units LIKE '%"spearman"%';
