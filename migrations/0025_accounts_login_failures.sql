-- Failed logins counted, to stop guessing passwords (1.5.1, user 2026-10-20: "做一下登录界面的最大重试保护"): one row per
-- key ("u:<name>|ip:<ip>", "u:<name>", "ip:<ip>"), how many since `first_at`, and until when logins are refused.
CREATE TABLE accounts_login_failures (
	key TEXT PRIMARY KEY,
	count INTEGER NOT NULL CHECK (count >= 0),
	first_at INTEGER NOT NULL,
	locked_until INTEGER NOT NULL DEFAULT 0
);
