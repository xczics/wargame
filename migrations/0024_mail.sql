-- Owned by plugin: mail. Messages to players (battle reports, notices...), sent by other plugins.
CREATE TABLE mail_messages (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	-- What kind of message, namespaced by the sending plugin (e.g. "war-reports.march"); the client picks a renderer by it.
	kind TEXT NOT NULL,
	-- Title text (translated by the client) and its {placeholders}.
	title TEXT NOT NULL,
	vars TEXT NOT NULL DEFAULT '{}',
	-- Kind-specific JSON body.
	data TEXT NOT NULL DEFAULT 'null',
	read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1))
);
CREATE INDEX mail_messages_player ON mail_messages (player_id, at);
