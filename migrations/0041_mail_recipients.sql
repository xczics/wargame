-- A GM mail to some players only (user 2026-11-24: "除了群发，添加还可以发送给指定玩家"): their ids as a JSON list; NULL = everyone.
ALTER TABLE mail_broadcasts ADD COLUMN recipients TEXT;
