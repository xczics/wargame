/**
 * The HTTP contract between the Worker and the web client.
 *
 * Dependency-free on purpose: imported by server plugins (to type what they return)
 * and by the Vue app (to type what it receives). Change a shape here and both sides
 * fail to typecheck until they agree.
 */
import type {
	BadgeData,
	BannerData,
	CardsData,
	CellsData,
	ReportData,
	RowsData,
	SyncData,
	TableData,
	TimersData,
	TreeData,
	UiText,
} from './ui';

import type { AdventureStats, GroupOutcome, MonsterGroup } from './realms';
import type { TechPlan } from './research';

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
	/** Views computed again with other parameters (`instances` of the request), by the client's key: e.g. each visible form area's forms. */
	instances?: Record<string, unknown>;
	/** The static views' versions (`ctx.statics`): fetched from /api/static/<id>/<version> when one moves on, cached. */
	statics?: Record<string, string>;
	/**
	 * Stamps of views that have one (`View.stamp`): the client sends them back (query parameter `stamps`); a view
	 * whose stamp is the same is left out of `views` (unchanged: the client keeps it).
	 */
	stamps?: Record<string, string>;
	/** The same for instances, by the client's key. */
	instanceStamps?: Record<string, string>;
	/** The meta's version (`/api/meta/<version>`, kept by the browser): a new one after a deploy. */
	metaVersion?: string;
	/** The file bucket's public URL, when the deployment has one: static views are fetched from `<filesBase>/static/<id>/<version>.json`. */
	filesBase?: string;
}

/**
 * GET /api/data?keys=[{ "key", "view", "params" }]&stamps={ "<key>": "<stamp>" }: data views by key, each under its own
 * parameters, for the client's store (asked on demand). Read only, no display: a key whose stamp is the same is left out
 * of `data` (unchanged: the client keeps it) and its stamp comes back.
 */
export interface DataAnswer {
	now: number;
	data: Record<string, unknown>;
	stamps: Record<string, string>;
	statics?: Record<string, string>;
}

/** One more computation of a view with its own parameters, in the same request (query parameter `instances`, a JSON list). */
export interface ViewInstance {
	key: string;
	view: string;
	params: Record<string, string>;
	/** The stamp the client holds for it (its view has a `stamp`): unchanged, it is left out of `instances`. */
	stamp?: string;
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
	/** How many slots it has; `used`: how many have a building (the buildings plugin, also in a light detail). */
	size: number;
	used?: number;
	/** Each slot (not in a light detail). */
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

/**
 * view `buildings.state` (param `settlement`): a settlement's buildings as data. The City page's cards
 * (`buildings.slots`) are assembled from it and the static `buildings.catalog` in the browser.
 */
export interface BuildingsState {
	settlement: {
		id: string;
		kind: string;
		/** Name key of its kind. */
		kindName: string;
		name: UiText;
		x: number;
		y: number;
		garrison: boolean;
		districts: { id: string; type: string; idx: number; slots: number }[];
	};
	slots: { district: string; slot: number; building: string; level: number; cap: number }[];
	construction: { district: string; slot: number; building: string; targetLevel: number; startedAt: number; finishesAt: number }[];
	/** Places in the construction queue, and where its size comes from. */
	queue: { used: number; size: number; sources: UiText[] };
	/** Outer cities built and allowed (with sources), when it has any. */
	outer?: { count: number; cap: number; sources: UiText[] };
	/** What construction time is multiplied by here, and by which sources. */
	time: { factor: number; parts: UiText[] };
	/** Gate counters other plugins give (e.g. a tech's level). */
	counters: Record<string, number>;
	/** Other plugins' lines for a building by "district/slot": now and at its next level. */
	effects: Record<string, { now: UiText[]; next: UiText[] }>;
}

/** Resources of the selected holder (param `settlement`, default: capital). */
export interface ResourcePool {
	holder: string;
	/** Server time the amounts are at: the client counts on from here (the pool is not sent again until it changes). */
	at: number;
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

/** One resource's production by source (`resources.productionTable`), per second. */
export interface ProductionRow {
	raw: number;
	bonuses: { source: UiText; amount: number }[];
	upkeep: { source: UiText; amount: number }[];
	net: number;
}

/**
 * view `resources.sources` (param `settlement`): production by resource and source, per second (resources missing:
 * none). The City page's production table (`resources.production`) is assembled from it in the browser.
 */
export type ProductionRows = Record<string, ProductionRow>;

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

/**
 * view `research.state` (param `settlement`: whose institute to use; default capital): the player's part of the tech
 * tree as data. The tree, cards and timers (`research.tree`, `.queue`, `.current`, `.options`, `.graph`) are assembled
 * from it and the static `research.techs` (its `data`, a `ResearchCatalog`) in the browser (src/shared/research.ts).
 */
export interface ResearchState {
	/** Tech levels above 0. */
	levels: Record<string, number>;
	/** Everything the player is researching, with the settlement's name (`label`; `name` as stored), if it still exists. */
	jobs: (ResearchJob & { name?: string; label?: UiText })[];
	/** The selected settlement, null without one. */
	here: {
		id: string;
		name: UiText;
		/** Research labs there (stat `research.labs`; none: nothing can start there) and its research speed stat. */
		labs: number;
		labSpeed: number;
		/** Its resources now, for the prices. */
		have: Record<string, number>;
		/** What the cost modifiers multiply cost and time by here; `techs`: for a tech that differs. */
		factors: { cost: number; time: number; techs?: Record<string, { cost: number; time: number }> };
		/** Why a tech cannot start here, from other plugins' gates (asked only for those nothing else holds back). */
		gates: Record<string, UiText>;
		/** Where speed, time and cost come from, one part per source (only with an institute). */
		sources?: { speed: UiText[]; time: UiText[]; cost: UiText[] };
	} | null;
	/** Techs added for this player alone (not in the static tree), and then every runtime node's id in the order they were added. */
	own?: TechPlan[];
	nodes?: string[];
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

/**
 * Static view `items.catalog`: every item as content (name, icon and description keys, category, rarity, whether it is
 * used from the Items page) and each category's label key. The Items page's cards (`items.cards`) are worked out from it,
 * the view `items.owned` (item id -> how many the player has, above 0) and `items.extra` in the browser.
 */
export interface ItemCatalog {
	items: { id: string; name: string; icon?: string; description?: string; category: string; rarity?: string; usable: boolean }[];
	categories: Record<string, string>;
}

/** view `items.extra`: other plugins' data for their groups on the Items page (`items.addCards`), by source, in their order. */
export type ItemsExtra = { source: string; data: unknown }[];

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
	/** Its kind (names in meta `settlementKinds`). */
	kind: string;
	/** Whether this kind of settlement can hold troops at all (if not, nothing is trainable; the browser says why). */
	allowed: boolean;
	units: { id: string; count: number }[];
	/** Training in every barracks: per line (barracks type), the batch training (times set), then the plans waiting. */
	training: TrainingBatch[];
	/** Upkeep per second of the whole garrison. */
	upkeep: Record<string, number>;
	/** Attack / defence / hp totals of the garrison (battles add walls, heroes, counters...). */
	power: { attack: number; defense: number; hp: number };
	/**
	 * Units that can be trained here now, with the per-unit cost and time, or why not: a building (type) it needs at a
	 * level that is not there yet (`requires`, names in meta `buildings`), else another plugin's reason (`blocked`).
	 */
	trainable: {
		unit: string;
		cost: Record<string, number>;
		seconds: number;
		requires?: { building: string; level: number };
		blocked?: UiText;
	}[];
}

/**
 * view `troops.state` (param `settlement`: the one selected, default capital): the garrisons of the player's
 * settlements that can hold troops, as data. The Army page's rows (`troops.garrisons`) are assembled from it and the
 * meta (unit names, resource icons) in the browser.
 */
export interface TroopsState {
	selected: string | null;
	garrisons: {
		settlement: string;
		name: UiText;
		/** Units stationed, with each one's numbers under the current rules. */
		units: { id: string; count: number; attack: number; defense: number; hp: number }[];
		power: { attack: number; defense: number; hp: number };
		/** Upkeep per second of the whole garrison. */
		upkeep: Record<string, number>;
		/** What changes upkeep here, by source (`stats.factors`; none without upkeep). */
		upkeepBy: UiText[];
		/** Batches training (finish time) and plans waiting (null). */
		training: { unit: string; count: number; finishesAt: number | null }[];
	}[];
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
		/** `last`: added to every lane after every percentage (battle `Modifier.last`). */
		attacker: { source: UiText; stat: string; flat?: number; percent?: number; last?: number }[];
		defender: { source: UiText; stat: string; flat?: number; percent?: number; last?: number }[];
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

/** Hostile armies heading for the player's settlements (no unit details; view `armies.incoming` sends `IncomingAttack`). */
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

/** An incoming attack in view `armies.incoming`, with the name of the settlement it is heading for. */
export interface IncomingAttack extends IncomingArmy {
	place: UiText;
}

/** An army away from home (`armies.list` sends `ArmyMarch`). */
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

/** view `armies.list`: the player's armies away from home, with the names the Army page shows (`armies.marches`). */
export interface ArmyMarch extends ArmyInfo {
	/** The settlement it set out from. */
	fromName: UiText;
	/** What its report's target was, as players read it (with a report). */
	reportTarget?: UiText;
}

/** view `bandits.state`: until when bands leave the player alone (the Army page's `bandits.protection` timer). */
export interface BanditsState {
	/** 0: not protected now. */
	protectedUntil: number;
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

/** A candidate as rolled: its attributes, and its talent points by attribute when it has them. */
export interface HeroDraftInfo {
	surname: string;
	given: string;
	gender: 'm' | 'f';
	attrs: Record<string, number>;
	talents?: Record<string, number>;
}

/**
 * view `heroes.state` (param `settlement`): the heroes attached to a settlement as data. The Heroes page's cards
 * (`heroes.cards`) and defence order (`heroes.defense-rows`) are assembled from it in the browser.
 */
export interface HeroesState {
	settlement: { id: string; name: UiText };
	heroes: {
		id: string;
		surname: string;
		given: string;
		gender: 'm' | 'f';
		level: number;
		exp: number;
		/** Experience the next level needs (null: highest level). */
		expToNext: number | null;
		talent: number;
		talents: Record<string, number> | null;
		freePoints: number;
		/** Its own attributes, and what other plugins add to them (e.g. equipment) where they add anything. */
		attrs: Record<string, number>;
		bonus: Record<string, number>;
		/** Its duty (names in meta `heroes.duties`), and the settlement it serves when that is one of the player's. */
		duty: string;
		target: UiText | null;
		/**
		 * What other plugins attach to it as data (`heroes.addCardData`), by plugin id: their client plugins render it at
		 * the extension point "heroes.card" (`HeroCardPart`), e.g. what it gives in each role, its adventure numbers.
		 */
		parts?: Record<string, unknown>;
	}[];
	/** Heroes the player has anywhere, the limit and where it comes from. */
	total: number;
	cap: { value: number; sources: UiText[] };
	/** The saved defence order (hero ids), null = strongest first. */
	order: string[] | null;
}

/**
 * Client extension point "heroes.card" (`defineClientPart`): the lines (shown muted) a client plugin puts on a hero's
 * card from what its server plugin attached to the hero in `heroes.state` (`parts[id]`; absent: nothing attached).
 */
export type HeroCardPart = (data: unknown) => UiText[];

/** What starter-heroes attaches to a hero's card: per role (duty), the % of each effect it would give there. */
export type HeroRoleEffects = Record<string, Record<string, number>>;

/**
 * view `heroes.offers` (param `settlement`): each recruiting venue's candidates there as data (null: no settlement).
 * The candidate cards (`heroes.candidate-cards`) are assembled from it in the browser.
 */
export interface HeroOffers {
	settlement: string;
	attributes: { id: string; name: string }[];
	/** Icons of the resources the costs name. */
	icons: Record<string, string>;
	venues: {
		venue: string;
		/** Name key. */
		name: string;
		building: string;
		refreshesAt: number;
		cost: Record<string, number>;
		affordable: boolean;
		/** Slots recruited already in this window. */
		taken: number[];
		/** Regular candidates by slot (null: recruited, or nobody this time). */
		candidates: (HeroDraftInfo | null)[];
		/** Candidates the GM placed here (free), after the regular ones. */
		gifts: ({ id: string } & HeroDraftInfo)[];
	}[];
}

/** Views registered by the built-in plugins. */
export interface ViewMap {
	/** null while the player has no settlement. */
	'resources.pool': ResourcePool | null;
	'resources.sources': ProductionRows | null;
	'settlements.mine': SettlementSummary[];
	'settlements.detail': SettlementDetail | null;
	/** The light detail (no slots): the City page's district board is assembled from it in the browser. */
	'settlements.outline': SettlementDetail | null;
	'buildings.state': BuildingsState | null;
	'ui.forms': ResolvedForm[];
	'forms.patches': FormPatches;
	'research.state': ResearchState;
	'research.tree': ResearchTree;
	'items.inventory': ItemStack[];
	'items.owned': Record<string, number>;
	'items.extra': ItemsExtra;
	'troops.garrison': GarrisonInfo | null;
	/** Garrisons of all the player's settlements that can hold troops. */
	'troops.overview': GarrisonInfo[];
	'troops.units': UnitNumbers[];
	'troops.state': TroopsState;
	'battle.formation': BattleFormationInfo | null;
	'terrain.window': TerrainWindow | null;
	'heroes.list': HeroInfo[];
	'heroes.candidates': HeroCandidates[];
	/** The settlement's defence order (hero ids), null = strongest first. */
	'heroes.defense': { settlement: string; order: string[] | null } | null;
	'heroes.state': HeroesState | null;
	'heroes.offers': HeroOffers | null;
	'armies.list': ArmyMarch[];
	'armies.incoming': IncomingAttack[];
	'bandits.state': BanditsState;
	'bandits.protection': TimersData;
	'mail.inbox': MailInbox;
	/** One message whole (param `mail`: its id; null when there is no such message of the player's). */
	'mail.message': MailMessage | null;
	/** The unread count alone (the badge, on every page; the inbox is fetched on the mail page only). */
	'mail.unread': { unread: number };
	/** Other settlements around a point (params x, y, r, npc), nearest first. */
	'settlements.nearby': NearbyOverview;
	/** Heroes serving the selected settlement and what they give it (param `settlement`). */
	'starter-heroes.posts': HeroPost[] | null;
	/** What each hero would give in each role (governor, scholar, command, defend), by hero id. */
	'starter-heroes.roles': HeroRoles;
	'world-map.markers': MapMarker[];
	'realms.overview': RealmsOverview;
	'equipment.bag': EquipmentBag;
	'equipment.state': EquipmentState | null;
	'starter-equipment.shop': RealmShop;
	'shop.store': ShopStore;
	'shop.wallet': ShopWallet;
	'shop.cards': CardsData;
	'items.cards': CardsData;
	'puzzles.mine': PuzzleProgress[];
	'puzzles.album': PuzzleAlbumEntry[];
	'opaque-research.status': OpaqueStatus;
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
	'buildings.slots': CardsData;
	'settlements.districts': CellsData | null;
	'resources.production': TableData | null;
	'equipment.gear': RowsData | null;
	'armies.due': SyncData;
	'troops.due': SyncData;
	'realms.due': SyncData;
	'realms.list': RowsData;
	'heroes.candidate-cards': CardsData;
	'heroes.cards': CardsData | null;
	'mail.announcement': BannerData | null;
	'mail.notice': MailNotice | null;
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
	/** Their names (name-part keys, `heroes.nameKey`), in the same order. */
	names: string[];
	/** Summed effects, e.g. { effect: "production", percent: 12 } (time and loss effects are reductions). */
	effects: { effect: string; percent: number }[];
}

/** view `mail.notice`: the GM's announcement to every player (rule `mail.announcement`), as the GM wrote it. */
export interface MailNotice {
	text: string;
}

/** A message in a player's mailbox as the list shows it (view `mail.inbox`): what it is, not what it says. */
export interface MailHeader {
	id: string;
	at: number;
	/** Namespaced by the sending plugin, e.g. "war-reports.march"; the client renders `data` by it. */
	kind: string;
	title: UiText;
	read: boolean;
	/** It comes with attachments (a GM's mail): still to claim, or claimed. */
	gift?: 'unclaimed' | 'claimed';
}

/** A message whole (view `mail.message`): what it says never changes, so the client keeps it once fetched. */
export interface MailMessage extends MailHeader {
	data: unknown;
	/** How to show it (widget `ui.report`), from the presenter its sender registered for this kind, if any. */
	report?: ReportData;
	/** What comes with it (claimed with the command `mail.claim`). */
	attachments?: UiText[];
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

/** POST /api/gm/mail/broadcast (GM): a mail to every account made before it; answered with its `{ id }`. */
export interface MailBroadcastRequest {
	title: string;
	body: string;
	/** Rewards claimed once by each player (`mail.claim`), at most 20. */
	attachments?: Reward[];
}

/** view `mail.inbox` (params `mailBefore` / `mailBeforeId`: the time and id of the last message of the previous page; none = newest). */
export interface MailInbox {
	messages: MailHeader[];
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
	/** An NPC camp's level (from the plugin that owns camps). */
	level?: number;
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
	/**
	 * A placeholder the client keeps counting (e.g. "At most 1,234" of a stock that grows): `text` with {0} = the
	 * amount now, from `values` by the value of field `by` (or under "" without it): `amount` at server time `at`
	 * (ms), changing by `rate` a second, kept within 0 and `cap`. Sent once with the form, worked out as time passes.
	 */
	placeholderLive?: { by?: string; text: UiText; values: Record<string, { amount: number; rate: number; at: number; cap?: number }> };
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

/** view `ui.forms` (assembled in the browser): forms available right now (param `placement`, plus context such as `settlement`). */
export interface ResolvedForm extends FormSpec {
	command: string;
	/** Plugin that owns the command (to group forms, e.g. in the GM console). */
	owner: string;
}

/** What a form's `prepare` adds now: runtime fields, defaults, options, a description, budgets (see the kernel's `CommandForm`). */
export interface FormPatch {
	/** Extra fields known only at runtime (e.g. one number per unit type), appended to the form's. */
	fields?: FormField[];
	/** Default values by field name (e.g. the current settlement id for a hidden field). */
	defaults?: Record<string, string | number | boolean>;
	/** Placeholders that follow another field's value, by field name (see `FormField.placeholderBy`). */
	placeholderBy?: Record<string, NonNullable<FormField['placeholderBy']>>;
	/** Replace a select's options by field name. */
	options?: Record<string, NonNullable<FormField['options']>>;
	/** Text shown above the fields (e.g. "3 / 8 outer cities built"). */
	description?: UiText;
	/** Limits checked while filling in, added to the form's (see `FormBudget`). */
	budgets?: FormBudget[];
	/** Headers of the table of fields with `cells` (see `FormSpec.columns`). */
	columns?: UiText[];
}

/** Static view `forms.specs`: every command form's fixed part, by command (made at deploy / a GM rule change, via R2). */
export type FormSpecs = Record<string, FormSpec & { command: string; owner: string }>;

/** view `forms.patches` (param `placement` + context): the forms available now, in order, with what `prepare` added. */
export interface FormPatches {
	forms: { command: string; patch?: FormPatch }[];
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
	/** More views the widget reads (fetched where it can be seen, like `view`), e.g. a second tab's. */
	views?: string[];
	params?: Record<string, string>;
	[key: string]: unknown;
}

/** A static view's field that must be true (static views change only with the rules: a GM switch, a deploy). */
export interface UiWhen {
	static: string;
	field: string;
}

/** Meta `ui`: the layout the server declares (docs/design/ui.md §3). Widgets are named `<owner>.<name>`. */
export interface UiLayout {
	/** `when`: the tab shows only while that static view's field is true (e.g. a feature the GM switched on). */
	pages: { id: string; label: string; order: number; tab: boolean; widget?: string; props?: UiProps; when?: UiWhen }[];
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
	/** The coupon shop's offers and the names of their items (GM rule editor). */
	shopOffers?: { id: string; name: string }[];
	/** The realms' reward pools ("<realm>.<task>") and their drops, with names (GM rule editor). */
	realmPools?: { id: string; name: UiText }[];
	/** Siege defences and wall works by id, with names (GM rule editor). */
	siegeItems?: { id: string; name: string }[];
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
	/** An i18n key (the thing's name). */
	name: string;
	/** Instead of `name` when shown: a text with variables (e.g. which piece of which puzzle). */
	label?: UiText;
	count?: number;
	icon?: string;
	/** E.g. equipment rarity. */
	rarity?: string;
	/** It could not be kept (e.g. the bag was full). */
	lost?: boolean;
}

/* ----- opaque research ------------------------------------------------------------------ */

/** An application a hero wrote (view `opaque-research.status`): worked out when looked at; its text is put together by the client. */
export interface OpaqueApplication {
	hero: string;
	/** The hero's name key (spelled by the client). */
	heroName: string;
	/** 1 = the lowest tier (丙) ... 4 = a major project. */
	tier: number;
	/** Sent back to approve: the application must be the same one then. */
	season: number;
	version: number;
	/** Picks the sentences (the same application, the same text). */
	seed: string;
	/** The dimension aimed at (0-255; its code name is in the texts) and its group (what it gives: the texts' `groups`). */
	target: number;
	group: number;
	promise: boolean;
	/** The review's rate (0-1). */
	rate: number;
	/** What decides which sentences fit: progress, lead, attr, tier, promise, history, rate. */
	tags: Record<string, string>;
	cost: Record<string, number>;
	yuanbao: number;
	seconds: number;
}
export interface OpaqueProject {
	hero: string;
	heroName: string;
	tier: number;
	group: number;
	startedAt: number;
	endsAt: number;
}
export interface OpaqueStatus {
	/** Highest tier the Shuangqing Temple allows (0: none built: nothing else is worked out). */
	unlocked: number;
	running: number;
	max: number;
	applications: OpaqueApplication[];
	projects: OpaqueProject[];
	/** Thresholds passed in each group (x each bonus's percent a step in the texts' `groups` = what it gives now). */
	steps: number[];
}
/** What a group of dimensions gives: bonuses, each with its percent a step (GM rule `opaque-research.groups`). */
export type OpaqueGroup = { bonus: string; step: number }[];
/** What applications are made of (static view `opaque-research.texts`): sentences, code names, reviewers, bonus names. */
export interface OpaqueTexts {
	/** Sections in order: background, content, method, basis, review. */
	sentences: { section: string; when: Record<string, string>; weight: number; text: string }[];
	/** Code names of the 256 dimensions (i18n keys). */
	codes: string[];
	reviewers: string[];
	/** Bonus id -> its name (an i18n key), whether it raises or lowers, the percent a step the GM's editor suggests, its category there. */
	bonuses: Record<string, { name: string; direction: 'increase' | 'decrease'; step: number; category: string }>;
	/** What each group gives (the rule's layout, the same for everyone). */
	groups: OpaqueGroup[];
	/** Attribute id -> its name (an i18n key), for the sentences about the hero's best. */
	attributes: Record<string, string>;
}

/* ----- puzzles ------------------------------------------------------------------------- */

/** A puzzle as players see it (static view `puzzles.catalog`, by id): what does not change with the player. */
export interface PuzzleInfo {
	id: string;
	name: string;
	/** Pieces a side (grid x grid pieces, "A1" top left: rows by letter, columns by number). */
	grid: number;
	/** The picture's key in the file bucket (`game.fileUrl`); the client cuts it and blurs what is missing. */
	image: string | null;
	/** The GM's words under the picture (players' text: shown as written); none: nothing shown. */
	description?: string;
	/** Times a player may claim it. */
	limit: number;
	/** Still dropping (live) or not any more (closed: what one has can still be claimed). */
	dropping: boolean;
	/** No more to collect (closed or retired): sealed "out of print" in the album. */
	outOfPrint?: true;
	/** Retired by the GM (hidden): only in the albums of those who completed it. */
	retired?: true;
	/** What completing it brings. */
	rewards: UiText[];
	/** What a piece one already has turns into. */
	duplicate: UiText | null;
	/** A reward is aimed at a settlement the player picks when claiming (`puzzles.claim` with `settlement`). */
	chooseSettlement?: true;
}
/** A player's pieces (view `puzzles.mine`): only puzzles they have a piece of, or claimed. */
export interface PuzzleProgress {
	id: string;
	pieces: number[];
	claims: number;
	/** Spare (repeat) pieces kept to exchange on the Items page. */
	spares: number;
}

/**
 * A player's puzzle as `puzzles.progress` gives it (live or closed ones they have a piece of, or claimed): what it is
 * and how far along; `starter-puzzles` sends these for the Items page's puzzle cards (view `items.extra`).
 */
export interface PuzzleHolding {
	id: string;
	name: string;
	grid: number;
	/** The picture (a file of the bucket), if any. */
	image: string | null;
	limit: number;
	pieces: number;
	claims: number;
	/** Every piece the player has a copy of: how many (the one in the picture and the spares), and what a spare brings. */
	held: { piece: number; name: string; count: number; spares: number; reward: UiText | null }[];
}

/** A puzzle in the player's album (view `puzzles.album`): completed at least once; what it is: the catalog. */
export interface PuzzleAlbumEntry {
	id: string;
	claims: number;
	/** When first completed; null: before that was kept (1.5.1). */
	firstAt: number | null;
}

/** What the GM's puzzle screen edits (GET /api/gm/puzzles). */
export interface PuzzleDefData {
	id: string;
	name: string;
	grid: number;
	status: 'draft' | 'live' | 'closed' | 'hidden';
	image: string | null;
	/** Shown to players under the picture; empty: nothing. */
	description?: string;
	limit: number;
	duplicate: Reward | null;
	drops: PuzzleDropRule[];
	rewards: Reward[];
}
/** Something given (a puzzle's reward, a mail's attachment): a kind registered with `rewards.addKind`, and its settings. */
export interface Reward {
	kind: string;
	config: unknown;
}
export interface PuzzleDropRule {
	/** Piece numbers (0 = A1, row by row). */
	pieces: number[];
	/** Places (loot sites, e.g. "realms/black-wind/0/2"; a place covers everything under it). */
	sites: string[];
	/** Chance (0-1) every time loot is rolled there. */
	chance: number;
	/** What it counts towards the roll's minimum value. */
	value: number;
	/** What it turns into when one has it already (default: the puzzle's). */
	duplicate?: Reward;
}
/** A kind of reward, for GM screens (GET /api/gm/rewards; the fields to fill in). */
export interface RewardKindInfo {
	id: string;
	name: UiText;
	fields: {
		name: string;
		label: UiText;
		type: 'number' | 'select' | 'text';
		options?: { value: string; label: UiText }[];
		min?: number;
		max?: number;
	}[];
}
export interface PuzzleSite {
	id: string;
	label: UiText;
	children?: PuzzleSite[];
}
export interface PuzzlesGmData {
	puzzles: PuzzleDefData[];
	kinds: RewardKindInfo[];
	sites: PuzzleSite[];
	/** Largest picture accepted, in bytes; most pieces a side. */
	maxImage: number;
	maxGrid: number;
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
	tasks: RealmTaskInfo[];
}

export interface AdventureInfo {
	id: string;
	hero: string;
	realm: string;
	task: number;
	startedAt: number;
	finishesAt: number;
	/** Runs of the same task still to go after this one. */
	repeat?: number;
}

export interface InjuryInfo {
	hero: string;
	/** null: not being treated yet. */
	healingUntil: number | null;
	/** What treating it costs (paid by its settlement) and takes. */
	cost: Record<string, number>;
	seconds: number;
}

/**
 * view `realms.overview`: the player's realms, adventures and injured heroes as data. The Realms page (`realms.list`,
 * `realms.away`, `realms.injured`, the realm shop `starter-equipment.shop-rows`) is assembled from it in the browser.
 */
export interface RealmsOverview {
	realms: RealmInfo[];
	adventures: AdventureInfo[];
	injured: InjuryInfo[];
	/** Adventure numbers of the player's heroes, by hero id. */
	heroStats: Record<string, AdventureStats>;
	/** The player's heroes: name (name-part keys, `nameKey`), level, and whether idle (free to set out). */
	heroes: { id: string; name: string; level: number; idle: boolean }[];
	/** Most runs an adventure may be repeated after the first now (the rule and the repeat supply; 0: once only). */
	repeats: number;
	/** Seconds each monster group takes; the damage floor (share of attack). */
	groupSeconds: number;
	minDamage: number;
	/** Margins (see `margin` in src/shared/realms.ts) of the four expected outcomes: easy win, worth a try, an uphill fight, below: a heavy loss. */
	outlook: { easy: number; even: number; hard: number };
}

/** static view `realms.catalog`: the Realms page's rows, and the resource icons treatment costs are written with. */
export interface RealmsCatalog extends RowsData {
	icons: Record<string, string>;
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

/**
 * view `equipment.state` (params `settlement`, `hero`): a settlement's gear as data (null: no settlement). The gear
 * rows (`equipment.gear`) are assembled from it in the browser.
 */
export interface EquipmentState {
	settlement: string;
	/** Heroes attached here, and the one picked (param `hero`, else the first; null: none here). */
	heroes: { id: string; surname: string; given: string; level: number }[];
	hero: string | null;
	/** Accessories the picked hero may wear. */
	accessories: number;
	/** The slots and colours in their order (name keys). */
	slots: { id: string; name: string; group?: string }[];
	rarities: { id: string; name: string }[];
	/** What the picked hero wears, then what is stored here. */
	pieces: {
		id: string;
		/** Name key. */
		name: string;
		icon?: string;
		slot: string;
		rarity: string;
		/** Its numbers, by the name key of what each adds to. */
		stats: { name: string; value: number }[];
		hero: string | null;
		minLevel?: number;
		set?: { id: string; name: string };
	}[];
	storage: { used: number; capacity: number };
	/** What dismantling each stored piece gives (by piece id), and the icons of those resources. */
	smelt: Record<string, Record<string, number>>;
	icons: Record<string, string>;
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

/**
 * view `shop.wallet`: the player's coupons and purchases today by offer id. The shop page's cards (`shop.cards`, over the
 * static `shop.offers`) are worked out from it in the browser.
 */
export interface ShopWallet {
	balance: number;
	today: Record<string, number>;
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
		/** Its level once the orders queued are built: the next order raises it from there. */
		planned: number;
		maxLevel: number;
		effect: string;
		value: number;
		/** `seconds`: as the rules have it; `time`: what it takes at this wall (each level builds faster). */
		next: { value: number; cost: Record<string, number>; seconds: number; time: number; upkeep: Record<string, number> } | null;
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
		/** Build seconds of one at this wall. */
		time: number;
	}[];
	/** What is being built now. */
	queue: { id: string; kind: 'device' | 'work'; item: string; amount: number; startedAt: number; finishesAt: number } | null;
	/** What waits behind it, in order (paid already, `cost`; cancelling gives it back). */
	waiting: { id: string; kind: 'device' | 'work'; item: string; amount: number; cost: Record<string, number> }[];
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

/* ----- personalization (the site's icon, title...) --------------------------------------- */

/** A personalization field's value as browsers get it: a picture at a site path, a picture in the file bucket, or text. */
export type PersonalizationValue = { url: string } | { file: string } | { text: string };
/** Static view `personalization.site`: every field's current value, by its rule's key (e.g. "personalization.icon"). */
export type PersonalizationSite = Record<string, PersonalizationValue>;
/** What the GM's personalization tab edits (GET /api/gm/personalization); values are set through the rules (PUT /api/gm/config/:key). */
export interface PersonalizationGmData {
	fields: {
		/** The rule's key. */
		key: string;
		label: UiText;
		kind: 'image' | 'text';
		/** Built-in pictures (image fields): the rule's value is one's id, or an uploaded picture's key. */
		choices: { id: string; name: UiText; url: string }[];
		/** The rule's value now, and without the GM's override. */
		value: string;
		default: string;
		overridden: boolean;
		/** Text fields: the longest text allowed. */
		max?: number;
	}[];
	/** Pictures uploaded before (keys in the file bucket), newest first. */
	uploads: string[];
	/** Whether this deployment has a file bucket to upload to, and the largest picture (bytes). */
	canUpload: boolean;
	maxImage: number;
}
