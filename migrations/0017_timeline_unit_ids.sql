-- Owned by plugin: timeline
-- Pending "training finished" events name the renamed units too (see 0015).
UPDATE timeline_events
SET payload = replace(replace(payload, '"militia"', '"infantry-1"'), '"spearman"', '"infantry-2"')
WHERE payload LIKE '%"militia"%' OR payload LIKE '%"spearman"%';
