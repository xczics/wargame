-- 1.4: opaque research (plugin opaque-research; docs/design/gameplay.md §14). Applications are worked out when looked at,
-- never stored; what is stored is a player's hidden values, what heroes were granted, and projects under way.
-- A player's 256 hidden values (JSON) and, derived from them, the thresholds passed in each group (read on every sync
-- for the bonuses, changed only when a project ends); `version` moves on with every approval and every project's end.
CREATE TABLE opaque_research_values (
	player_id TEXT PRIMARY KEY,
	dims TEXT NOT NULL,
	steps TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);
-- A hero's record: the highest tier ever granted (1-4), projects hosted, and the application rejected this season.
CREATE TABLE opaque_research_heroes (
	hero_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	max_tier INTEGER NOT NULL DEFAULT 0 CHECK (max_tier BETWEEN 0 AND 4),
	hosted INTEGER NOT NULL DEFAULT 0 CHECK (hosted >= 0),
	rejected TEXT
);
CREATE INDEX opaque_research_heroes_player ON opaque_research_heroes (player_id);
-- Projects under way: fixed when approved (target, offset, points), deleted when done. One a hero.
CREATE TABLE opaque_research_projects (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	hero_id TEXT NOT NULL UNIQUE,
	tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
	target INTEGER NOT NULL CHECK (target BETWEEN 0 AND 255),
	offset INTEGER NOT NULL CHECK (offset BETWEEN -8 AND 8),
	points REAL NOT NULL CHECK (points >= 0),
	started_at INTEGER NOT NULL,
	due_at INTEGER NOT NULL
);
CREATE INDEX opaque_research_projects_player ON opaque_research_projects (player_id);
