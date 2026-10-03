/**
 * The HTTP contract between the Worker and the web client.
 *
 * Dependency-free on purpose: imported by server plugins (to type what they return)
 * and by the Vue app (to type what it receives). Change a shape here and both sides
 * fail to typecheck until they agree.
 */
import type { BadgeData, BannerData, CardsData, CellsData, ReportData, RowsData, SyncData, TimersData, TreeData, UiText } from './ui';

import type { AdventureStats, GroupOutcome, MonsterGroup } from './realms';

export interface ApiErrorBody {
	/** `text`: what to show (translated by the client); `message`: the English key, for logs. */
	error: { code: string; message: string; text?: UiText };
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
	/** What other plugins say it does at this level (e.g. a wall's defence), see `buildings.addEffectLines`. */
	lines?: UiText[];
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
	blocked?: UiText;
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
	/**
	 * Building another outer city (ring settlements only): tiles it may go on, and what the next one
	 * costs. `blocked`: why none can be built now (e.g. the research limit), tiles still listed.
	 */
	nextOuter?: { candidates: { x: number; y: number }[]; cost: Record<string, number>; blocked?: UiText };
	/** Terrain of the districts' and candidates' tiles by "x,y", with its production bonus in % (terrain plugin). */
	terrain?: Record<string, { terrain: string; name?: string; bonus: Record<string, number> }>;
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
	/** Where the cap comes from, a line each ("Base 10,000", "Warehouse +50,000"). */
	capacitySources: UiText[];
	/** Where the production factor comes from, a line each ("Heroes on duty +12%"). */
	factorSources: UiText[];
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
	next: { level: number; cost: Record<string, number>; seconds: number; blocked?: UiText; locked?: UiText } | null;
	/** Place in the tree (absent for techs outside it, e.g. runtime discoveries). */
	branch?: string;
	tier?: number;
	order?: number;
	quote?: string;
	/** Techs needed (id -> level) before level 1. */
	requires: Record<string, number>;
	/** Building levels it unlocks: from tech level `level` on, the building may reach `from` and above. */
	unlocks: { building: string; at: { level: number; from: number }[] }[];
	/** Effects per level (stat ids or describer keys; see TechEffect in the research plugin). */
	effects: { target: string; value: number; percent: boolean; family?: string; familyName?: string; atLevel?: number }[];
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
	category: string;
	count: number;
	usable: boolean;
}

/** A training batch or plan (docs/design/gameplay.md §2.5). */
export interface TrainingBatch {
	id: string;
	/** The barracks type it trains in (each has its own queue). */
	line: string;
	unit: string;
	count: number;
	/** What was paid; a waiting plan gives it back if cancelled. */
	cost: Record<string, number>;
	/** Null while it waits. */
	startedAt: number | null;
	finishesAt: number | null;
}

/** view `troops.garrison` (param `settlement`, default: capital). */
export interface GarrisonInfo {
	settlement: string;
	/** Whether this kind of settlement can hold troops at all. */
	allowed: boolean;
	units: { id: string; count: number }[];
	/** Training in every barracks: per line (barracks type), the batch training (times set), then the plans waiting. */
	training: TrainingBatch[];
	/** Upkeep per second of the whole garrison. */
	upkeep: Record<string, number>;
	/** Attack / defence / hp totals of the garrison (battles add walls, heroes, counters...). */
	power: { attack: number; defense: number; hp: number };
	/** Units that can be trained here now, with the per-unit cost and time, or why not. */
	trainable: { unit: string; cost: Record<string, number>; seconds: number; blocked?: UiText }[];
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
		attacker: { source: UiText; stat: string; flat?: number; percent?: number }[];
		defender: { source: UiText; stat: string; flat?: number; percent?: number }[];
	};
	/** Casualty hooks that changed something: side, step (damage, spread, total, final) and source. */
	adjustments: { side: 'attacker' | 'defender'; stage: string; source: UiText }[];
}

export interface BattleReport {
	/** What was at the target: "empty", an NPC kind, or a player settlement. */
	target: { kind: string; name?: string; ownerName?: string | null };
	outcome: 'no-battle' | 'victory' | 'defeat';
	/** Why there was no battle, e.g. "Under beginner protection". */
	note?: UiText;
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
	/** Who attacked, when it was not a player (e.g. bandits: their kind and level). */
	attacker?: { name: string; level?: number };
	/** What the defender won (e.g. beating bandits). */
	rewards?: RewardLine[];
	/** What the attacker won besides plunder and captives: drops from the target's loot pool (NPC settlements, players). */
	spoils?: RewardLine[];
	/** The defender's prestige change. */
	prestige?: number;
}

/** view `armies.incoming`: hostile armies heading for the player's settlements (no unit details). */
export interface IncomingArmy {
	id: string;
	/** The player's settlement being targeted. */
	settlement: string;
	arrivesAt: number;
	attackerName: UiText | null;
	/**
	 * What the defender's scouts make out (stat `armies.scouting`): 1 = about how many in all,
	 * 2 = about how many of each unit, 3 = exactly. Absent without scouts.
	 */
	intel?: { level: number; total?: number; units?: Record<string, number> };
}

/** view `pvp.defenses`: recent attacks on the player (newest first). */
export interface DefenseReport {
	id: string;
	at: number;
	settlement: string;
	attackerName: UiText | null;
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

/** view `world-map.markers` (params x, y, r): tiles held by something other than a settlement, e.g. a realm. */
export interface MapMarker {
	x: number;
	y: number;
	/** Namespaced by the plugin that holds the tile, e.g. "realms.site". */
	kind: string;
	icon: string;
	/** Text to translate. */
	name: string;
	/** Free-form ids for the plugin's own client code (e.g. { realm: "black-wind" }). */
	data?: Record<string, string>;
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
	level: number;
	/** Experience towards the next level, and how much that level needs (null: highest level). */
	exp: number;
	expToNext: number | null;
	/** Attribute points gained automatically at each level up (total), and by attribute (null: older heroes, spread at random). */
	talent: number;
	talents: Record<string, number> | null;
	/** Free points not yet spent, and those spent by attribute (included in `attrs`). */
	freePoints: number;
	alloc: Record<string, number>;
	/** Bonuses from other plugins (e.g. equipment), not included in `attrs`. */
	bonus: Record<string, number>;
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
	/** Regular candidates by slot (null: recruited, or nobody this time), then any the GM placed (`gift`, slot -1, free). */
	candidates: ({
		slot: number;
		gift?: string;
		surname: string;
		given: string;
		gender: 'm' | 'f';
		attrs: Record<string, number>;
		/** Talent points by attribute (gained at every level up). */
		talents?: Record<string, number>;
	} | null)[];
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
	/** What each hero would give in each role (governor, scholar, command, defend), by hero id. */
	'starter-heroes.roles': HeroRoles;
	'world-map.markers': MapMarker[];
	'realms.overview': RealmsOverview;
	'equipment.bag': EquipmentBag;
	'starter-equipment.shop': RealmShop;
	'shop.store': ShopStore;
	'shop.cards': CardsData;
	'items.cards': CardsData;
	'items.shortcuts': CardsData;
	'troops.training': TimersData | null;
	'troops.garrisons': RowsData;
	'heroes.defense-rows': RowsData | null;
	'starter-heroes.posts-city': RowsData | null;
	'starter-heroes.posts-entry': RowsData | null;
	'realms.away': TimersData;
	'realms.injured': TimersData | null;
	'starter-equipment.shop-rows': RowsData | null;
	'armies.alerts': TimersData;
	'armies.marches': TimersData;
	'research.queue': TimersData;
	'research.current': TimersData | null;
	'research.options': CardsData | null;
	'research.graph': TreeData;
	'starter-siege.queue': TimersData | null;
	'starter-siege.rows': RowsData | null;
	'prestige.status': PrestigeStatus | null;
	'prestige.badge': BadgeData | null;
	'starter-siege.wall': SiegeWall | null;
	'settlements.districts': CellsData | null;
	'buildings.slots': CardsData;
	'equipment.gear': RowsData | null;
	'armies.due': SyncData;
	'troops.due': SyncData;
	'realms.due': SyncData;
	'realms.list': RowsData;
	'heroes.candidate-cards': CardsData;
	'heroes.cards': CardsData | null;
	'mail.announcement': BannerData | null;
}

export type HeroRoles = Record<string, Record<string, { effect: string; percent: number }[]>>;

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
	title: UiText;
	data: unknown;
	read: boolean;
	/** How to show it (widget `ui.report`), from the presenter its sender registered for this kind, if any. */
	report?: ReportData;
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
	attackerName: UiText | null;
	report: BattleReport;
}

/** `data` of a "war-reports.shortage" message. */
export interface ShortageMail {
	settlement: string;
	resource: string;
	routed: Record<string, number>;
	downgraded: { from: string; to: string; count: number }[];
}

/** view `mail.inbox` (params `mailBefore` / `mailBeforeId`: the time and id of the last message of the previous page; none = newest). */
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
	label: UiText;
	type: FormFieldType;
	required?: boolean;
	min?: number;
	max?: number;
	maxLength?: number;
	placeholder?: UiText;
	default?: string | number | boolean;
	/** `when`: the option is offered only while those fields have those values (e.g. heroes of the chosen origin). */
	options?: { value: string; label: UiText; when?: Record<string, string> }[];
	/** Selects sharing a group never pick the same non-empty value: a value chosen in one is not offered in the others. */
	distinct?: string;
	/** Type 'widget': which client editor renders it, and what the server hands that editor. */
	widget?: string;
	data?: unknown;
	/** A placeholder that follows another field's value (e.g. "At most 120" for the chosen unit); else `placeholder`. */
	placeholderBy?: { field: string; values: Record<string, UiText> };
	/** Read-only numbers shown before the input, as a row of the form's table (see `FormSpec.columns`). */
	cells?: (string | number)[];
}

/**
 * A limit the client checks while the form is filled in (the server checks it again): the
 * numbers in `use` add up to at most Σ value × weight over `capacity`, e.g. supplies up to
 * what the chosen units can carry. Shown as "label: used / total".
 */
export interface FormBudget {
	label: UiText;
	use: string[];
	capacity: Record<string, number>;
}

/**
 * A form attached to a command. The generic client renders it where `placement` says
 * and submits `{ type: command, payload: { [field]: value } }`.
 */
export interface FormSpec {
	title: UiText;
	description?: UiText;
	/** Where the client shows it, e.g. "settlement" (current settlement panel) or "global". */
	placement: string;
	fields: FormField[];
	submitLabel?: UiText;
	/** Ask for confirmation before submitting. */
	confirm?: UiText;
	/** Shown over the whole screen when the command succeeded, until the player closes it (instead of the short "Done"). */
	notice?: UiText;
	/** Shown at once while it is being submitted, e.g. "Using a Breakthrough Stone…" (default: "<title>: working…"). */
	pending?: UiText;
	budgets?: FormBudget[];
	/**
	 * Headers of a table for the fields that have `cells`: the label column, one per cell, then the input.
	 * Those fields show as its rows (e.g. an attribute: total, base, talent, bonus, then the points to add).
	 */
	columns?: UiText[];
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
/**
 * What a declaration hands its widget: `view` (and `params`) say where its data comes from (the client
 * asks for that view in every sync); the rest is the widget's own settings.
 */
export interface UiProps {
	view?: string;
	params?: Record<string, string>;
	[key: string]: unknown;
}

/** Meta `ui`: the layout the server declares (docs/design/ui.md §3). Widgets are named `<owner>.<name>`. */
export interface UiLayout {
	pages: { id: string; label: string; order: number; tab: boolean; widget?: string; props?: UiProps }[];
	blocks: { page: string; column: 'left' | 'right'; widget: string; order: number; props?: UiProps }[];
	entries: { kind: string; widget: string; order: number; types?: string[]; props?: UiProps }[];
	bands: { band: 'top' | 'bottom'; widget: string; order: number; props?: UiProps }[];
	slots: { slot: string; widget: string; order: number; props?: UiProps }[];
	/** Mail kind -> widget. */
	mail: Record<string, string>;
}

export interface Meta {
	plugins: { id: string; version: string; description?: string }[];
	/** Translations shipped by the server plugins, by locale (i18n plugin). */
	i18n?: Record<string, Record<string, string>>;
	/** What is shown where (ui plugin): the client lays out its widgets from this. */
	ui?: UiLayout;
	/** Buildings where research is started (research plugin): their entries hold the research controls. */
	researchLabs?: string[];
	/** Tech names by id (research plugin). */
	techs?: { id: string; name: string }[];
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
	/** Items (items plugin): `shortcuts` = where else a button for it shows ("building:<type>", "page:<id>"); `sources` = where to get it ("shop", "realms"...). */
	items?: { id: string; name: string; icon?: string; description?: string; usable: boolean; shortcuts: string[]; sources: string[] }[];
	/** Realms in difficulty order (realms plugin). */
	realms?: { id: string; name: string; order: number }[];
	/** Equipment slots and rarities (equipment plugin). */
	equipment?: {
		slots: { id: string; name: string; icon?: string; group?: string }[];
		rarities: { id: string; name: string; order: number }[];
		storageBuildings: string[];
	};
	[key: string]: unknown;
}

/** GET /api/auth/me, login, register. */
export interface User {
	id: string;
	username: string;
	gm: boolean;
	createdAt: number;
	/** Logged in with an initial password (the GM's from GM_PASSWORD): nothing else works until it is changed. */
	mustChangePassword?: boolean;
}

/** POST /api/auth/password */
export interface ChangePasswordRequest {
	oldPassword: string;
	newPassword: string;
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
	error: UiText | null;
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

/* ----- realms (docs/design/gameplay.md §9) ----------------------------------------- */

/** Something gained in an adventure, for reports. `name` is text to translate. */
export interface RewardLine {
	/** "exp", "item", "equipment"... (whoever gives it decides). */
	kind: string;
	name: string;
	count?: number;
	icon?: string;
	/** E.g. equipment rarity. */
	rarity?: string;
	/** It could not be kept (e.g. the bag was full). */
	lost?: boolean;
}

export interface RealmTaskInfo {
	index: number;
	name: string;
	groups: MonsterGroup[];
	/** Experience for each group beaten. */
	exp: number[];
	/** What a beaten group drops is worth at least this much (before luck). */
	loot: number;
	/** Cleared at least once by this player. */
	cleared: boolean;
	/** Possible drops by how often they fall, and the rewards for clearing (only once cleared). */
	drops?: { common: RewardPreview[]; uncommon: RewardPreview[]; rare: RewardPreview[]; clear: RewardPreview[] };
}

export type RewardPreview = Omit<RewardLine, 'count' | 'lost'>;

export interface RealmInfo {
	id: string;
	name: string;
	quote?: string;
	order: number;
	unlocked: boolean;
	/** Where it is on the map. */
	sites: { x: number; y: number }[];
	tasks: RealmTaskInfo[];
}

export interface AdventureInfo {
	id: string;
	hero: string;
	realm: string;
	task: number;
	startedAt: number;
	finishesAt: number;
}

export interface InjuryInfo {
	hero: string;
	/** null: not being treated yet. */
	healingUntil: number | null;
	/** What treating it costs (paid by its settlement) and takes. */
	cost: Record<string, number>;
	seconds: number;
}

/** view `realms.overview`. */
export interface RealmsOverview {
	realms: RealmInfo[];
	adventures: AdventureInfo[];
	injured: InjuryInfo[];
	/** Adventure numbers of the player's heroes, by hero id. */
	heroStats: Record<string, AdventureStats>;
	/** Seconds each monster group takes; the damage floor (share of attack). */
	groupSeconds: number;
	minDamage: number;
	/** Margins (see `margin` in src/shared/realms.ts) of the four expected outcomes: easy win, worth a try, an uphill fight, below: a heavy loss. */
	outlook: { easy: number; even: number; hard: number };
}

/** `data` of a "realms.report" message. */
export interface RealmMail {
	realm: string;
	realmName: string;
	task: number;
	taskName: string;
	hero: { id: string; surname: string; given: string };
	stats: AdventureStats;
	groups: (MonsterGroup & GroupOutcome & { rewards: RewardLine[] })[];
	exp: number;
	levels: number;
	cleared: boolean;
	clearRewards: RewardLine[];
	injured: boolean;
}

/* ----- equipment (docs/design/gameplay.md §10) ------------------------------------- */

export interface EquipmentPiece {
	id: string;
	base: string;
	/** Text to translate. */
	name: string;
	icon?: string;
	slot: string;
	tier: number;
	rarity: string;
	/** E.g. { "adv.attack": 31, "battle.attack": 2.1, "attr.might": 12 }. */
	stats: Record<string, number>;
	/** The hero wearing it, or null: then it is stored in `settlement`. */
	hero: string | null;
	settlement: string | null;
	/** Heroes below this level cannot wear it. */
	minLevel?: number;
	/** Its set's name (text to translate). */
	set?: string;
}

/** view `equipment.bag`: every piece the player owns, and how full each settlement's storage is. */
export interface EquipmentBag {
	storage: Record<string, { used: number; capacity: number }>;
	/** How many slots of each group (e.g. "accessory") each hero may fill, by hero id. */
	groups: Record<string, Record<string, number>>;
	pieces: EquipmentPiece[];
	/** Metal (or whatever the content says) smelting each piece gives, by piece id. */
	smelt: Record<string, Record<string, number>>;
}

/* ----- shop (docs/design/gameplay.md §11) ------------------------------------------ */

export interface ShopOffer {
	id: string;
	item: string;
	/** The item's name, icon and description (text to translate). */
	name: string;
	icon?: string;
	/** Colours the name (e.g. a chest of gold pieces). */
	rarity?: string;
	description?: string;
	/** Items per purchase, and the price in coupons. */
	count: number;
	price: number;
	category: string;
	/** Purchases allowed per day (server time, UTC), 0 = no limit; how many were made today. */
	dailyLimit: number;
	boughtToday: number;
}

/** view `shop.store`. */
export interface ShopStore {
	balance: number;
	offers: ShopOffer[];
}

/* ----- siege defences (docs/design/gameplay.md §3.13) ------------------------------ */

/** view `starter-siege.wall` (param `settlement`): the wall's works, defences and what is being built. */
export interface SiegeWall {
	settlement: string;
	/** The wall's level (defences unlock with it). */
	wall: number;
	/** `effect`: "attacker.attack" etc.; `value`: % at the current level; `next`: the next level, if any. */
	works: {
		id: string;
		name: string;
		icon?: string;
		level: number;
		maxLevel: number;
		effect: string;
		value: number;
		next: { value: number; cost: Record<string, number>; seconds: number; upkeep: Record<string, number> } | null;
	}[];
	/** Per defence: what one adds, costs, takes and costs to keep (per hour). */
	devices: {
		id: string;
		name: string;
		icon?: string;
		count: number;
		stat: string;
		value: number;
		wall: number;
		cost: Record<string, number>;
		upkeep: Record<string, number>;
		seconds: number;
	}[];
	/** What is being built now. */
	queue: { kind: 'device' | 'work'; item: string; amount: number; startedAt: number; finishesAt: number } | null;
	/** What waits behind it, in order (paid already; cancelling gives the cost back). */
	waiting: { id: string; kind: 'device' | 'work'; item: string; amount: number }[];
	/** Upkeep per hour of everything built here. */
	upkeep: Record<string, number>;
}

/** view `starter-equipment.shop`: white pieces for sale (those the player's opened realms drop). */
export interface RealmShop {
	offers: { base: string; name: string; icon?: string; slot: string; set: string; minLevel: number; cost: Record<string, number> }[];
}

/** View prestige.status: the player's prestige and rank (by their best prestige; ranks never fall). */
export interface PrestigeStatus {
	value: number;
	best: number;
	rank: { index: number; name: string };
	/** The next rank, if any. */
	next?: { name: string; threshold: number };
}
