-- Whose an event is (its entity's owner; NULL: nobody's, an NPC's), so a sync can ask in one indexed lookup whether
-- anything of the player's fell due (an unchanged sync is then answered without working out any view: changelog 410).
ALTER TABLE timeline_events ADD COLUMN player TEXT;
CREATE INDEX timeline_events_player_due ON timeline_events (player, due_at);

-- The events already queued, by the owners the entity kinds had when this was written (`timeline.addOwnerResolver`).
UPDATE timeline_events SET player = substr(entity, 8) WHERE entity LIKE 'player:%';
UPDATE timeline_events SET player = substr(entity, 9) WHERE entity LIKE 'bandits:%';
UPDATE timeline_events
SET player = (SELECT owner_id FROM settlements_settlements WHERE id = substr(timeline_events.entity, 12))
WHERE entity LIKE 'settlement:%';
UPDATE timeline_events
SET player = (SELECT player_id FROM armies_marches WHERE id = substr(timeline_events.entity, 6))
WHERE entity LIKE 'army:%';
