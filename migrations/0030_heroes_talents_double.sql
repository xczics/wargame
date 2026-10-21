-- Talents x2 (user 2026-10-21: "天赋：目前抽取的天赋值 整体*2，即2-7变成4-14. 3-9变成6-18。玩家已有英雄也乘"), levels
-- already gained made up too (user's decision, 2026-10-21): each attribute gets (level - 1) x its old talent more, as if
-- the doubled talent had always been there. Then the talent itself doubles. Heroes at level 1 gain nothing.
-- `talent` is the total, `talents` the split by attribute. Heroes from before the split (talents NULL) grew their total at
-- random, weighted by their natural attributes (without spent points): theirs is made up the same way, spread by those
-- weights (rounded per attribute).
-- First, a heroine's accessory slots no longer follow her talent total (user 2026-10-21: "为什么天赋要和饰品栏位耦合？解耦！"):
-- every heroine (and heroine not yet taken) without her own number keeps what the old table gave her (talent 1-4: 1,
-- 5: 2, 6: 3, 7: 5, 8: 7, 9+: 10), kept on her (`extras`, starter-equipment's key) so doubling the talent changes nothing.
UPDATE heroes_heroes
SET extras = json_set(COALESCE(extras, '{}'), '$."starter-equipment.accessories"', CASE WHEN talent >= 9 THEN 10 WHEN talent >= 8 THEN 7 WHEN talent >= 7 THEN 5 WHEN talent >= 6 THEN 3 WHEN talent >= 5 THEN 2 WHEN talent >= 1 THEN 1 ELSE 0 END)
WHERE gender = 'f' AND json_type(COALESCE(extras, '{}'), '$."starter-equipment.accessories"') IS NULL;
UPDATE heroes_gifts
SET draft = json_set(
	draft,
	'$.extras',
	json(json_set(
		COALESCE(json_extract(draft, '$.extras'), '{}'),
		'$."starter-equipment.accessories"',
		CASE WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 9 THEN 10 WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 8 THEN 7 WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 7 THEN 5 WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 6 THEN 3 WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 5 THEN 2 WHEN COALESCE(json_extract(draft, '$.talent'), (SELECT SUM(value) FROM json_each(heroes_gifts.draft, '$.talents')), 3) >= 1 THEN 1 ELSE 0 END
	))
)
WHERE json_extract(draft, '$.gender') = 'f' AND json_type(draft, '$.extras."starter-equipment.accessories"') IS NULL;
UPDATE heroes_heroes
SET attrs = (
	SELECT json_group_object(a.key, a.value + COALESCE(json_extract(heroes_heroes.talents, '$.' || a.key), 0) * (heroes_heroes.level - 1))
	FROM json_each(heroes_heroes.attrs) a
)
WHERE level > 1 AND talents IS NOT NULL;
UPDATE heroes_heroes
SET attrs = (
	SELECT json_group_object(
		a.key,
		a.value + CAST(ROUND(
			1.0 * heroes_heroes.talent * (heroes_heroes.level - 1) * MAX(1, a.value - COALESCE(json_extract(heroes_heroes.alloc, '$.' || a.key), 0))
			/ (
				SELECT SUM(MAX(1, b.value - COALESCE(json_extract(heroes_heroes.alloc, '$.' || b.key), 0)))
				FROM json_each(heroes_heroes.attrs) b
			)
		) AS INTEGER)
	)
	FROM json_each(heroes_heroes.attrs) a
)
WHERE level > 1 AND talents IS NULL AND talent > 0;
UPDATE heroes_heroes SET talent = talent * 2;
UPDATE heroes_heroes
SET talents = (SELECT json_group_object(key, value * 2) FROM json_each(heroes_heroes.talents))
WHERE talents IS NOT NULL AND talents <> '{}';
-- Heroes handed out but not yet taken (GM grants, puzzles) were rolled under the old table: theirs double too (level 1).
UPDATE heroes_gifts
SET draft = json_set(draft, '$.talents', json((SELECT json_group_object(key, value * 2) FROM json_each(heroes_gifts.draft, '$.talents'))))
WHERE json_type(draft, '$.talents') = 'object';
UPDATE heroes_gifts
SET draft = json_set(draft, '$.talent', json_extract(draft, '$.talent') * 2)
WHERE json_type(draft, '$.talent') IN ('integer', 'real');
-- Changed outside a command: move the players' table versions on, so stamps held by browsers and derived values that
-- read heroes are worked out again (engine_locks_cas allows +1).
INSERT INTO engine_locks (entity, version)
SELECT DISTINCT 'player:' || player_id || '#heroes_heroes', 1 FROM heroes_heroes WHERE level > 1
ON CONFLICT (entity) DO UPDATE SET version = version + 1;
INSERT INTO engine_locks (entity, version)
SELECT DISTINCT 'player:' || player_id, 1 FROM heroes_heroes WHERE level > 1
ON CONFLICT (entity) DO UPDATE SET version = version + 1;
