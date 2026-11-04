-- The unread list (view `mail.unread`: the newest unread ids) filters on read and sorts by time: with only
-- (player_id, read) SQLite walked the page index (player_id, at, id) through every message of the player (about 200
-- rows a sync on the live server, 2026-11-04). This index answers it directly, and the count of unread too.
CREATE INDEX mail_messages_unread_at ON mail_messages (player_id, read, at);
-- Covered by the one above.
DROP INDEX IF EXISTS mail_messages_unread;
