-- 1.3.3: expired sessions are swept by the accounts.sessions task, a small batch a minute.
CREATE INDEX accounts_sessions_expires ON accounts_sessions (expires_at);
