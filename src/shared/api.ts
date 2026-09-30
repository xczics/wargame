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
	/** Next level, if any: its cost (paid by the current settlement) and time. */
	next: { level: number; cost: Record<string, number>; seconds: number; blocked?: string } | null;
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
	/** Combat strength after modifiers (heroes, shortage penalties...). */
	power: { attack: number; defense: number; factors: { source: string; attack: number; defense: number }[] };
	/** Units that can be trained here now, with the per-unit cost and time, or why not. */
	trainable: { unit: string; cost: Record<string, number>; seconds: number; blocked?: string }[];
}

export interface UnitMeta {
	id: string;
	name: string;
	icon?: string;
	attack: number;
	defense: number;
	upkeep: Record<string, number>;
	/** Tiles per hour. */
	speed: number;
	/** Loot each unit can carry. */
	carry: number;
}

export interface BattleReport {
	/** What was at the target: "empty", an NPC kind, or a player settlement. */
	target: { kind: string; name?: string; ownerName?: string | null };
	outcome: 'no-battle' | 'victory' | 'defeat';
	/** Why there was no battle, e.g. "Under beginner protection". */
	note?: string;
	attack: number;
	defense: number;
	/** Modifiers applied to the attack, e.g. a hero leading the army. */
	attackFactors?: { source: string; factor: number }[];
	/** Units lost, by side. */
	losses: { attacker: Record<string, number>; defender: Record<string, number> };
	loot: Record<string, number>;
	/** Units captured (e.g. from an NPC fortress). */
	captured: Record<string, number>;
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
	phase: 'outbound' | 'returning';
	units: Record<string, number>;
	loot: Record<string, number>;
	report: BattleReport | null;
	departedAt: number;
	arrivesAt: number;
	returnsAt: number;
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
	'armies.list': ArmyInfo[];
	'armies.incoming': IncomingArmy[];
	'pvp.defenses': DefenseReport[];
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

export type FormFieldType = 'text' | 'number' | 'select' | 'checkbox' | 'hidden';

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
	options?: { value: string; label: string }[];
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
	resources?: ResourceMeta[];
	buildings?: BuildingMeta[];
	settlementKinds?: SettlementKindMeta[];
	map?: { min: number; max: number };
	stats?: { id: string; description: string }[];
	units?: UnitMeta[];
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
