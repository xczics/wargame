-- 1.4: NPC camps are worked out by a rule (npc-camps/layout.ts), not stored. Only what happened to one is: when it
-- was last beaten (its loot refills from then on) and whether it is gone (uprooted). One row per camp touched.
CREATE TABLE npc_camps_state (
	id TEXT PRIMARY KEY,
	raided_at INTEGER,
	removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))
);
