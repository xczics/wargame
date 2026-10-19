-- 1.4: the GM's mail to everyone is one row (no copy per player), with attachments (rewards as { kind, config }); it
-- reaches the accounts made before it was sent. What a player did with one (read, deleted, claimed the attachments) is a
-- row only once they do.
CREATE TABLE mail_broadcasts (
	id TEXT PRIMARY KEY,
	at INTEGER NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX mail_broadcasts_page ON mail_broadcasts (at, id);

CREATE TABLE mail_broadcast_marks (
	player_id TEXT NOT NULL,
	broadcast_id TEXT NOT NULL,
	read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
	deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
	-- When the attachments were claimed (null: not yet); at most once, the row being the player's for this mail.
	claimed_at INTEGER,
	PRIMARY KEY (player_id, broadcast_id)
) WITHOUT ROWID;

-- Paging the mailbox by (time, id): the next page is a range of this index, with no sort.
CREATE INDEX mail_messages_page ON mail_messages (player_id, at, id);
DROP INDEX mail_messages_player;
