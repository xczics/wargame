-- Schema of the game: every table, index and trigger, in one file. Changes after a release are new
-- migrations (NNNN_<pluginId>_<what>.sql). Each plugin owns the tables prefixed with its id (AGENTS.md).

CREATE TABLE accounts_users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	-- PBKDF2-SHA256, base64. Every account's, the GM's included; empty only for a GM account that has
	-- not logged in yet (its first login takes the initial GM_PASSWORD).
	password_hash TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	-- 1: logged in with an initial password (the GM's), must change it before playing.
	must_change INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
	created_at INTEGER NOT NULL
);

CREATE TABLE accounts_sessions (
	-- SHA-256 of the cookie token; the raw token is never stored.
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES accounts_users (id) ON DELETE CASCADE,
	-- 1 if the GM account opened this session by logging in (0 for "play as" sessions the GM switched to).
	gm INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX accounts_sessions_user ON accounts_sessions (user_id);

CREATE TABLE invites_codes (
	code TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	max_uses INTEGER NOT NULL DEFAULT 1,
	uses INTEGER NOT NULL DEFAULT 0,
	note TEXT,
	revoked_at INTEGER
);

CREATE TABLE invites_redemptions (
	code TEXT NOT NULL REFERENCES invites_codes (code),
	user_id TEXT NOT NULL,
	redeemed_at INTEGER NOT NULL,
	PRIMARY KEY (code, user_id)
);

CREATE TABLE gm_config (
	key TEXT PRIMARY KEY,
	-- JSON-encoded override, validated by the owning plugin's config parser before being stored.
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL
);

CREATE TABLE gm_audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	detail TEXT
);

CREATE TABLE engine_locks (
	-- e.g. "player:<id>"; later "city:<id>" etc.
	entity TEXT PRIMARY KEY,
	version INTEGER NOT NULL
);
CREATE TRIGGER engine_locks_cas BEFORE UPDATE ON engine_locks
WHEN NEW.version != OLD.version + 1
BEGIN
	SELECT RAISE(ABORT, 'version_conflict');
END;

CREATE TABLE resources_balances (
	holder TEXT NOT NULL,
	resource TEXT NOT NULL,
	-- May go slightly negative through upkeep (down to the GM-tunable debt limit), never
	-- through spending: the resources plugin checks that before writing.
	amount REAL NOT NULL,
	-- Net rate per second at settle time; only used by GM reports to estimate in SQL.
	rate REAL NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (holder, resource)
);
CREATE INDEX resources_balances_resource ON resources_balances (resource, amount);

CREATE TABLE timeline_events (
	id TEXT PRIMARY KEY,
	entity TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX timeline_events_entity_due ON timeline_events (entity, due_at);
CREATE INDEX timeline_events_due ON timeline_events (due_at);

CREATE TABLE world_map_tiles (
	x INTEGER NOT NULL CHECK (x BETWEEN -511 AND 512),
	y INTEGER NOT NULL CHECK (y BETWEEN -511 AND 512),
	-- Occupying entity, e.g. "settlement:<id>".
	entity TEXT NOT NULL,
	PRIMARY KEY (x, y)
);
CREATE INDEX world_map_tiles_entity ON world_map_tiles (entity);

CREATE TABLE settlements_settlements (
	id TEXT PRIMARY KEY,
	-- Registered settlement kind, e.g. "capital", "city", "fortress-resource", "npc-outpost".
	kind TEXT NOT NULL,
	-- NULL for NPC settlements.
	owner_id TEXT,
	name TEXT NOT NULL,
	-- Centre tile.
	x INTEGER NOT NULL,
	y INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX settlements_settlements_owner ON settlements_settlements (owner_id, kind);

CREATE TABLE settlements_districts (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL REFERENCES settlements_settlements (id) ON DELETE CASCADE,
	-- District type declared by the settlement kind: "inner", "outer", "core", ...
	type TEXT NOT NULL,
	-- Order within the settlement (inner = 0, outer cities 1..N in build order).
	idx INTEGER NOT NULL,
	-- Building slots. Fixed for inner/core, rolled at random for outer; items can raise it.
	slots INTEGER NOT NULL CHECK (slots >= 0),
	x INTEGER NOT NULL,
	y INTEGER NOT NULL,
	UNIQUE (settlement_id, idx)
);

CREATE TABLE buildings_slots (
	district_id TEXT NOT NULL,
	slot INTEGER NOT NULL CHECK (slot >= 0),
	settlement_id TEXT NOT NULL,
	building TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 0),
	-- Per-instance level cap raised by breakthroughs (items); NULL = the building's regular cap.
	cap INTEGER,
	PRIMARY KEY (district_id, slot)
);
CREATE INDEX buildings_slots_settlement ON buildings_slots (settlement_id);
CREATE INDEX buildings_slots_building ON buildings_slots (building, level);

CREATE TABLE buildings_construction (
	district_id TEXT NOT NULL,
	slot INTEGER NOT NULL,
	settlement_id TEXT NOT NULL,
	building TEXT NOT NULL,
	target_level INTEGER NOT NULL CHECK (target_level >= 1),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	PRIMARY KEY (district_id, slot)
);
CREATE INDEX buildings_construction_settlement ON buildings_construction (settlement_id);

CREATE TABLE research_levels (
	player_id TEXT NOT NULL,
	tech TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 0),
	PRIMARY KEY (player_id, tech)
);

CREATE TABLE items_inventory (
	player_id TEXT NOT NULL,
	item TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (player_id, item)
);

CREATE TABLE troops_garrison (
	settlement_id TEXT NOT NULL,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (settlement_id, unit)
);

CREATE TABLE troops_training (
	settlement_id TEXT PRIMARY KEY,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count > 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);

CREATE TABLE research_queue (
	settlement_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	tech TEXT NOT NULL,
	target_level INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	UNIQUE (player_id, tech)
);

CREATE TABLE research_nodes (
	id TEXT PRIMARY KEY,
	owner_id TEXT,
	def TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX research_nodes_owner ON research_nodes (owner_id);

CREATE TABLE armies_marches (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	from_settlement TEXT NOT NULL,
	target_x INTEGER NOT NULL,
	target_y INTEGER NOT NULL,
	-- "outbound" until it reaches the target, then "returning".
	phase TEXT NOT NULL CHECK (phase IN ('outbound', 'returning')),
	-- JSON { unit: count } of the units still alive.
	units TEXT NOT NULL,
	-- JSON { resource: amount } carried home.
	loot TEXT NOT NULL DEFAULT '{}',
	-- JSON battle report of what happened at the target (null until it arrives).
	report TEXT,
	departed_at INTEGER NOT NULL,
	arrives_at INTEGER NOT NULL,
	returns_at INTEGER NOT NULL
, provisions TEXT NOT NULL DEFAULT '{}', options TEXT NOT NULL DEFAULT '{}', mission TEXT NOT NULL DEFAULT 'attack', mission_data TEXT NOT NULL DEFAULT '{}', cargo TEXT NOT NULL DEFAULT '{}');
CREATE INDEX armies_marches_player ON armies_marches (player_id);

CREATE TABLE pvp_reports (
	id TEXT PRIMARY KEY,
	defender_id TEXT NOT NULL,
	attacker_id TEXT NOT NULL,
	settlement_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	report TEXT NOT NULL
);
CREATE INDEX pvp_reports_defender ON pvp_reports (defender_id, at);

CREATE TABLE battle_formations (
	settlement_id TEXT PRIMARY KEY,
	lanes TEXT NOT NULL
);

CREATE TABLE terrain_chunks (
	cx INTEGER NOT NULL CHECK (cx >= 0 AND cx < 32),
	cy INTEGER NOT NULL CHECK (cy >= 0 AND cy < 32),
	data TEXT NOT NULL CHECK (length(data) = 1024),
	PRIMARY KEY (cx, cy)
);

CREATE TABLE heroes_heroes (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	-- Name parts (source language); the client translates and joins them.
	surname TEXT NOT NULL,
	given TEXT NOT NULL,
	gender TEXT NOT NULL CHECK (gender IN ('m', 'f')),
	-- Recruitment venue it came from (attributes only; afterwards all heroes are alike).
	origin TEXT NOT NULL,
	-- JSON { attribute: value }.
	attrs TEXT NOT NULL,
	-- Settlement it is attached to.
	home TEXT NOT NULL,
	-- Current duty ("idle" by default) and what it is about (a settlement, an army...).
	duty TEXT NOT NULL DEFAULT 'idle',
	duty_target TEXT,
	created_at INTEGER NOT NULL
, level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1), exp INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0), talent INTEGER NOT NULL DEFAULT 3 CHECK (talent >= 0), free_points INTEGER NOT NULL DEFAULT 0 CHECK (free_points >= 0), alloc TEXT NOT NULL DEFAULT '{}', talents TEXT);
CREATE INDEX heroes_heroes_player ON heroes_heroes (player_id);
CREATE INDEX heroes_heroes_duty ON heroes_heroes (duty, duty_target);

CREATE TABLE heroes_taken (
	settlement_id TEXT NOT NULL,
	venue TEXT NOT NULL,
	win INTEGER NOT NULL,
	slot INTEGER NOT NULL,
	PRIMARY KEY (settlement_id, venue, win, slot)
);

CREATE TABLE heroes_defense (
	settlement_id TEXT PRIMARY KEY,
	heroes TEXT NOT NULL
);

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

CREATE TABLE realms_sites (
	id TEXT PRIMARY KEY,
	realm TEXT NOT NULL,
	x INTEGER NOT NULL,
	y INTEGER NOT NULL
);
CREATE INDEX realms_sites_realm ON realms_sites (realm);

CREATE TABLE realms_unlocked (
	player_id TEXT NOT NULL,
	realm TEXT NOT NULL,
	PRIMARY KEY (player_id, realm)
);

CREATE TABLE realms_adventures (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	hero_id TEXT NOT NULL UNIQUE,
	realm TEXT NOT NULL,
	task INTEGER NOT NULL CHECK (task >= 0),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL,
	result TEXT NOT NULL
);
CREATE INDEX realms_adventures_player ON realms_adventures (player_id);

CREATE TABLE realms_injuries (
	hero_id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	healing_until INTEGER
);
CREATE INDEX realms_injuries_player ON realms_injuries (player_id);

CREATE TABLE equipment_items (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	base TEXT NOT NULL,
	slot TEXT NOT NULL,
	tier INTEGER NOT NULL CHECK (tier >= 1),
	rarity TEXT NOT NULL,
	-- JSON { stat: value }, e.g. { "adv.attack": 31, "battle.attack": 2.1, "attr.might": 12 }.
	stats TEXT NOT NULL,
	-- The hero wearing it (null = in the bag).
	hero_id TEXT,
	created_at INTEGER NOT NULL
, settlement_id TEXT);
CREATE INDEX equipment_items_player ON equipment_items (player_id);
CREATE UNIQUE INDEX equipment_items_worn ON equipment_items (hero_id, slot) WHERE hero_id IS NOT NULL;
CREATE INDEX equipment_items_settlement ON equipment_items (settlement_id);

CREATE TABLE starter_items_boosts (
	settlement_id TEXT PRIMARY KEY,
	percent REAL NOT NULL CHECK (percent >= 0),
	until INTEGER NOT NULL
);

CREATE TABLE shop_wallets (
	player_id TEXT PRIMARY KEY,
	balance INTEGER NOT NULL CHECK (balance >= 0)
);
CREATE TRIGGER shop_wallets_integer_insert BEFORE INSERT ON shop_wallets
WHEN typeof(NEW.balance) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_wallets.balance must be an integer');
END;
CREATE TRIGGER shop_wallets_integer_update BEFORE UPDATE OF balance ON shop_wallets
WHEN typeof(NEW.balance) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_wallets.balance must be an integer');
END;

CREATE TABLE shop_purchases (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	offer TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK (quantity >= 0),
	price INTEGER NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX shop_purchases_player ON shop_purchases (player_id, at);
CREATE TRIGGER shop_purchases_integer_insert BEFORE INSERT ON shop_purchases
WHEN typeof(NEW.price) != 'integer' OR typeof(NEW.quantity) != 'integer'
BEGIN
	SELECT RAISE(ABORT, 'shop_purchases price and quantity must be integers');
END;

CREATE TABLE realms_cleared (
	player_id TEXT NOT NULL,
	realm TEXT NOT NULL,
	task INTEGER NOT NULL,
	PRIMARY KEY (player_id, realm, task)
);

CREATE TABLE npc_camps_levels (
	settlement_id TEXT PRIMARY KEY,
	level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10)
);

CREATE TABLE starter_siege_works (
	settlement_id TEXT NOT NULL,
	work TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 1),
	PRIMARY KEY (settlement_id, work)
);

CREATE TABLE starter_siege_devices (
	settlement_id TEXT NOT NULL,
	device TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count >= 0),
	PRIMARY KEY (settlement_id, device)
);

CREATE TABLE starter_siege_queue (
	settlement_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('device', 'work')),
	item TEXT NOT NULL,
	amount INTEGER NOT NULL CHECK (amount >= 1),
	started_at INTEGER NOT NULL,
	finishes_at INTEGER NOT NULL
);

CREATE TABLE starter_items_pity (
	player_id TEXT NOT NULL,
	target TEXT NOT NULL,
	fails INTEGER NOT NULL CHECK (fails >= 0),
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, target)
);
CREATE INDEX starter_items_pity_expires ON starter_items_pity (expires_at);

CREATE TABLE starter_items_outer (
	settlement_id TEXT PRIMARY KEY,
	extra INTEGER NOT NULL CHECK (extra >= 0)
);

CREATE TABLE starter_items_stats (
	player_id TEXT NOT NULL,
	stat TEXT NOT NULL,
	amount REAL NOT NULL,
	PRIMARY KEY (player_id, stat)
);

CREATE TABLE heroes_gifts (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	venue TEXT NOT NULL,
	draft TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX heroes_gifts_place ON heroes_gifts (settlement_id, venue);

CREATE TABLE starter_levies_quota (
	player_id TEXT NOT NULL,
	unit TEXT NOT NULL,
	quota INTEGER NOT NULL CHECK (quota >= 0),
	PRIMARY KEY (player_id, unit)
);

CREATE TABLE prestige_players (
	player_id TEXT PRIMARY KEY,
	value REAL NOT NULL CHECK (value >= 0),
	best REAL NOT NULL CHECK (best >= value),
	recent REAL NOT NULL CHECK (recent >= 0),
	recent_at INTEGER NOT NULL
);

CREATE TABLE bandits_players (
	player_id TEXT PRIMARY KEY,
	next_at INTEGER NOT NULL
);

CREATE TABLE bandits_raids (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL,
	settlement_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	level INTEGER NOT NULL CHECK (level >= 1),
	lanes TEXT NOT NULL,
	heroes TEXT NOT NULL,
	appeared_at INTEGER NOT NULL,
	arrives_at INTEGER NOT NULL
);
CREATE INDEX bandits_raids_player ON bandits_raids (player_id, arrives_at);
CREATE INDEX bandits_raids_settlement ON bandits_raids (settlement_id);

CREATE TABLE troops_queue (
	id TEXT PRIMARY KEY,
	settlement_id TEXT NOT NULL,
	line TEXT NOT NULL,
	seq INTEGER NOT NULL,
	unit TEXT NOT NULL,
	count INTEGER NOT NULL CHECK (count > 0),
	cost TEXT NOT NULL,
	started_at INTEGER,
	finishes_at INTEGER
);
CREATE INDEX troops_queue_settlement ON troops_queue (settlement_id, line, seq);
