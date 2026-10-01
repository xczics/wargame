-- Owned by plugin: npc-camps. The level (1-10) of each NPC camp; camps from before levels have no row (= level 1).
CREATE TABLE npc_camps_levels (
	settlement_id TEXT PRIMARY KEY,
	level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10)
);
