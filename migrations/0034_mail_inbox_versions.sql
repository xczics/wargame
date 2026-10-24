-- Each player's inbox version (user 2026-10-24: reading one mail sent the whole inbox again): moved on by what changes
-- the list (a message in, deleted, an attachment claimed), not by reading. The inbox's stamp is made of it.
CREATE TABLE mail_inbox_versions (
	player_id TEXT PRIMARY KEY,
	version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);
