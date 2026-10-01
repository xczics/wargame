/**
 * The HTTP contract between the Worker and the web client.
 *
 * Dependency-free on purpose: imported by server plugins (to type what they return)
 * and by the Vue app (to type what it receives). Change a shape here and both sides
 * fail to typecheck until they agree.
 */

export interface ApiErrorBody {
	error: { code: string; message: string };
}

/**
 * GET /api/state[?views=a,b], POST /api/command, GM player endpoints.
 * Only the requested views are computed, so pages can ask for just what they show.
 */
export interface ClientState {
	/** Server time the views were computed at (epoch ms). */
	now: number;
	/** Computed views, by view id. Known ids are typed in `ViewMap`. */
	views: Record<string, unknown>;
}

/** A settlement as listed for its owner. */
export interface SettlementSummary {
	id: string;
	kind: string;
	name: string;
	x: number;
	y: number;
	/** Outer cities (0 for fortresses). */
	outer: number;
}

/** What a building does at some level, under the current rules. */
export interface BuildingEffects {
	/** Production per second by resource. */
	produces: Record<string, number>;
	/** Stat bonuses by stat id (see `Meta.stats` for descriptions), e.g. storage cap. */
	stats: Record<string, number>;
}

export interface BuildingInSlot {
	building: string;
	level: number;
	/** Effect at the current level. */
	effects: BuildingEffects;
	/** Highest level this instance may reach right now (regular cap or its breakthrough cap). */
	cap: number;
}

export interface ConstructionInfo {
	building: string;
	targetLevel: number;
	startedAt: number;
	finishesAt: number;
}

/** An action the player can take on a slot right now (build or upgrade). */
export interface BuildOption {
	building: string;
	/** Level it will reach. */
	level: number;
	cost: Record<string, number>;
	seconds: number;
	/** Effect once this level is reached. */
	effects: BuildingEffects;
	affordable: boolean;
	/** Why it cannot be started (e.g. research missing, queue full, level cap). Absent = allowed. */
	blocked?: string;
}

export interface SlotInfo {
	slot: number;
	current: BuildingInSlot | null;
	construction: ConstructionInfo | null;
	/** Empty slot: every building allowed here. Built slot: the next level (if any). */
	options: BuildOption[];
}

export interface DistrictInfo {
	id: string;
	type: string;
	idx: number;
	x: number;
	y: number;
	slots: SlotInfo[];
}

/** view `settlements.detail` (param `settlement`, default: capital). */
export interface SettlementDetail extends SettlementSummary {
	kindName: string;
	garrison: boolean;
	districts: DistrictInfo[];
	limits: { outerTech: number; outerHard: number; queue: number; queueUsed: number };
}

/** Resources of the selected holder (param `settlement`, default: capital). */
export interface ResourcePool {
	holder: string;
	amounts: Record<string, number>;
	/** Net rate per second (production x factor - upkeep); can be negative. */
	rates: Record<string, number>;
	/** Gross production per second, before the factor. */
	production: Record<string, number>;
	/** Production multiplier from bonuses (1 = none). */
	factor: number;
	/** Extra production per second from bonuses on part of it (e.g. terrain under one district). */
	extra: Record<string, number>;
	/** Upkeep per second (e.g. troops). */
	upkeep: Record<string, number>;
	/** How far below zero upkeep may push each resource. */
	debtLimit: Record<string, number>;
	/** Storage cap applying to each resource. */
	capacity: number;
}

/** view `research.tree` */
export interface TechInfo {
	id: string;
	name: string;
	description?: string;
	level: number;
	maxLevel: number;
	/**
	 * Next level, if any: its cost (paid by the current settlement) and time. `blocked`: why it
	 * cannot start in the current settlement now; `locked`: a prerequisite tech still missing
	 * (the same in every settlement).
	 */
	next: { level: number; cost: Record<string, number>; seconds: number; blocked?: string; locked?: string } | null;
	/** Place in the tree (absent for techs outside it, e.g. runtime discoveries). */
	branch?: string;
	tier?: number;
	order?: number;
	quote?: string;
	/** Techs needed (id -> level) before level 1. */
	requires: Record<string, number>;
	/** Building level bands it unlocks: level 1 opens `from`..`from + perLevel - 1`, and so on. */
	unlocks: { building: string; from: number; perLevel: number }[];
	/** Effects per level (stat ids or describer keys; see TechEffect in the research plugin). */
	effects: { target: string; value: number; percent: boolean; family?: string }[];
}

export interface ResearchJob {
	settlement: string;
	tech: string;
	targetLevel: number;
	startedAt: number;
	finishesAt: number;
}

/** view `research.tree` (param `settlement`: whose queue and institute to use; default capital). */
export interface ResearchTree {
	techs: TechInfo[];
	/** The research running in the selected settlement, if any. */
	current: ResearchJob | null;
	/** Everything the player is researching, in all settlements. */
	all: ResearchJob[];
	/** Research speed of the selected settlement (1 = base; institutes add to it). 0 = no institute. */
	speed: number;
}

/** view `items.inventory`: items the player owns. */
export interface ItemStack {
	id: string;
	name: string;
	icon?: string;
	description?: string;
	count: number;
	usable: boolean;
}

/** view `troops.garrison` (param `settlement`, default: capital). */
export interface GarrisonInfo {
	settlement: string;
	/** Whether this kind of settlement can hold troops at all. */
	allowed: boolean;
	units: { id: string; count: number }[];
	training: { unit: string; count: number; startedAt: number; finishesAt: number } | null;
	/** Upkeep per second of the whole garrison. */
	upkeep: Record<string, number>;
	/** Attack / defence / hp totals of the garrison (battles add walls, heroes, counters...). */
	power: { attack: number; defense: number; hp: number };
	/** Units that can be trained here now, with the per-unit cost and time, or why not. */
	trainable: { unit: string; cost: Record<string, number>; seconds: number; blocked?: string }[];
}

/** Static facts about a unit type (in `/api/meta`). Its numbers are in view `troops.units`. */
export interface UnitMeta {
	id: string;
	name: string;
	icon?: string;
	/** e.g. "infantry"; units of one family differ by tier. */
	family?: string;
	tier?: number;
	/** False: cannot be trained, only obtained otherwise. */
	trainable?: boolean;
	/** Where it is trained: the building (entry type) whose entry shows its training form. */
	trainedAt?: string;
}

/** view `troops.units`: every unit's numbers under the current rules. */
export interface UnitNumbers {
	id: string;
	attack: number;
	defense: number;
	hp: number;
	/** Tiles per hour. */
	speed: number;
	/** Loot each unit can carry. */
	carry: number;
	cost: Record<string, number>;
	/** Training seconds per unit before settlement-specific modifiers. */
	seconds: number;
	/** Per second, by resource. */
	upkeep: Record<string, number>;
}

/** A side's result, by lanes won (5: crushing, 4: victory, 3: narrow, 2: narrow defeat, 0-1: routed). */
export type BattleGrade = 'crushing' | 'victory' | 'narrow' | 'narrow-defeat' | 'routed';

/** One side of one lane. */
export interface LaneSideReport {
	family: string;
	units: Record<string, number>;
	attack: number;
	defense: number;
	hp: number;
	/** This side's family counters the other's here (its attack, or defence for defenders, ×counter). */
	counters: boolean;
	lost: Record<string, number>;
}

/** Lane-by-lane account of a battle (battle plugin). */
export interface BattleDetail {
	lanes: { attacker: LaneSideReport; defender: LaneSideReport; winner: 'attacker' | 'defender' }[];
	wins: { attacker: number; defender: number };
	grade: { attacker: BattleGrade; defender: BattleGrade };
	/** Casualty factor each side's losses were multiplied by. */
	casualtyFactor: { attacker: number; defender: number };
	modifiers: {
		attacker: { source: string; stat: string; flat?: number; percent?: number }[];
		defender: { source: string; stat: string; flat?: number; percent?: number }[];
	};
	/** Casualty hooks that changed something: side, step (damage, spread, total, final) and source. */
	adjustments: { side: 'attacker' | 'defender'; stage: string; source: string }[];
}

export interface BattleReport {
	/** What was at the target: "empty", an NPC kind, or a player settlement. */
	target: { kind: string; name?: string; ownerName?: string | null };
	outcome: 'no-battle' | 'victory' | 'defeat';
	/** Why there was no battle, e.g. "Under beginner protection". */
	note?: string;
	attack: number;
	defense: number;
	/** Units lost, by side. */
	losses: { attacker: Record<string, number>; defender: Record<string, number> };
	loot: Record<string, number>;
	/** Units captured (e.g. from an NPC fortress). */
	captured: Record<string, number>;
	/** Lane by lane, when there was a battle. */
	battle?: BattleDetail;
	/** Survivors that moved up a tier (battle promotion), by side. The armies plugin applies the attacker's. */
	promoted?: { attacker: { from: string; to: string; count: number }[]; defender: { from: string; to: string; count: number }[] };
}

/** view `armies.incoming`: hostile armies heading for the player's settlements (no unit details). */
export interface IncomingArmy {
	id: string;
	/** The player's settlement being targeted. */
	settlement: string;
	arrivesAt: number;
	attackerName: string | null;
}

/** view `pvp.defenses`: recent attacks on the player (newest first). */
export interface DefenseReport {
	id: string;
	at: number;
	settlement: string;
	attackerName: string | null;
	report: BattleReport;
}

/** view `armies.list`: the player's armies away from home. */
export interface ArmyInfo {
	id: string;
	from: string;
	target: { x: number; y: number };
	/** What the march is for: "attack", "transfer", "settle"... (missions are registered by plugins). */
	mission: string;
	phase: 'outbound' | 'returning';
	units: Record<string, number>;
	loot: Record<string, number>;
	/** Supplies carried to the destination (unloaded there). */
	cargo: Record<string, number>;
	/** Upkeep paid up front for the round trip, by resource. */
	provisions: Record<string, number>;
	report: BattleReport | null;
	departedAt: number;
	arrivesAt: number;
	returnsAt: number;
}

/** `data` of the "battle.formation" form widget: what the attack formation editor needs. */
export interface FormationWidgetData {
	lanes: number;
	families: { id: string; name: string; icon?: string }[];
	/** Units the player has somewhere; `family` null = a support unit (marches outside the lanes). */
	units: { id: string; name: string; icon?: string; family: string | null; tier: number }[];
	/** Units in each settlement that could march out, by settlement id. */
	garrisons: Record<string, Record<string, number>>;
}

/** view `battle.formation` (param `settlement`): the defence formation. */
export interface BattleFormationInfo {
	settlement: string;
	/** Unit family of each lane. */
	lanes: string[];
	/** False while the settlement still uses its default formation. */
	saved: boolean;
}

/** view `terrain.window` (params x, y, radius): terrain codes of a square around (x, y); "?" = hidden. */
export interface TerrainWindow {
	x: number;
	y: number;
	radius: number;
	/** 2 * radius + 1 rows from y - radius down, each 2 * radius + 1 codes from x - radius. */
	rows: string[];
}

/** view `heroes.list`: the player's heroes. Names are parts in the source language (translate each, then join). */
export interface HeroInfo {
	id: string;
	surname: string;
	given: string;
	gender: 'm' | 'f';
	/** Venue it was recruited at. */
	origin: string;
	attrs: Record<string, number>;
	/** Settlement it is attached to. */
	home: string;
	duty: string;
	dutyTarget: string | null;
}

/** view `heroes.candidates` (param `settlement`): one entry per venue the settlement has. */
export interface HeroCandidates {
	venue: string;
	name: string;
	settlement: string;
	/** Server time the candidates are renewed. */
	refreshesAt: number;
	cost: Record<string, number>;
	/** Slots recruited already in this window. */
	taken: number[];
	/** null: recruited already (see `taken`), or nobody in this slot this time. */
	candidates: ({ slot: number; surname: string; given: string; gender: 'm' | 'f'; attrs: Record<string, number> } | null)[];
}

/** Views registered by the built-in plugins. */
export interface ViewMap {
	/** null while the player has no settlement. */
	'resources.pool': ResourcePool | null;
	'settlements.mine': SettlementSummary[];
	'settlements.detail': SettlementDetail | null;
	'ui.forms': ResolvedForm[];
	'research.tree': ResearchTree;
	'items.inventory': ItemStack[];
	'troops.garrison': GarrisonInfo | null;
	/** Garrisons of all the player's settlements that can hold troops. */
	'troops.overview': GarrisonInfo[];
	'troops.units': UnitNumbers[];
	'battle.formation': BattleFormationInfo | null;
	'terrain.window': TerrainWindow | null;
	'heroes.list': HeroInfo[];
	'heroes.candidates': HeroCandidates[];
	/** The settlement's defence order (hero ids), null = strongest first. */
	'heroes.defense': { settlement: string; order: string[] | null } | null;
	'armies.list': ArmyInfo[];
	'armies.incoming': IncomingArmy[];
	'pvp.defenses': DefenseReport[];
	'mail.inbox': MailInbox;
	/** Other settlements around a point (params x, y, r, npc), nearest first. */
	'settlements.nearby': NearbyOverview;
	/** Heroes serving the selected settlement and what they give it (param `settlement`). */
	'starter-heroes.posts': HeroPost[] | null;
}

/** One kind of hero post in a settlement: who holds it and what they add up to. */
export interface HeroPost {
	/** A duty id ("governor", "scholar"), or "defend" for the heroes who would defend it now. */
	post: string;
	name: string;
	/** Building the post is at (e.g. the institute), if any. */
	building?: string;
	/** Most heroes on it here. */
	limit: number;
	heroes: string[];
	/** Summed effects, e.g. { effect: "production", percent: 12 } (time and loss effects are reductions). */
	effects: { effect: string; percent: number }[];
}

/** A message in a player's mailbox (view `mail.inbox`). */
export interface MailMessage {
	id: string;
	at: number;
	/** Namespaced by the sending plugin, e.g. "war-reports.march"; the client renders `data` by it. */
	kind: string;
	/** Text to translate, with {placeholders} filled from `vars`. */
	title: string;
	vars: Record<string, string | number>;
	data: unknown;
	read: boolean;
}

/** `data` of a "war-reports.march" message. */
export interface MarchMail {
	mission: string;
	from: string;
	target: { x: number; y: number };
	units: Record<string, number>;
	/** Supplies carried: unloaded at `deliverTo`, otherwise brought back. */
	cargo: Record<string, number>;
	report: BattleReport;
	/** The settlement it delivered to (and stayed at, with `station`). */
	deliverTo: string | null;
	station: boolean;
}

/** `data` of a "war-reports.defense" message. */
export interface DefenseMail {
	settlement: string;
	attackerName: string | null;
	report: BattleReport;
}

/** `data` of a "war-reports.shortage" message. */
export interface ShortageMail {
	settlement: string;
	resource: string;
	routed: Record<string, number>;
	downgraded: { from: string; to: string; count: number }[];
}

/** view `mail.inbox` (param `mailBefore`: page to messages older than this time). */
export interface MailInbox {
	messages: MailMessage[];
	unread: number;
	/** More, older messages exist. */
	more: boolean;
}

/** view `settlements.nearby`. */
export interface NearbyOverview {
	/** Largest radius allowed (GM rule `settlements.nearbyRadius`); larger requests are cut to it. */
	maxRadius: number;
	settlements: NearbySettlement[];
}

/** A settlement near the given point. */
export interface NearbySettlement {
	settlement: string;
	kind: string;
	name: string;
	x: number;
	y: number;
	npc: boolean;
	ownerName: string | null;
	/** Straight-line tiles from the point, the shortest way around the map. */
	distance: number;
}

/** GET /api/map?x=&y=&r= — one entry per occupied tile in the window. */
export interface MapTile {
	x: number;
	y: number;
	settlement: string;
	kind: string;
	name: string;
	ownerId: string | null;
	ownerName: string | null;
	/** Centre tile of the settlement (the inner city / fortress itself). */
	centre: boolean;
}

/* ----- Server-driven forms --------------------------------------------------------- */

/** 'widget': a custom editor registered on the client under `FormField.widget` (e.g. a battle formation). */
export type FormFieldType = 'text' | 'number' | 'select' | 'checkbox' | 'hidden' | 'widget';

export interface FormField {
	name: string;
	label: string;
	type: FormFieldType;
	required?: boolean;
	min?: number;
	max?: number;
	maxLength?: number;
	placeholder?: string;
	default?: string | number | boolean;
	/** `when`: the option is offered only while those fields have those values (e.g. heroes of the chosen origin). */
	options?: { value: string; label: string; when?: Record<string, string> }[];
	/** Selects sharing a group never pick the same non-empty value: a value chosen in one is not offered in the others. */
	distinct?: string;
	/** Type 'widget': which client editor renders it, and what the server hands that editor. */
	widget?: string;
	data?: unknown;
}

/**
 * A limit the client checks while the form is filled in (the server checks it again): the
 * numbers in `use` add up to at most Σ value × weight over `capacity`, e.g. supplies up to
 * what the chosen units can carry. Shown as "label: used / total".
 */
export interface FormBudget {
	label: string;
	use: string[];
	capacity: Record<string, number>;
}

/**
 * A form attached to a command. The generic client renders it where `placement` says
 * and submits `{ type: command, payload: { [field]: value } }`.
 */
export interface FormSpec {
	title: string;
	description?: string;
	/** Where the client shows it, e.g. "settlement" (current settlement panel) or "global". */
	placement: string;
	fields: FormField[];
	submitLabel?: string;
	/** Ask for confirmation before submitting. */
	confirm?: string;
	budgets?: FormBudget[];
}

/** view `ui.forms`: forms available right now (param `placement`, plus context such as `settlement`). */
export interface ResolvedForm extends FormSpec {
	command: string;
	/** Plugin that owns the command (to group forms, e.g. in the GM console). */
	owner: string;
}

export interface ResourceMeta {
	id: string;
	name: string;
	icon?: string;
	initial?: number;
}

export interface BuildingMeta {
	id: string;
	name: string;
	icon?: string;
	category: string;
	/** Regular level cap (fully researched). Breakthroughs (items) can raise it per instance. */
	cap: number;
	/** Settlement kinds it may be built in (absent: any kind whose districts accept the category). */
	kinds?: string[];
}

export interface SettlementKindMeta {
	id: string;
	name: string;
	npc: boolean;
	garrison: boolean;
}

/** GET /api/meta */
export interface Meta {
	plugins: { id: string; version: string; description?: string }[];
	/** Buildings where research is started (research plugin): their entries hold the research controls. */
	researchLabs?: string[];
	resources?: ResourceMeta[];
	buildings?: BuildingMeta[];
	settlementKinds?: SettlementKindMeta[];
	map?: { min: number; max: number };
	stats?: { id: string; description: string }[];
	units?: UnitMeta[];
	/** Hero attributes, duties and venues (heroes plugin). */
	heroes?: {
		attributes: { id: string; name: string }[];
		/** `anywhere`: the duty may be held away from the hero's home settlement (by default not). */
		duties: { id: string; name: string; inTown: boolean; manual: boolean; anywhere: boolean }[];
		venues: { id: string; name: string; building: string }[];
	};
	/** Translations of hero name parts by locale (content plugins), e.g. { "zh-CN": { "Zhao": "赵" } }. */
	heroNames?: Record<string, Record<string, string>>;
	/** Terrain kinds (terrain plugin): the one-character code used in `terrain.window`. */
	terrains?: { id: string; code: string; name: string }[];
	/** Unit families that fight in battle lanes (battle plugin). */
	battleFamilies?: { id: string; name: string; icon?: string }[];
	[key: string]: unknown;
}

/** GET /api/auth/me, login, register. */
export interface User {
	id: string;
	username: string;
	gm: boolean;
	createdAt: number;
}

/** /api/invites */
export interface Invite {
	code: string;
	createdAt: number;
	expiresAt: number | null;
	maxUses: number;
	uses: number;
	note: string | null;
	revoked: boolean;
	link: string;
}

/** GET /api/gm/config */
export interface ConfigEntry {
	key: string;
	owner: string;
	description: string;
	default: unknown;
	overridden: boolean;
	override: unknown;
	value: unknown;
	error: string | null;
}

/** GET /api/gm/commands */
export interface PrivilegedCommand {
	type: string;
	description: string;
}

/** GET /api/gm/audit */
export interface AuditEntry {
	at: number;
	actor: string;
	action: string;
	detail: unknown;
}

/** GET /api/gm/reports */
export interface ReportInfo {
	id: string;
	/** Plugin that provides it. */
	owner: string;
	description: string;
	example: unknown;
}

/** POST /api/gm/reports/:id */
export type ReportRows = Record<string, unknown>[];
