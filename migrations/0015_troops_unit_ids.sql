-- Owned by plugin: troops
-- The old starter units became tier-1 / tier-2 infantry (starter-army): militia -> infantry-1,
-- spearman -> infantry-2. Garrisons merge into existing rows; batches in training keep going.
INSERT INTO troops_garrison (settlement_id, unit, count)
SELECT settlement_id, CASE unit WHEN 'militia' THEN 'infantry-1' ELSE 'infantry-2' END, count
FROM troops_garrison
WHERE unit IN ('militia', 'spearman') AND true
ON CONFLICT (settlement_id, unit) DO UPDATE SET count = troops_garrison.count + excluded.count;

DELETE FROM troops_garrison WHERE unit IN ('militia', 'spearman');

UPDATE troops_training SET unit = CASE unit WHEN 'militia' THEN 'infantry-1' ELSE 'infantry-2' END
WHERE unit IN ('militia', 'spearman');
