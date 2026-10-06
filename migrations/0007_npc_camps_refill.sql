-- 1.3.3: when an NPC camp was last beaten (its loot / captives refill from then on over npc-camps.refillHours;
-- NULL: never, full).
ALTER TABLE npc_camps_levels ADD COLUMN raided_at INTEGER;
