-- Owned by plugin: resources
CREATE TABLE resources_balances (
	player_id TEXT NOT NULL,
	resource TEXT NOT NULL,
	-- Settled amount as of updated_at. The current amount is computed on read.
	amount REAL NOT NULL CHECK (amount >= 0),
	-- Production per second at settle time: only used by GM reports to estimate current
	-- amounts in SQL; gameplay always recomputes rates from the current rules.
	rate REAL NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, resource)
);

CREATE INDEX resources_balances_resource ON resources_balances (resource, amount);
