// What a player set up for the assistant (docs/design/gameplay.md §15), kept in this browser only (per player): the
// queues, the rules, the switches and the log. Nothing of it reaches the server; "export" gives it as text to carry over.
import { reactive, watch } from 'vue';

/** What to do when a task cannot go ahead (gameplay.md §15.5). */
export type Policy = 'skip' | 'cancel' | 'block';

/** Which heroes a rule acts on (gameplay.md §15.3.0): named ones, or any matching the conditions; limits and order. */
export interface HeroPick {
	ids: string[];
	byConditions: boolean;
	levelMin?: number;
	levelMax?: number;
	attrs: { attr: string; op: '>=' | '<='; value: number }[];
	talentMin?: number;
	talentMax?: number;
	gender: '' | 'm' | 'f';
	/** idle, duty (in office), adventure, injured: empty = any. */
	states: string[];
	/** Home settlements: empty = any. */
	homes: string[];
	exclude: string[];
	max?: number;
	/** Heroes each settlement keeps at home (not taken by this rule). */
	keepPerCity?: number;
	order: 'levelAsc' | 'levelDesc' | 'nearUp' | 'attr' | 'random';
	orderAttr?: string;
}

/** Which settlements (camps' origins, batch building): named ones, all, or by kind. */
export interface CityPick {
	ids: string[];
	all: boolean;
	kinds: string[];
}

export interface BuildTask {
	id: string;
	settlement: string;
	district: string;
	slot: number;
	building: string;
	/** The level this task builds (one level a task). */
	level: number;
	onFail: Policy;
	/** Why it waits or failed last (shown under it). */
	note?: string;
}

/** A research target (gameplay.md §15.2.1): a tech to a level, expanded into steps at every look (research-plan.ts). */
export interface ResearchTarget {
	id: string;
	tech: string;
	level: number;
	/** Where to research: a settlement's id, or '' for any of the player's settlements with an institute free. */
	settlement: string;
	/** For the target's steps: a step that fails stands for its target. */
	onFail: Policy;
	/** Why it waits or failed last (the first step that did not go ahead). */
	note?: string;
	/** Each step's note of the last look, by "<tech>@<level>". */
	notes?: Record<string, string>;
}

export interface RealmTask {
	id: string;
	hero: string;
	realm: string;
	task: number;
	repeat: number;
	onFail: Policy;
	note?: string;
}

export interface LevelRule {
	id: string;
	on: boolean;
	name: string;
	heroes: HeroPick;
	/** The least outlook a task needs: "easy" (an easy win) or "even" (worth a try). */
	tier: 'easy' | 'even';
	by: 'perHour' | 'perRun';
	realms: string[];
	/** "<realm>/<task>" never picked. */
	exclude: string[];
	clearedOnly: boolean;
	/** Runs each time, travel packs permitting (0: one run). */
	repeat: number;
	stopAtLevel?: number;
	stopAt?: number;
	onInjury: 'stop' | 'wait';
	noTask: 'stop' | 'wait';
	/** Take heroes out of office to level them. */
	leaveDuty: boolean;
	stopped?: string;
	/** Why its heroes wait (last scan), shown under it. */
	note?: string;
}

export interface CampRule {
	id: string;
	on: boolean;
	name: string;
	from: CityPick;
	/** Settlement ids of camps named; otherwise by kind, level, distance. */
	targets: string[];
	kinds: string[];
	levelMin?: number;
	levelMax?: number;
	distance: number;
	pick: 'nearest' | 'highest' | 'random';
	/** Leave camps still refilling after a victory alone (absent: yes). */
	skipRefilling?: boolean;
	force: 'fixed' | 'factor';
	fixed: Record<string, number>;
	factor: number;
	formation: 'three' | 'five';
	shuffle: boolean;
	hero: HeroPick | null;
	heroMissing: 'fail' | 'without';
	stopTimes?: number;
	stopAt?: number;
	stopLosses?: number;
	stopGarrisonBelow?: number;
	stopLossStreak?: number;
	stopNoTarget: boolean;
	onFail: Policy;
	/** Kept by the assistant. */
	sent: number;
	lost: number;
	streak: number;
	/** Marches of this rule (ids) still out, and reports already counted. */
	marches: string[];
	stopped?: string;
}

export interface PointStage {
	/** Raise this attribute to `target` first (by the basis), then the next stage. */
	attr?: string;
	target?: number;
	/** Or split by these shares, for good. */
	ratio?: Record<string, number>;
}

export interface PointRule {
	id: string;
	on: boolean;
	name: string;
	heroes: HeroPick;
	stages: PointStage[];
	/** Points left unspent each time. */
	keep: number;
	basis: 'total' | 'free';
}

export interface LogEntry {
	at: number;
	area: 'build' | 'research' | 'realms' | 'camps' | 'points' | 'assistant';
	ok: boolean;
	text: string;
}

export interface AssistantData {
	version: 1;
	on: boolean;
	build: { on: boolean; tasks: BuildTask[]; reserve: Record<string, number>; reserveBy: Record<string, Record<string, number>> };
	/** Added later: an older save has none (filled in with the default on loading). */
	research: { on: boolean; targets: ResearchTarget[] };
	realms: { on: boolean; queue: RealmTask[]; leveling: LevelRule[] };
	camps: { on: boolean; rules: CampRule[] };
	points: { on: boolean; rules: PointRule[] };
	log: LogEntry[];
	/** Something needs the player (a queue blocked, a rule stopped): shown on the tab. */
	attention: string[];
}

const LOG_MAX = 300;

export const emptyData = (): AssistantData => ({
	version: 1,
	on: true,
	build: { on: true, tasks: [], reserve: {}, reserveBy: {} },
	research: { on: true, targets: [] },
	realms: { on: true, queue: [], leveling: [] },
	camps: { on: true, rules: [] },
	points: { on: true, rules: [] },
	log: [],
	attention: [],
});

export const newPick = (): HeroPick => ({
	ids: [],
	byConditions: false,
	attrs: [],
	gender: '',
	states: ['idle'],
	homes: [],
	exclude: [],
	order: 'levelAsc',
});

export const uid = () => Math.random().toString(36).slice(2, 10);

/** The player's settings, loaded from and saved to this browser (a private window may refuse: then they last the visit). */
export function useStore(playerId: string) {
	const key = `assistant:${playerId}`;
	let loaded: AssistantData = emptyData();
	try {
		const raw = localStorage.getItem(key);
		if (raw) loaded = { ...emptyData(), ...(JSON.parse(raw) as AssistantData) };
	} catch {
		// Unreadable or blocked: start empty.
	}
	const data = reactive(loaded) as AssistantData;
	let timer: ReturnType<typeof setTimeout> | null = null;
	watch(
		data,
		() => {
			// Saved a moment after the last change (typing in a form changes it on every key).
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				try {
					localStorage.setItem(key, JSON.stringify(data));
				} catch {
					// Full or blocked: kept for this visit.
				}
			}, 300);
		},
		{ deep: true },
	);
	const log = (area: LogEntry['area'], ok: boolean, text: string) => {
		data.log.unshift({ at: Date.now(), area, ok, text });
		if (data.log.length > LOG_MAX) data.log.length = LOG_MAX;
	};
	const flag = (text: string) => {
		if (!data.attention.includes(text)) data.attention.push(text);
	};
	/** The whole setup as text (no log), to carry to another browser. */
	const exported = () => JSON.stringify({ ...data, log: [], attention: [] });
	const restore = (text: string) => {
		const v = JSON.parse(text) as Partial<AssistantData>;
		if (v?.version !== 1) throw new Error('not an assistant export');
		Object.assign(data, { ...emptyData(), ...v, log: data.log, attention: [] });
	};
	return { data, log, flag, exported, restore };
}

export type Store = ReturnType<typeof useStore>;
