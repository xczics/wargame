/**
 * Armies: units sent from a settlement to a map tile and back.
 *
 *   send -> (travel) -> arrive: encounter at the target -> (travel back) -> return home
 *
 * Travel uses the shortest way around the wrapping map at the pace of the slowest unit, and
 * takes at least `armies.minSeconds` each way. Units away from home cost no upkeep there:
 * the whole round trip's upkeep is paid when they leave (no send without it), and a recall
 * on the way out brings the part not needed back home with the army (it arrives with it,
 * like loot). Units that die lose what they carried.
 * Arrival and return are timeline events on the army entity (`army:<id>`), so they happen
 * on time even when the player is offline (cron sweep).
 *
 * Marches to one's own settlements go faster (`armies.ownSpeed`) and have no shortest time. Those shorter than
 * `armies.minSeconds` one way are settled in the send command itself (user 2026-10-21: "低于三分钟的，不设闹钟，直接结算"):
 * arrival (and return) in the same commit, with no row, timeline event or alarm left.
 *
 * Every march has a mission (`defineMission`): what it is for, which targets suit it and
 * what happens on arrival. Built in:
 *   - "attack": any target but the player's own settlements. What happens there is not decided
 *     here: plugins register encounter handlers (`addEncounter`) — raiding NPC camps, attacking
 *     players... The first handler that returns a report wins; with none, the army looks around.
 *   - "transfer": to another of the player's settlements, with supplies. The units stay there
 *     if it can hold a garrison; otherwise they unload and come back.
 *   - "transport": to another of the player's settlements and back. "to" carries supplies there;
 *     "back" goes empty and brings resources from there home (the way to empty a resource
 *     fortress, which holds no troops).
 * Other plugins add more (e.g. founding a settlement). A mission may carry supplies (`cargo`,
 * at most what the units can carry) and have a departure cost; both travel with the army and
 * come back home if it is recalled or the mission does not unload them.
 */
import {
	csvRules,
	definePlugin,
	derive,
	type EngineApi,
	type FlatCommand,
	type FlatContext,
	fields,
	gameErrors,
	numberInRange,
	playerStamp,
	PluginError,
	type ReadApi,
	shape,
} from '../../kernel';
import type { SyncData, UiText } from '../../shared/ui';
import type { FormPatch, ViewParams } from '../../kernel';
import type {
	ArmiesHastenFormData,
	ArmyInfo,
	ArmyMarch,
	BattleReport,
	FormField,
	FormOption,
	IncomingArmy,
	IncomingAttack,
	StagedEffect,
	StagedMarch,
} from '../../shared/api';
import type { Cost } from '../resources';
import type { Settlement } from '../settlements';
import type { UnitDef } from '../troops';
import type { Tile } from '../world-map';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('armies');
const text = uiTexts('armies');

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

export interface Encounter {
	/** `options`: what send options (see `addSendOption`) stored at departure, by key. */
	army: { id: string; playerId: string; from: string; units: Record<string, number>; options: Record<string, unknown> };
	tile: Tile;
	/** Entity occupying the tile (e.g. "settlement:<id>"), or null for empty land. */
	occupant: string | null;
	/** Total loot the surviving army could carry (handlers should respect it). */
	carry: number;
	/** When the army arrived. */
	at: number;
}

/**
 * Resolve an encounter, or return null if it is not about this kind of target. The report's
 * attacker losses, loot and captured units are applied to the army by the armies plugin;
 * the handler applies everything on the defender's side itself (and `api.lock`s it first).
 */
export type EncounterHandler = (api: EngineApi, encounter: Encounter) => Promise<BattleReport | null>;

/** Where a march is going, as seen at departure. */
export interface MissionTarget {
	from: Settlement;
	tile: Tile;
	/** Entity occupying the tile (e.g. "settlement:<id>"), or null for empty land. */
	occupant: string | null;
}

/** A mission's arrival: the encounter plus the mission's own data. */
export interface Arrival<V = unknown> extends Encounter {
	/** What the mission's `parse` returned at departure. */
	value: V;
	/** The mission's departure cost, carried along (e.g. materials to found a settlement). */
	cost: Cost;
	/** Supplies carried to the destination. */
	cargo: Cost;
}

export interface MissionOutcome {
	report: BattleReport;
	/** One of the player's settlements where the army ends its trip: the supplies are unloaded there. */
	deliverTo?: string;
	/** With `deliverTo`: the surviving units stay there (with the unused provisions) instead of going home. */
	station?: boolean;
	/** The departure cost goes back home with the army (e.g. the site was taken meanwhile). */
	refund?: boolean;
}

export interface Mission<V = unknown> {
	/** Also the `mission` value of `armies.send`. */
	id: string;
	name: string;
	/** Whether the army may carry supplies (at most what its units can carry). */
	cargo?: boolean;
	/** The army fights on arrival (attacking, uprooting...): send options for battles apply (`SendOption.forBattle`). */
	battle?: boolean;
	/** Why the target does not suit this mission, or null. Must only read. */
	check(api: EngineApi, target: MissionTarget): Promise<UiText | null>;
	/**
	 * The mission's own orders from the raw send payload (untrusted; throw `GameError`).
	 * `cost` is paid by the departing settlement with the provisions and travels with the army.
	 */
	parse?(api: EngineApi, raw: Record<string, unknown>, target: MissionTarget): Promise<{ value: V; cost?: Cost }>;
	/** What happens at the target. Runs in the timeline: only `api.write`, no other side effects; re-check the target. */
	arrive(api: EngineApi, arrival: Arrival<V>): Promise<MissionOutcome>;
}

/** A validated send order (see `parseOrder`). */
export interface SendOrder {
	from: string;
	tile: Tile;
	units: Record<string, number>;
	cargo: Cost;
	mission: string;
	/** The whole payload, for the mission's and send options' own fields. */
	raw: Record<string, unknown>;
}

/**
 * Extra orders another plugin attaches to a march (e.g. a battle formation). The armies
 * plugin only stores the parsed value and hands it to encounter handlers.
 */
export interface SendOption {
	key: string;
	/** Missions this option applies to (default: all). */
	missions?: string[];
	/** Applies to every mission that ends in a battle (`Mission.battle`, e.g. a formation), besides `missions`. */
	forBattle?: boolean;
	/**
	 * Its fields choose the units too (sent as `units`, e.g. a formation editor): the send form
	 * then has no unit counts of its own.
	 */
	choosesUnits?: boolean;
	/** Fields added to the send form (`params` as for form `prepare`). */
	fields?(api: EngineApi, params: Record<string, string>): Promise<FormField[]>;
	/** Validate the order from the raw send payload (API or form); undefined = none. Throw `GameError` if invalid. */
	parse(api: EngineApi, raw: Record<string, unknown>, send: { from: string; units: Record<string, number> }): Promise<unknown>;
	/** Once the army exists (same commit): side effects of the order, e.g. putting heroes at its head. */
	onSend?(api: EngineApi, value: unknown, army: { id: string; from: string }): Promise<void>;
	/**
	 * For the flat `armies.send` (`Command.flat`): what it reads and the derived values it needs (by the raw payload),
	 * then `run` gives the parsed value and the writes `onSend` would make, or null when this order needs the regular
	 * path (a throw is the regular path too, which gives its error). An option without it sends every march of its
	 * missions the regular way.
	 */
	flat?: SendOptionFlat;
}
export interface SendOptionFlat {
	derived?(f: FlatContext, send: FlatSend): { key: string; salt?: string }[];
	reads?(f: FlatContext, send: FlatSend): Record<string, D1PreparedStatement>;
	run(
		f: FlatContext,
		input: FlatSend & { army: string; rows: Record<string, Record<string, unknown>[]>; derived: Record<string, unknown> },
	): { value: unknown; writes?: D1PreparedStatement[] } | null;
}
export interface FlatSend {
	raw: Record<string, unknown>;
	from: string;
	units: Record<string, number>;
}

/**
 * An army whose trip is over: back home, or stationed elsewhere (`at` = where its units now
 * are; `from` when home). Runs in the timeline.
 */
export type ReturnListener = (api: EngineApi, army: { id: string; playerId: string; from: string; at: string }) => Promise<void>;

/** An army has reached its target and its mission is done (the report is final). Runs in the timeline. */
export type ArriveListener = (
	api: EngineApi,
	arrival: {
		army: { id: string; playerId: string; from: string; mission: string; units: Record<string, number> };
		tile: Tile;
		at: number;
		report: BattleReport;
		/** Supplies it carried (unloaded at `deliverTo`, else brought back). */
		cargo: Cost;
		/** Where it delivered, and whether its units stayed there. */
		deliverTo: string | null;
		station: boolean;
	},
) => Promise<void>;

/** Hostile forces heading for a player's settlements that are not marches (e.g. bandits). Must only read. */
export type IncomingSource = (
	api: ReadApi,
	playerId: string,
) => Promise<{ id: string; settlement: string; arrivesAt: number; attackerName: UiText; units: Record<string, number> }[]>;

export interface ArmiesService {
	addEncounter(handler: EncounterHandler): void;
	/** More entries for the incoming-attack warnings (scouts' intel applies to them too). */
	addIncoming(source: IncomingSource): void;
	/** Factor on a unit type's marching speed for a player (e.g. 1.05 from post roads). Must only read. */
	addSpeedModifier(modifier: (api: ReadApi, playerId: string, unit: UnitDef) => Promise<number>): void;
	/**
	 * A different pace for a whole army (e.g. carts carrying its slowest units), given its units and
	 * each unit's speed (modifiers applied); null = no say. The army marches at the fastest pace
	 * offered, else at its slowest unit's speed. Must only read.
	 */
	addPaceModifier(
		modifier: (api: ReadApi, units: Record<string, number>, speedOf: (unit: string) => number) => Promise<number | null>,
	): void;
	onArrive(listener: ArriveListener): void;
	addSendOption(option: SendOption): void;
	onReturn(listener: ReturnListener): void;
	defineMission<V>(mission: Mission<V>): void;
	/** A mission's name, an i18n key (e.g. for reports). */
	missionName(id: string): string;
	/** Validate an untrusted send payload (shape only; `dispatch` checks it against the game). */
	parseOrder(raw: unknown, mission?: string): SendOrder;
	/** Send an army of the acting player. Returns its id. */
	dispatch(api: EngineApi, order: SendOrder): Promise<string>;
	/**
	 * The generic parts of a send form for `mission` at tile `params.x/y`: origin, unit counts,
	 * supplies and the send options' fields. False when the player has no troops to send. Data: the counts, "at most"
	 * and the supplies' labels are worded in the browser (keep `data` when building on it).
	 */
	sendForm(
		api: EngineApi,
		params: ViewParams,
		mission: string,
		options?: { exclude?: string },
	): Promise<false | (Required<Pick<FormPatch, 'defaults' | 'options' | 'fields' | 'budgets'>> & Pick<FormPatch, 'data'>)>;
}

declare module '../../kernel' {
	interface ServiceMap {
		armies: ArmiesService;
	}
}

/** Most settlements one gathering fetches from (each is a march: keeps a command within the queries per call). */
const GATHER_MAX = 20;
const ARRIVE = 'armies.arrive';
const RETURN = 'armies.return';

interface Row {
	id: string;
	player_id: string;
	from_settlement: string;
	target_x: number;
	target_y: number;
	/** "done" only in memory: the trip ended in this call (the row is deleted). */
	phase: 'outbound' | 'returning' | 'done';
	units: string;
	loot: string;
	report: string | null;
	departed_at: number;
	arrives_at: number;
	returns_at: number;
	/** JSON { resource: amount }: upkeep paid for the round trip. */
	provisions: string;
	/** JSON { key: value } from send options. */
	options: string;
	mission: string;
	/** JSON { value, cost } of the mission. */
	mission_data: string;
	/** JSON { resource: amount }: supplies for the destination. */
	cargo: string;
	/**
	 * In memory: a short march to this own settlement, settled in the send command and never stored; what it moves is
	 * noted for the browser to play out (`StagedMarch`).
	 */
	staged?: { to: string; effects: StagedEffect[] };
}

const addCost = (...costs: Cost[]) => {
	const out: Cost = {};
	for (const c of costs) for (const [r, n] of Object.entries(c)) if (n > 0) out[r] = (out[r] ?? 0) + n;
	return out;
};

export default definePlugin({
	id: 'armies',
	version: '0.1.0',
	description: 'Marching armies with arrival encounters and return',
	dependsOn: ['troops', 'settlements', 'world-map', 'timeline', 'resources', 'accounts', 'stats', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const troops = ctx.services.get('troops');
		const settlements = ctx.services.get('settlements');
		const map = ctx.services.get('worldMap');
		const timeline = ctx.services.get('timeline');
		const resources = ctx.services.get('resources');
		const encounters: EncounterHandler[] = [];
		const incomingSources: IncomingSource[] = [];
		const sendOptions: SendOption[] = [];
		const returnListeners: ReturnListener[] = [];
		const arriveListeners: ArriveListener[] = [];

		const speed = ctx.config.define('speed', {
			description: 'Marching speed multiplier (2 = armies travel twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});
		const minSeconds = ctx.config.define('minSeconds', {
			description: 'Shortest time for one way of a march, in seconds.',
			default: () => RULES.minSeconds as number,
			parse: numberInRange(0, 1e7),
		});
		const ownSpeed = ctx.config.define('ownSpeed', {
			description:
				'Speed multiplier of marches to your own settlements, on top of the marching speed (2 = +100%). They have no shortest time.',
			default: () => RULES.ownSpeed as number,
			parse: numberInRange(0.01, 1e6),
		});
		/** Upkeep of `units` for `seconds`, by resource. */
		const provisionsFor = (api: ReadApi, units: Record<string, number>, seconds: number) => {
			const out: Record<string, number> = {};
			for (const [u, n] of Object.entries(units))
				for (const [r, perSec] of Object.entries(troops.stats(api, u).upkeep)) out[r] = (out[r] ?? 0) + perSec * n * seconds;
			return out;
		};

		const entity = (id: string) => `army:${id}`;
		/**
		 * A march to, or no longer to, another player's settlement: lock that player too, so this commit moves their
		 * state on (their "incoming attacks" are sent again: `playerStamp`). Nothing of theirs is read or written here.
		 */
		async function touchTarget(api: EngineApi, occupant: string | null) {
			if (!occupant?.startsWith('settlement:')) return;
			const owner = (await settlements.get(api, occupant.slice('settlement:'.length)))?.ownerId;
			if (owner && owner !== api.playerId) await api.lock(`player:${owner}`);
		}
		const occupantAt = async (api: EngineApi, x: number, y: number) => (await map.occupants(api, [{ x, y }])).get(`${x},${y}`) ?? null;
		timeline.addOwnerResolver(
			'army',
			async (db, id) =>
				(await db.prepare('SELECT player_id FROM armies_marches WHERE id = ?').bind(id).first<{ player_id: string }>())?.player_id ?? null,
			'(SELECT player_id FROM armies_marches WHERE id = {id})',
		);

		const load = (api: EngineApi, id: string) =>
			api.memo(
				`armies:row:${id}`,
				async () => (await api.db.prepare('SELECT * FROM armies_marches WHERE id = ?').bind(id).first<Row>()) ?? null,
			);
		/** All of a player's marches in one read (the rows the single loads then share). */
		const marchesOf = (api: EngineApi, playerId: string) =>
			api.memo(`armies:of:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT * FROM armies_marches WHERE player_id = ? ORDER BY departed_at')
					.bind(playerId)
					.all<Row>();
				const rows: Row[] = [];
				for (const r of results) {
					const row = await api.memo(`armies:row:${r.id}`, async (): Promise<Row | null> => r);
					if (row) rows.push(row);
				}
				return rows;
			});
		const toInfo = (r: Row): ArmyInfo => ({
			id: r.id,
			from: r.from_settlement,
			target: { x: r.target_x, y: r.target_y },
			mission: r.mission ?? 'attack',
			phase: r.phase === 'outbound' ? 'outbound' : 'returning',
			units: JSON.parse(r.units),
			loot: JSON.parse(r.loot),
			cargo: JSON.parse(r.cargo ?? '{}'),
			provisions: JSON.parse(r.provisions ?? '{}'),
			report: r.report ? JSON.parse(r.report) : null,
			departedAt: r.departed_at,
			arrivesAt: r.arrives_at,
			returnsAt: r.returns_at,
		});
		const carryOf = (api: ReadApi, units: Record<string, number>) => troops.totals(api, units).carry;
		const stats = ctx.services.get('stats');
		// Supplies a march may carry, relative to its units' carry (e.g. canals for transfers).
		stats.define({ id: 'armies.cargo', description: 'supplies carried', base: () => 1, min: 0 });
		// How well a player sees armies coming (0 = only that they come; see IncomingArmy.intel).
		stats.define({ id: 'armies.scouting', description: 'scouting', base: () => 0, integer: true, min: 0, max: 3 });
		const cargoFactor = (api: ReadApi) => stats.get(api, 'armies.cargo', `player:${api.playerId}`);
		const speedModifiers: ((api: ReadApi, playerId: string, unit: UnitDef) => Promise<number>)[] = [];
		/** Tiles per hour of the slowest unit, after the player's speed modifiers. */
		const paceModifiers: Parameters<ArmiesService['addPaceModifier']>[0][] = [];
		/**
		 * Each unit's marching speed for the player (modifiers applied), kept as a derived value for the flat
		 * `armies.send` (worked out by the send form). Not stale when events or amounts are written (read on the way).
		 */
		const marchOf = (api: EngineApi) =>
			derive(
				api,
				`armies:march:${api.playerId}`,
				{ owner: api.playerId, salt: '0', ignore: ['timeline_events', 'resources_balances'] },
				async () => {
					const speeds: Record<string, number> = {};
					for (const def of troops.list()) {
						let v = troops.stats(api, def.id).speed;
						for (const m of speedModifiers) v *= await m(api, api.playerId, def);
						speeds[def.id] = v;
					}
					return speeds;
				},
			);
		async function paceOf(api: ReadApi, units: Record<string, number>) {
			let slowest = Infinity;
			const speeds = new Map<string, number>();
			for (const [u, n] of Object.entries(units)) {
				const def = troops.get(u);
				if (!n || !def) continue;
				let speed = troops.stats(api, u).speed;
				for (const m of speedModifiers) speed *= await m(api, api.playerId, def);
				speeds.set(u, speed);
				slowest = Math.min(slowest, speed);
			}
			if (!Number.isFinite(slowest)) return 0;
			let pace = slowest;
			for (const m of paceModifiers) {
				const p = await m(api, units, (u) => speeds.get(u) ?? 0);
				if (p !== null && p > pace) pace = p;
			}
			return pace;
		}
		const missions = new Map<string, Mission>();
		/** The supplies in a raw send payload ("cargo.<id>" fields or a "cargo" object). */
		const optionsFor = (mission: string) =>
			sendOptions.filter((o) =>
				o.forBattle ? !!missions.get(mission)?.battle || !!o.missions?.includes(mission) : !o.missions || o.missions.includes(mission),
			);
		const settlementAt = (occupant: string | null) => (occupant?.startsWith('settlement:') ? occupant.slice('settlement:'.length) : null);
		const noBattle = (target: BattleReport['target'], note?: UiText): BattleReport => ({
			target,
			outcome: 'no-battle',
			...(note ? { note } : {}),
			attack: 0,
			defense: 0,
			losses: { attacker: {}, defender: {} },
			loot: {},
			captured: {},
		});

		// Forms send flat "units.<id>" / "cargo.<id>" fields; the API nested objects (the same once checked).
		// A transport's way ("to": deliver supplies; "back": fetch what `pickup` asks for, all if nothing).
		const transportFields = shape({
			pickup: fields.orElse(fields.record(fields.orElse(fields.number(0, 1e15), 0), { keys: () => resources.list().map((r) => r.id) }), {}),
			fill: fields.orElse(fields.bool(), false),
		});
		const orderShape = shape({
			from: fields.id(),
			x: fields.int(-1e4, 1e4),
			y: fields.int(-1e4, 1e4),
			units: fields.orElse(fields.record(fields.orElse(fields.int(0, 1e9), 0)), {}),
			cargo: fields.orElse(fields.record(fields.orElse(fields.number(0, 1e15), 0)), {}),
			mission: fields.optional(fields.id()),
		});
		/** A pool as a live placeholder value: now, its net rate and its cap (the client counts on). */
		const livePool = async (api: EngineApi, holder: string, r: string) => ({
			amount: Math.max(0, (await resources.amounts(api, holder))[r] ?? 0),
			rate: (await resources.rates(api, holder))[r] ?? 0,
			at: api.now,
			cap: await resources.capacity(api, holder),
		});
		const service: ArmiesService = {
			addEncounter: (h) => void encounters.push(h),
			addIncoming: (s) => void incomingSources.push(s),
			addSpeedModifier: (m) => void speedModifiers.push(m),
			addPaceModifier: (m) => void paceModifiers.push(m),
			addSendOption(o) {
				sendOptions.push(o);
			},
			onReturn: (l) => void returnListeners.push(l),
			onArrive: (l) => void arriveListeners.push(l),
			defineMission(m) {
				if (missions.has(m.id)) throw new PluginError(`Mission "${m.id}" defined twice`);
				// Its name is a key of the plugin defining it.
				missions.set(m.id, { ...m, name: ctx.services.get('i18n').own(m.name) } as Mission);
			},
			missionName: (id) => missions.get(id)?.name ?? `${ctx.pluginId}.${id}`,

			parseOrder(raw, mission) {
				const p = orderShape(raw);
				const positive = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
				const units = positive(p.units);
				if (!Object.keys(units).length) throw fail('bad_payload', 'Send at least one unit');
				// The raw payload goes along: missions and send options read their own fields from it.
				const all = (raw ?? {}) as Record<string, unknown>;
				const m = mission ?? p.mission ?? 'attack';
				return { from: p.from, tile: { x: map.wrap(p.x), y: map.wrap(p.y) }, units, cargo: positive(p.cargo), mission: m, raw: all };
			},

			async dispatch(api, { from, tile, units, cargo, mission: missionId, raw }) {
				const mission = missions.get(missionId);
				if (!mission) throw fail('bad_payload', text('Unknown mission "{0}"', { 0: missionId }));
				const s = await settlements.requireOwned(api, from);
				const garrison = await troops.garrison(api, s.id);
				for (const [u, n] of Object.entries(units)) {
					if (!troops.get(u)) throw fail('bad_payload', text('Unknown unit "{0}"', { 0: u }));
					if ((garrison.get(u) ?? 0) < n) throw fail('not_enough_units', text('Not enough {0}', { 0: keyText(troops.get(u)!.name) }));
				}
				const distance = map.distance({ x: s.x, y: s.y }, tile);
				if (distance === 0) throw fail('bad_target', 'Pick a tile away from the settlement');
				const target: MissionTarget = { from: s, tile, occupant: (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null };
				const reason = await mission.check(api, target);
				if (reason) throw fail('bad_target', reason);
				await touchTarget(api, target.occupant);
				const { value, cost = {} } = mission.parse ? await mission.parse(api, raw, target) : { value: {} };

				for (const r of Object.keys(cargo))
					if (!resources.list().some((x) => x.id === r)) throw fail('bad_payload', text('Unknown resource "{0}"', { 0: r }));
				const load = Object.values(cargo).reduce((a, b) => a + b, 0);
				if (load > 0 && !mission.cargo) throw fail('bad_payload', text('{0} cannot carry supplies', { 0: keyText(mission.name) }));
				const carry = carryOf(api, units) * (await cargoFactor(api));
				if (load > carry) throw fail('over_capacity', text('These units can carry at most {0} supplies', { 0: Math.floor(carry) }));

				const pace = await paceOf(api, units);
				// To one's own settlement: faster, with no shortest time; shorter than that, no timeline event (see the top).
				const own = await ownSettlement(api, target.occupant);
				const travel = Math.ceil(((distance / pace) * 3600) / (speed.get(api) * (own ? ownSpeed.get(api) : 1)));
				const seconds = Math.max(1, own ? 0 : minSeconds.get(api), travel);
				const instant = !!own && seconds < minSeconds.get(api);
				// Settled now: what the arrival reads there, read at once (not one read after another as it comes to them).
				if (instant) settlements.preload(api, [own.id]);
				const options: Record<string, unknown> = {};
				for (const o of optionsFor(missionId)) {
					const v = await o.parse(api, raw, { from: s.id, units });
					if (v !== undefined) options[o.key] = v;
				}
				// Upkeep for the whole way there and back, the supplies and the mission's cost, all up
				// front; spending never goes below zero.
				const provisions = provisionsFor(api, units, 2 * seconds);
				// One check for all of it, then each part for what it is (only the mission's cost is "spent").
				const holder = settlements.entity(s.id);
				if (!(await resources.canAfford(api, holder, addCost(provisions, cargo, cost))))
					throw fail('insufficient_resources', 'Not enough resources');
				await resources.spend(api, holder, provisions, 'upkeep');
				await resources.spend(api, holder, cargo, 'transfer');
				await resources.spend(api, holder, cost);
				for (const [u, n] of Object.entries(units)) await troops.adjust(api, s.id, u, -n);
				const id = crypto.randomUUID();
				const arrivesAt = api.now + seconds * 1000;
				const row: Row = {
					id,
					player_id: api.playerId,
					from_settlement: s.id,
					target_x: tile.x,
					target_y: tile.y,
					phase: 'outbound',
					units: JSON.stringify(units),
					loot: '{}',
					report: null,
					departed_at: api.now,
					arrives_at: arrivesAt,
					returns_at: arrivesAt + seconds * 1000,
					provisions: JSON.stringify(provisions),
					options: JSON.stringify(options),
					mission: missionId,
					mission_data: JSON.stringify({ value, cost }),
					cargo: JSON.stringify(cargo),
					...(instant ? { staged: { to: own.id, effects: [] } } : {}),
				};
				if (instant) {
					// Settled at once: there (and back) in this commit, nothing stored; the browser plays the trip out.
					for (const o of optionsFor(missionId)) if (o.key in options) await o.onSend?.(api, options[o.key], { id, from: s.id });
					const sent = toInfo(row);
					await arrive(api, row, api.now);
					const oneWay = row.phase === 'done';
					await returnHome(api, row);
					// Kept for this request's views (`armies.staged`): the command's answer carries it.
					const staged = await api.memo('armies:staged', async (): Promise<StagedMarch[]> => [], { current: true });
					staged.push({
						...sent,
						...(oneWay ? { returnsAt: sent.arrivesAt } : {}),
						loot: JSON.parse(row.loot),
						staged: true,
						fromName: settlements.nameText(s),
						effects: row.staged!.effects,
					});
					return id;
				}
				api.write(
					api.db
						.prepare(
							`INSERT INTO armies_marches (id, player_id, from_settlement, target_x, target_y, phase, units, departed_at, arrives_at, returns_at, provisions, options, mission, mission_data, cargo)
							 VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.bind(
							id,
							row.player_id,
							row.from_settlement,
							row.target_x,
							row.target_y,
							row.units,
							row.departed_at,
							row.arrives_at,
							row.returns_at,
							row.provisions,
							row.options,
							row.mission,
							row.mission_data,
							row.cargo,
						),
				);
				// Known in this call from now on (the player's list, if read already, and the row itself).
				await api.memo(`armies:row:${id}`, async (): Promise<Row | null> => row);
				(await api.peek<Row[]>(`armies:of:${api.playerId}`))?.push(row);
				for (const o of optionsFor(missionId)) if (o.key in options) await o.onSend?.(api, options[o.key], { id, from: s.id });
				timeline.schedule(api, entity(id), arrivesAt, ARRIVE, { id });
				return id;
			},

			async sendForm(api, params, missionId, { exclude } = {}) {
				if (params.x === undefined || params.y === undefined) return false;
				const origins: FormOption[] = [];
				const available = new Map<string, number>();
				const garrisons = new Map<string, Map<string, number>>();
				for (const s of await settlements.mine(api, api.playerId)) {
					if (s.id === exclude) continue;
					const g = await troops.garrison(api, s.id);
					const total = [...g.values()].reduce((a, b) => a + b, 0);
					if (!total) continue;
					origins.push({ value: s.id, label: settlements.nameText(s), count: total });
					garrisons.set(s.id, g);
					for (const [u, n] of g) available.set(u, (available.get(u) ?? 0) + n);
				}
				if (!origins.length) return false;
				const selected = params.settlement && origins.some((o) => o.value === params.settlement) ? params.settlement : origins[0].value;
				// What the flat `armies.send` reads, ready for the origin picked (another one goes the regular way).
				const origin = await settlements.get(api, selected);
				if (origin) {
					await troops.flat.prepare(api, origin);
					await resources.rates(api, settlements.entity(origin.id));
				}
				await marchOf(api);
				const number = (name: string, label: UiText) => ({ name, label, type: 'number' as const, min: 0, default: 0 });
				const units = troops.list().filter((d) => available.get(d.id));
				const cargo = missions.get(missionId)?.cargo ?? false;
				const factor = cargo ? await cargoFactor(api) : 1;
				// Every box says its "at most" for the origin picked (user 2026-10-19: the found form showed none; every form
				// sending troops gets them here, once): troops from that garrison, supplies from that stock, counted on by
				// the client from one read. Data: worded in the browser (src/shared/forms.ts, web/plugins/armies/forms.ts).
				const atMost = text('At most {0}');
				const unitField = (d: UnitDef): FormField => ({
					...number(`units.${d.id}`, keyText(d.name)),
					atMostBy: { field: 'from', values: Object.fromEntries([...garrisons].map(([id, g]) => [id, g.get(d.id) ?? 0])) },
				});
				const cargoField = async (r: { id: string; name: string }): Promise<FormField> => {
					const values: Record<string, { amount: number; rate: number; at: number; cap?: number }> = {};
					for (const id of garrisons.keys()) values[id] = await livePool(api, settlements.entity(id), r.id);
					return {
						...number(`cargo.${r.id}`, keyText(r.name)),
						placeholderLive: { by: 'from', text: atMost, values },
					};
				};
				return {
					// The supplies' boxes are labelled in the browser.
					...(cargo ? { data: { 'armies.supplies': {} } } : {}),
					defaults: { from: selected, x: Number(params.x), y: Number(params.y) },
					options: { from: origins },
					// One count per unit type the player has anywhere; the chosen settlement must have them.
					fields: [
						...(optionsFor(missionId).some((o) => o.choosesUnits) ? [] : units.map(unitField)),
						...(cargo ? await Promise.all(resources.list().map(cargoField)) : []),
						...(await Promise.all(optionsFor(missionId).map((o) => o.fields?.(api, params) ?? []))).flat(),
					],
					// Supplies: at most what the chosen units carry.
					budgets: cargo
						? [
								{
									label: text('Supplies'),
									use: resources.list().map((r) => `cargo.${r.id}`),
									capacity: Object.fromEntries(units.map((d) => [`units.${d.id}`, troops.stats(api, d.id).carry * factor])),
								},
							]
						: [],
				};
			},
		};
		ctx.services.provide('armies', service);

		/* ----- built-in missions ------------------------------------------------------- */

		const ownSettlement = async (api: ReadApi, occupant: string | null) => {
			const id = settlementAt(occupant);
			const s = id ? await settlements.get(api, id) : null;
			return s && s.ownerId === api.playerId ? s : null;
		};

		service.defineMission({
			id: 'attack',
			name: 'mission:attack',
			battle: true,
			async check(api, { occupant }) {
				return (await ownSettlement(api, occupant)) ? text('That is your own settlement: transfer troops there instead') : null;
			},
			async arrive(api, encounter) {
				for (const handle of encounters) {
					const report = await handle(api, encounter);
					if (report) return { report };
				}
				return { report: noBattle({ kind: encounter.occupant ? encounter.occupant.split(':')[0] : 'empty' }) };
			},
		});

		service.defineMission({
			id: 'transfer',
			name: 'mission:transfer',
			cargo: true,
			async check(api, { from, occupant }) {
				const to = await ownSettlement(api, occupant);
				if (!to) return text('Troops can only be transferred to your own settlements');
				return to.id === from.id ? text('Pick another settlement') : null;
			},
			async arrive(api, { army, occupant }) {
				const id = settlementAt(occupant);
				const to = id ? await settlements.get(api, id) : null;
				// Lost on the way (e.g. abandoned): everything comes back.
				if (!to || to.ownerId !== army.playerId) return { report: noBattle({ kind: 'empty' }, text('The settlement is gone')) };
				const station = settlements.kind(to.kind).garrison;
				return {
					report: noBattle({ kind: to.kind, name: to.name }, text(station ? 'Stationed' : 'Supplies delivered')),
					deliverTo: to.id,
					station,
				};
			},
		});

		/**
		 * What an army fetches where it arrives: what was asked for, as far as the stock and its carry go (scaled down
		 * when over); `fill`: as much as it carries, in the asked proportions (the stock's when none), each resource
		 * at most what is there.
		 */
		function fetchLoad(stock: Cost, pickup: Cost, fill: boolean, carry: number): Cost {
			const have = (r: string) => Math.max(0, stock[r] ?? 0);
			if (!fill) {
				const asked = Object.fromEntries(Object.entries(pickup).map(([r, n]) => [r, Math.min(n, have(r))]));
				const total = Object.values(asked).reduce((a, b) => a + b, 0);
				const scale = total > carry ? carry / total : 1;
				return Object.fromEntries(Object.entries(asked).map(([r, n]) => [r, Math.floor(n * scale)]));
			}
			const weights = Object.keys(pickup).length ? pickup : Object.fromEntries(Object.keys(stock).map((r) => [r, have(r)]));
			// Fill in proportion; a resource that runs out leaves its share to the others (water filling).
			const out: Cost = {};
			let left = carry;
			let open = Object.keys(weights).filter((r) => weights[r] > 0 && have(r) > 0);
			while (open.length && left > 0) {
				const w = open.reduce((a, r) => a + weights[r], 0);
				const short = open.filter((r) => have(r) - (out[r] ?? 0) <= (left * weights[r]) / w);
				if (!short.length) {
					for (const r of open) out[r] = (out[r] ?? 0) + (left * weights[r]) / w;
					break;
				}
				for (const r of short) {
					left -= have(r) - (out[r] ?? 0);
					out[r] = have(r);
				}
				open = open.filter((r) => !short.includes(r));
			}
			return Object.fromEntries(Object.entries(out).map(([r, n]) => [r, Math.floor(n)]));
		}

		// Both ways in one trip (user 2026-10-05: "运送资源/运回资源 合并为一个类型，以便往返可以分别指定，不空跑"): the
		// supplies are unloaded there, then what is asked for is loaded for the way back. Armies sent before (value
		// { direction }) arrive as they were sent: "to" only unloads, "back" only fetches (nothing asked: all it carries).
		service.defineMission<{ pickup: Cost; fill?: boolean; direction?: 'to' | 'back' }>({
			id: 'transport',
			name: 'mission:transport',
			cargo: true,
			async check(api, { from, occupant }) {
				const to = await ownSettlement(api, occupant);
				if (!to) return text('Resources can only be transported between your own settlements');
				return to.id === from.id ? text('Pick another settlement') : null;
			},
			async parse(_api, raw) {
				const { pickup: asked, fill } = transportFields(raw);
				const pickup: Cost = Object.fromEntries(Object.entries(asked).filter(([, n]) => n > 0));
				return { value: { pickup, fill } };
			},
			async arrive(api, { army, occupant, value, carry }) {
				const id = settlementAt(occupant);
				const to = id ? await settlements.get(api, id) : null;
				if (!to || to.ownerId !== army.playerId) return { report: noBattle({ kind: 'empty' }, text('The settlement is gone')) };
				const unloads = value.direction !== 'back';
				const fill = value.direction === 'back' ? !Object.keys(value.pickup).length : !!value.fill;
				const wants = value.direction !== 'to' && (fill || Object.keys(value.pickup).length > 0);
				const target = { kind: to.kind, name: to.name };
				if (!wants) return { report: noBattle(target, text('Supplies delivered')), deliverTo: to.id };
				const holder = settlements.entity(to.id);
				const taken: Cost = {};
				for (const [r, n] of Object.entries(fetchLoad(await resources.amounts(api, holder), value.pickup, fill, carry))) {
					if (n <= 0) continue;
					taken[r] = n;
					await resources.add(api, holder, r, -n);
				}
				return {
					report: {
						...noBattle(target, unloads ? text('Supplies delivered, resources picked up') : text('Resources picked up')),
						loot: taken,
					},
					...(unloads ? { deliverTo: to.id } : {}),
				};
			},
		});

		/* ----- arrival and return ------------------------------------------------------- */

		/** The army reaches its target at `at`. Runs in the timeline (the army's or, for a short march, a settlement's). */
		async function arrive(api: EngineApi, row: Row, at: number) {
			if (row.phase !== 'outbound') return;
			const units = JSON.parse(row.units) as Record<string, number>;
			const tile = { x: row.target_x, y: row.target_y };
			const occupant = (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null;
			const data = JSON.parse(row.mission_data ?? '{}') as { value?: unknown; cost?: Cost };
			const cargo = JSON.parse(row.cargo ?? '{}') as Cost;
			const cost = data.cost ?? {};
			const mission = missions.get(row.mission ?? 'attack');
			if (!mission) throw new PluginError(`No mission "${row.mission}" (plugin disabled?)`);
			const outcome = await mission.arrive(api, {
				army: { id: row.id, playerId: row.player_id, from: row.from_settlement, units, options: JSON.parse(row.options ?? '{}') },
				tile,
				occupant,
				carry: carryOf(api, units),
				at,
				value: data.value,
				cost,
				cargo,
			});
			const { report } = outcome;
			// The mission's cost comes back with the army (below); it no longer counts as spent.
			if (outcome.refund && Object.keys(cost).length) await resources.refunded(api, settlements.entity(row.from_settlement), cost);
			const survivors: Record<string, number> = {};
			for (const [u, n] of Object.entries(units)) survivors[u] = Math.max(0, n - (report.losses.attacker[u] ?? 0));
			for (const [u, n] of Object.entries(report.captured)) survivors[u] = (survivors[u] ?? 0) + n;
			for (const p of report.promoted?.attacker ?? []) {
				survivors[p.from] = Math.max(0, (survivors[p.from] ?? 0) - p.count);
				survivors[p.to] = (survivors[p.to] ?? 0) + p.count;
			}
			const deliverTo = outcome.deliverTo ? await settlements.get(api, outcome.deliverTo) : null;
			if (deliverTo && deliverTo.ownerId !== row.player_id)
				throw new PluginError(`Mission "${row.mission}" delivered to a foreign settlement`);
			if (deliverTo)
				for (const [r, n] of Object.entries(cargo)) if (n > 0) await resources.add(api, settlements.entity(deliverTo.id), r, n);
			// Staged: what was taken there (a transport's pickup) and delivered shows from the arrival on.
			const staged = row.staged;
			if (staged) {
				const moved: Cost = { ...(deliverTo ? cargo : {}) };
				for (const [r, n] of Object.entries(report.loot)) moved[r] = (moved[r] ?? 0) - n;
				staged.effects.push({ settlement: staged.to, at: row.arrives_at, units: {}, resources: moved });
			}
			for (const l of arriveListeners)
				await l(api, {
					army: { id: row.id, playerId: row.player_id, from: row.from_settlement, mission: mission.id, units },
					tile,
					at,
					report,
					cargo,
					deliverTo: deliverTo?.id ?? null,
					station: !!(deliverTo && outcome.station),
				});

			if (deliverTo && outcome.station) {
				// The trip ends here: units join the garrison, with what they carried and the unused
				// half of the provisions.
				const total = row.returns_at - row.departed_at;
				const unused = total > 0 ? (row.returns_at - row.arrives_at) / total : 0;
				const provisions = JSON.parse(row.provisions ?? '{}') as Cost;
				const kept = addCost(
					report.loot,
					outcome.refund ? cost : {},
					Object.fromEntries(Object.entries(provisions).map(([r, n]) => [r, n * unused])),
				);
				for (const [u, n] of Object.entries(survivors)) if (n > 0) await troops.adjust(api, deliverTo.id, u, n);
				for (const [r, n] of Object.entries(kept)) await resources.add(api, settlements.entity(deliverTo.id), r, n);
				staged?.effects.push({ settlement: deliverTo.id, at: row.arrives_at, units: survivors, resources: kept });
				if (!staged) api.write(api.db.prepare('DELETE FROM armies_marches WHERE id = ?').bind(row.id));
				row.phase = 'done';
				for (const l of returnListeners) await l(api, { id: row.id, playerId: row.player_id, from: row.from_settlement, at: deliverTo.id });
				return;
			}

			row.phase = 'returning';
			row.units = JSON.stringify(survivors);
			row.loot = JSON.stringify(addCost(report.loot, deliverTo ? {} : cargo, outcome.refund ? cost : {}));
			row.report = JSON.stringify(report);
			if (staged) return;
			api.write(
				api.db
					.prepare("UPDATE armies_marches SET phase = 'returning', units = ?, loot = ?, report = ? WHERE id = ?")
					.bind(row.units, row.loot, row.report, row.id),
			);
			timeline.schedule(api, entity(row.id), row.returns_at, RETURN, { id: row.id });
		}

		/** The army is back home. Runs in the timeline. */
		async function returnHome(api: EngineApi, row: Row) {
			if (row.phase !== 'returning') return;
			const home = await settlements.get(api, row.from_settlement);
			if (home && home.ownerId === row.player_id) {
				for (const [u, n] of Object.entries(JSON.parse(row.units) as Record<string, number>))
					if (n > 0) await troops.adjust(api, home.id, u, n);
				for (const [r, n] of Object.entries(JSON.parse(row.loot) as Record<string, number>))
					if (n > 0) await resources.add(api, settlements.entity(home.id), r, n);
				row.staged?.effects.push({
					settlement: home.id,
					at: row.returns_at,
					units: JSON.parse(row.units),
					resources: JSON.parse(row.loot),
				});
			}
			if (!row.staged) api.write(api.db.prepare('DELETE FROM armies_marches WHERE id = ?').bind(row.id));
			row.phase = 'done';
			for (const l of returnListeners)
				await l(api, { id: row.id, playerId: row.player_id, from: row.from_settlement, at: row.from_settlement });
		}

		timeline.on<{ id: string }>(ARRIVE, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (row) await arrive(api, row, event.dueAt);
		});
		timeline.on<{ id: string }>(RETURN, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (row) await returnHome(api, row);
		});

		/* ----- commands ----------------------------------------------------------------- */

		/** What sending reads first (a command's `preload`): the origin's economy, the target tile and what stands there. */
		const preloadOrder = (api: EngineApi, order: SendOrder) => {
			settlements.preload(api, [order.from]);
			const { x, y } = order.tile;
			void map
				.occupants(api, [order.tile])
				.then((occupants) => {
					const id = settlementAt(occupants.get(`${x},${y}`) ?? null);
					if (id) void settlements.get(api, id).catch(() => {});
				})
				.catch(() => {});
		};

		/**
		 * The common attack on the fast path (`Command.flat`): troops (no supplies, no heroes) against what is not a
		 * settlement, e.g. a camp: what `dispatch` does, from one batch of reads. Anything else goes the regular way.
		 */
		const flatAttack: FlatCommand<SendOrder> = {
			derived: (p, f) => [
				resources.flat.derived(settlements.entity(p.from)),
				troops.flat.derived(p.from),
				{ key: `armies:march:${f.playerId}`, salt: '0' },
				...optionsFor(p.mission).flatMap((o) => o.flat?.derived?.(f, p) ?? []),
			],
			reads: (p, f) => ({
				...Object.fromEntries(
					optionsFor(p.mission).flatMap((o, i) => Object.entries(o.flat?.reads?.(f, p) ?? {}).map(([k, st]) => [`opt${i}:${k}`, st])),
				),
				...settlements.flatReads(f, p.from),
				// Anything of the player's due first (an arrival, a construction...): the regular path.
				due: f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE player = ? AND due_at <= ?').bind(f.playerId, f.now),
				garrison: troops.flat.reads(f, p.from),
				tile: map.flatStored(f, p.tile, { owner: settlements.ownerSql('entity') }),
				...resources.flat.reads(f, settlements.entity(p.from), f.playerId, 'pool:'),
			}),
			async run(f) {
				const { payload: p, rows } = f;
				if (p.mission !== 'attack' || Object.keys(p.cargo).length) return null;
				const s = settlements.flatSettlement(rows.row, rows.districts);
				if (!s || s.ownerId !== f.playerId || (rows.due[0] as { n: number }).n > 0) return null;
				// A player's settlement there (their own, someone else's): the regular path checks and locks. Camps (stored with
				// no owner, or worked out) are fine.
				if ((rows.tile as { owner: string | null }[]).some((r) => r.owner !== null)) return null;
				const distance = map.distance({ x: s.x, y: s.y }, p.tile);
				if (distance === 0) return null;
				const id = crypto.randomUUID();
				const options: Record<string, unknown> = {};
				const optionWrites: D1PreparedStatement[] = [];
				for (const [i, o] of optionsFor(p.mission).entries()) {
					if (!o.flat) return null;
					const mine = Object.fromEntries(
						Object.entries(rows)
							.filter(([k]) => k.startsWith(`opt${i}:`))
							.map(([k, v]) => [k.slice(`opt${i}:`.length), v]),
					);
					let parsed: ReturnType<SendOptionFlat['run']> = null;
					try {
						parsed = o.flat.run(f, { raw: p.raw, from: s.id, units: p.units, army: id, rows: mine, derived: f.derived });
					} catch {
						return null;
					}
					if (!parsed) return null;
					if (parsed.value !== undefined) options[o.key] = parsed.value;
					optionWrites.push(...(parsed.writes ?? []));
				}
				// As `paceOf`, from the stored speeds; a pace modifier that reads goes the regular way.
				const speeds = f.derived[`armies:march:${f.playerId}`] as Record<string, number>;
				const api = f as unknown as ReadApi;
				let slowest = Infinity;
				for (const [u, n] of Object.entries(p.units)) {
					if (!n || !troops.get(u)) continue;
					if (!(u in speeds)) return null;
					slowest = Math.min(slowest, speeds[u]);
				}
				if (!Number.isFinite(slowest) || slowest <= 0) return null;
				let pace = slowest;
				for (const m of paceModifiers) {
					let v: number | null;
					try {
						v = await m(api, p.units, (u) => (p.units[u] ? (speeds[u] ?? 0) : 0));
					} catch {
						return null;
					}
					if (v !== null && v > pace) pace = v;
				}
				const travel = Math.ceil(((distance / pace) * 3600) / speed.get(f));
				const seconds = Math.max(1, minSeconds.get(f), travel);
				const provisions = provisionsFor(api, p.units, 2 * seconds);
				const left = troops.flat.leave(f, rows.garrison, s.id, p.units, f.derived[troops.flat.derived(s.id).key]);
				if (!left) return null;
				const holder = settlements.entity(s.id);
				const spent = resources.flat.spend(
					f,
					holder,
					f.playerId,
					'pool:',
					{ rows, numbers: f.derived[resources.flat.derived(holder).key] },
					[
						{ cost: provisions, purpose: 'upkeep' },
						{ cost: {}, purpose: 'transfer' },
						{ cost: {}, purpose: 'spend' },
					],
					{ consumer: left.consumer },
				);
				if (!spent) return null;
				const arrivesAt = f.now + seconds * 1000;
				return [
					...spent,
					...left.writes,
					...optionWrites,
					f.db
						.prepare(
							`INSERT INTO armies_marches (id, player_id, from_settlement, target_x, target_y, phase, units, departed_at, arrives_at, returns_at, provisions, options, mission, mission_data, cargo)
							 VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.bind(
							id,
							f.playerId,
							s.id,
							p.tile.x,
							p.tile.y,
							JSON.stringify(p.units),
							f.now,
							arrivesAt,
							arrivesAt + seconds * 1000,
							JSON.stringify(provisions),
							JSON.stringify(options),
							p.mission,
							JSON.stringify({ value: {}, cost: {} }),
							JSON.stringify(p.cargo),
						),
					timeline.flatSchedule(f, entity(id), arrivesAt, ARRIVE, { id }, f.playerId),
				];
			},
		};

		const sendFields: FormField[] = [
			{ name: 'from', label: text('From'), type: 'select', required: true },
			{ name: 'x', label: text('x'), type: 'hidden' },
			{ name: 'y', label: text('y'), type: 'hidden' },
		];

		ctx.commands.add<SendOrder>({
			type: 'armies.send',
			description:
				'Send units from a settlement to a tile. Payload: { "from": "<settlement>", "x": 1, "y": 2, "units": { "infantry-1": 10 }, "mission"?: "attack" | "transfer" | ..., "cargo"?: { "food": 100 } }',
			form: {
				title: text('Attack'),
				placement: 'tile',
				fields: sendFields,
				submitLabel: text('March'),
				async prepare(api, params) {
					// Empty land has its own missions (e.g. founding a settlement); own settlements get transfers.
					if (params.x === undefined || params.y === undefined) return false;
					const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
					const occupant = (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null;
					if (!occupant || (await ownSettlement(api, occupant))) return false;
					return service.sendForm(api, params, 'attack');
				},
			},
			parse: (raw) => service.parseOrder(raw),
			preload: preloadOrder,
			flat: flatAttack,
			execute: async (api, order) => void (await service.dispatch(api, order)),
		});

		ctx.commands.add<SendOrder>({
			type: 'armies.transfer',
			description: 'Move units (and supplies) to another of your settlements. Payload as armies.send, without "mission".',
			form: {
				title: text('Transfer troops here'),
				description: text('The troops stay here if it can hold a garrison; otherwise they unload the supplies and go back.'),
				placement: 'tile',
				fields: sendFields,
				submitLabel: text('Transfer'),
				async prepare(api, params) {
					if (params.x === undefined || params.y === undefined) return false;
					const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
					const to = await ownSettlement(api, (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null);
					if (!to) return false;
					// Send from the selected settlement, or the first other one with troops.
					return service.sendForm(api, params.settlement === to.id ? { ...params, settlement: '' } : params, 'transfer', {
						exclude: to.id,
					});
				},
			},
			parse: (raw) => service.parseOrder(raw, 'transfer'),
			preload: preloadOrder,
			execute: async (api, order) => void (await service.dispatch(api, order)),
		});

		/** Own settlement on the selected tile, for the transport forms. */
		const ownAt = async (api: EngineApi, params: ViewParams) => {
			if (params.x === undefined || params.y === undefined) return null;
			const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
			return ownSettlement(api, (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null);
		};
		ctx.commands.add<SendOrder>({
			type: 'armies.transport',
			description:
				'Carry resources to another of your settlements and fetch some back in one trip. Payload as armies.send with "cargo" (to take there), "pickup": { "food": 1000 } (to bring back) and "fill": true (bring back as much as they carry, in the pickup proportions, or the stock\'s when none), without "mission".',
			form: {
				title: text('Transport'),
				description: text(
					"Supplies are unloaded there; then the troops load what you ask for and bring it back. Tick the box to fill up: as much as they carry, in the proportions given (or the stock's, when none).",
				),
				placement: 'tile',
				fields: sendFields,
				submitLabel: text('Transport'),
				async prepare(api, params) {
					const to = await ownAt(api, params);
					if (!to) return false;
					const form = await service.sendForm(api, params.settlement === to.id ? { ...params, settlement: '' } : params, 'transport', {
						exclude: to.id,
					});
					if (!form) return false;
					// The way back: each box's "at most" is the destination's stock (the origin's is the send form's, as for
					// every form sending troops), counted on by the client from one read here (user 2026-10-05: "只在创建表单时
					// 读取一次数据库，前端演算保证实时性").
					const there = settlements.entity(to.id);
					const atMost = text('At most {0}');
					const fields: FormField[] = [...form.fields];
					// (Labelled "<resource> (to fetch)" in the browser, as the supplies.)
					for (const f of form.fields.filter((x) => x.name.startsWith('cargo.'))) {
						const r = f.name.slice(6);
						fields.push({
							...f,
							name: `pickup.${r}`,
							label: f.label,
							placeholderLive: { text: atMost, values: { '': await livePool(api, there, r) } },
						});
					}
					fields.push({ name: 'fill', label: text('Fill up: as much as they carry, in these proportions'), type: 'checkbox' });
					const budgets = [
						...form.budgets,
						...form.budgets.map((b) => ({ ...b, label: text('To fetch'), use: b.use.map((u) => u.replace(/^cargo\./, 'pickup.')) })),
					];
					return { ...form, fields, budgets };
				},
			},
			parse: (raw) => service.parseOrder(raw, 'transport'),
			preload: preloadOrder,
			execute: async (api, order) => void (await service.dispatch(api, order)),
		});

		// Gathering the realm in one go (user 2026-10-17, changelog 267): late core buildings need the stock of every
		// settlement, and a transport form for each of twenty or thirty would be a chore. The troops are split evenly (the
		// stocks are not read here: that would cost queries per settlement); each party fills up when it arrives.
		ctx.commands.add<{ settlement: string; units: Record<string, number> }>({
			type: 'armies.gather',
			description: `Fetch resources from your other settlements (the nearest ${GATHER_MAX}) here in one go: the units given are split evenly over them, each party loads as much as it carries and comes back. Payload: { "settlement", "units": { "infantry-2": 1000 } }`,
			form: {
				title: text('Gather resources here'),
				description: text(
					'The troops are split evenly over your other settlements (the nearest {0}); each party loads as much as it carries, in proportion to the stock there, and brings it back.',
					{ 0: GATHER_MAX },
				),
				placement: 'settlement',
				fields: [{ name: 'settlement', label: text('settlement'), type: 'hidden' }],
				submitLabel: text('Gather'),
				async prepare(api, params) {
					const s = await settlements.resolve(api, params);
					if (!s || !settlements.kind(s.kind).garrison) return false;
					if (!(await settlements.mine(api, api.playerId)).some((t) => t.id !== s.id)) return false;
					const here = [...(await troops.garrison(api, s.id))].filter(([u, n]) => n > 0 && troops.stats(api, u).carry > 0);
					if (!here.length) return false;
					return {
						defaults: { settlement: s.id },
						fields: here.map(([u, n]) => ({
							name: `units.${u}`,
							label: keyText(troops.get(u)!.name),
							count: n,
							type: 'number' as const,
							min: 0,
							max: n,
							default: 0,
						})),
					};
				},
			},
			parse: shape({
				settlement: fields.id(),
				units: fields.orElse(fields.record(fields.orElse(fields.int(0, 1e9), 0)), {}),
			}),
			preload: (api, { settlement }) => {
				// The list first: it has the settlement's row too.
				void settlements.mine(api, api.playerId).catch(() => {});
				settlements.preload(api, [settlement]);
			},
			async execute(api, { settlement, units }) {
				const s = await settlements.requireOwned(api, settlement);
				const sending = Object.entries(units).filter(([, n]) => n > 0);
				if (!sending.length) throw fail('bad_payload', 'Send at least one unit');
				const garrison = await troops.garrison(api, s.id);
				for (const [u, n] of sending) {
					if (!troops.get(u)) throw fail('bad_payload', text('Unknown unit "{0}"', { 0: u }));
					if ((garrison.get(u) ?? 0) < n) throw fail('not_enough_units', text('Not enough {0}', { 0: keyText(troops.get(u)!.name) }));
				}
				const total = sending.reduce((a, [, n]) => a + n, 0);
				const targets = (await settlements.mine(api, api.playerId))
					.filter((t) => t.id !== s.id)
					.sort((a, b) => map.distance(s, a) - map.distance(s, b))
					.slice(0, Math.min(GATHER_MAX, total));
				if (!targets.length) throw fail('bad_target', 'You have no other settlement to fetch from');
				// One read for all their tiles: each send below finds its own there.
				await map.occupants(
					api,
					targets.map((t) => ({ x: t.x, y: t.y })),
				);
				for (const [i, t] of targets.entries()) {
					const share: Record<string, number> = {};
					for (const [u, n] of sending) {
						const k = Math.floor(n / targets.length) + (i < n % targets.length ? 1 : 0);
						if (k > 0) share[u] = k;
					}
					if (!Object.keys(share).length) continue;
					await service.dispatch(api, {
						from: s.id,
						tile: { x: t.x, y: t.y },
						units: share,
						cargo: {},
						mission: 'transport',
						raw: { fill: true },
					});
				}
			},
		});

		ctx.commands.add<{ id: string }>({
			type: 'armies.recall',
			description: 'Turn an army back before it arrives. Payload: { "id": "<army>" }',
			parse: shape({ id: fields.id() }),
			async execute(api, { id }) {
				await timeline.sync(api, entity(id));
				const row = await load(api, id);
				if (!row || row.player_id !== api.playerId || row.phase === 'done') throw fail('not_found', 'No such army', 404);
				if (row.phase !== 'outbound') throw fail('bad_state', 'The army is already on its way back');
				await touchTarget(api, await occupantAt(api, row.target_x, row.target_y));
				// Back the same way: the trip home takes as long as the way out so far.
				const out = api.now - row.departed_at;
				const total = row.returns_at - row.departed_at;
				const unused = total > 0 ? Math.max(0, 1 - (2 * out) / total) : 0;
				// The unused provisions, the supplies and the mission's cost travel back with the army
				// and are stored when it gets home.
				const carried = addCost(
					Object.fromEntries(Object.entries(JSON.parse(row.provisions ?? '{}') as Record<string, number>).map(([r, n]) => [r, n * unused])),
					JSON.parse(row.cargo ?? '{}'),
					(JSON.parse(row.mission_data ?? '{}') as { cost?: Cost }).cost ?? {},
				);
				timeline.cancelWhere(api, entity(id), ARRIVE, { id });
				row.phase = 'returning';
				row.arrives_at = api.now;
				row.returns_at = api.now + out;
				row.loot = JSON.stringify(carried);
				api.write(
					api.db
						.prepare("UPDATE armies_marches SET phase = 'returning', arrives_at = ?, returns_at = ?, loot = ? WHERE id = ?")
						.bind(row.arrives_at, row.returns_at, row.loot, id),
				);
				timeline.schedule(api, entity(id), row.returns_at, RETURN, { id });
			},
		});

		// Views only process due events in memory. The client runs this when an army's time is up,
		// so the arrival (its battle, mail...) is committed at once instead of at the next sweep.
		ctx.commands.add<null>({
			type: 'armies.sync',
			description: 'Commit the due arrivals and returns of your armies now. No payload.',
			parse: () => null,
			async execute(api) {
				const due = (await marchesOf(api, api.playerId)).filter(
					(r) => (r.phase === 'outbound' && r.arrives_at <= api.now) || (r.phase === 'returning' && r.returns_at <= api.now),
				);
				for (const r of due) await timeline.sync(api, entity(r.id));
			},
		});

		ctx.commands.add<{ id: string; seconds: number }>({
			type: 'armies.hasten',
			privileged: true,
			description:
				'Shorten the current leg of an army (to its target, or back home) by `seconds`; 0 = finish it now. The rest of the trip keeps its length. Payload: { "id": "<army>", "seconds": 600 }',
			form: {
				title: text('Speed up a march'),
				placement: 'gm',
				fields: [
					{ name: 'id', label: text('Army'), type: 'select', required: true },
					{ name: 'minutes', label: text('Minutes to skip (0 = arrive now)'), type: 'number', min: 0, default: 0 },
				],
				submitLabel: text('Speed up'),
				async prepare(api) {
					const { results } = await api.db
						.prepare(
							'SELECT id, target_x, target_y, phase, arrives_at, returns_at FROM armies_marches WHERE player_id = ? ORDER BY departed_at',
						)
						.bind(api.playerId)
						.all<Pick<Row, 'id' | 'target_x' | 'target_y' | 'phase' | 'arrives_at' | 'returns_at'>>();
					const live = results.filter((r) => (r.phase === 'outbound' ? r.arrives_at : r.returns_at) > api.now);
					if (!live.length) return false;
					const minutesLeft = (r: (typeof live)[number]) =>
						Math.ceil(((r.phase === 'outbound' ? r.arrives_at : r.returns_at) - api.now) / 60_000);
					// Worded by the browser (web/plugins/armies/forms.ts).
					const marches: ArmiesHastenFormData = live.map((r) => ({
						id: r.id,
						x: r.target_x,
						y: r.target_y,
						outbound: r.phase === 'outbound',
						minutes: minutesLeft(r),
					}));
					return { data: { 'armies.hasten': marches } };
				},
			},
			// Seconds through the API, minutes from the GM form; 0 = arrive now.
			parse: shape(
				{ id: fields.id(), seconds: fields.optional(fields.number(0, 1e9)), minutes: fields.optional(fields.number(0, 1e7)) },
				(p) => ({ id: p.id, seconds: p.seconds ?? (p.minutes ?? 0) * 60 }),
			),
			async execute(api, { id, seconds }) {
				// Process anything already due, so the leg being shortened is the current one.
				await timeline.sync(api, entity(id));
				const row = await load(api, id);
				if (!row || row.player_id !== api.playerId || row.phase === 'done') throw fail('not_found', 'No such army', 404);
				const outbound = row.phase === 'outbound';
				const due = outbound ? row.arrives_at : row.returns_at;
				if (due <= api.now) throw fail('bad_state', 'The army has already arrived');
				if (outbound) await touchTarget(api, await occupantAt(api, row.target_x, row.target_y));
				const at = seconds > 0 ? Math.max(api.now, due - seconds * 1000) : api.now;
				const cut = due - at;
				row.arrives_at = outbound ? at : row.arrives_at;
				row.returns_at -= cut;
				api.write(
					api.db.prepare('UPDATE armies_marches SET arrives_at = ?, returns_at = ? WHERE id = ?').bind(row.arrives_at, row.returns_at, id),
				);
				timeline.cancelWhere(api, entity(id), outbound ? ARRIVE : RETURN, { id });
				timeline.schedule(api, entity(id), at, outbound ? ARRIVE : RETURN, { id });
				// A leg ending now happens in this commit: the battle, its report, the units home.
				await timeline.sync(api, entity(id));
			},
		});

		/** Armies on their way to the player's settlements (the Army page's alerts). */
		async function incomingOf(api: EngineApi): Promise<IncomingArmy[]> {
			{
				// Every tile of every settlement the player owns, mapped back to the settlement.
				const tiles = new Map<string, string>();
				for (const s of await settlements.mine(api, api.playerId)) for (const d of s.districts) tiles.set(`${d.x},${d.y}`, s.id);
				if (!tiles.size) return [];
				const coords = [...tiles.keys()].map((k) => k.split(',').map(Number));
				const scouting = await stats.get(api, 'armies.scouting', `player:${api.playerId}`);
				// "About": one significant figure, so scouts give a feel for the size, not a count.
				const about = (n: number) => (n < 10 ? n : Number(n.toPrecision(1)));
				const intel = (units: Record<string, number>): IncomingArmy['intel'] => {
					if (scouting <= 0) return undefined;
					const total = Object.values(units).reduce((a, b) => a + b, 0);
					if (scouting === 1) return { level: 1, total: about(total) };
					const shown = Object.fromEntries(Object.entries(units).map(([u, n]) => [u, scouting >= 3 ? n : about(n)]));
					return { level: Math.min(3, scouting), total: scouting >= 3 ? total : about(total), units: shown };
				};
				const out: (IncomingArmy & { playerId: string })[] = [];
				for (let i = 0; i < coords.length; i += 40) {
					const chunk = coords.slice(i, i + 40);
					const { results } = await api.db
						.prepare(
							`SELECT id, player_id, target_x, target_y, arrives_at, units FROM armies_marches
							 WHERE phase = 'outbound' AND mission = 'attack' AND player_id != ? AND arrives_at > ? AND (${chunk.map(() => '(target_x = ? AND target_y = ?)').join(' OR ')})`,
						)
						.bind(api.playerId, api.now, ...chunk.flat())
						.all<{ id: string; player_id: string; target_x: number; target_y: number; arrives_at: number; units: string }>();
					for (const r of results) {
						out.push({
							id: r.id,
							playerId: r.player_id,
							settlement: tiles.get(`${r.target_x},${r.target_y}`)!,
							arrivesAt: r.arrives_at,
							attackerName: null,
							...(scouting > 0 ? { intel: intel(JSON.parse(r.units)) } : {}),
						});
					}
				}
				const names = await ctx.services.get('accounts').usernames(api.db, [...new Set(out.map((x) => x.playerId))]);
				const marches: IncomingArmy[] = out.map(({ playerId, ...x }) => ({
					...x,
					attackerName: names[playerId] ? literal(names[playerId]) : null,
				}));
				for (const source of incomingSources)
					for (const x of await source(api, api.playerId))
						if (x.arrivesAt > api.now)
							marches.push({
								id: x.id,
								settlement: x.settlement,
								arrivesAt: x.arrivesAt,
								attackerName: x.attackerName,
								...(scouting > 0 ? { intel: intel(x.units) } : {}),
							});
				return marches.sort((a, b) => a.arrivesAt - b.arrivesAt);
			}
		}

		const placeName = async (api: ReadApi, id: string): Promise<UiText> => {
			const s = await settlements.get(api, id);
			return s ? settlements.nameText(s) : literal(id);
		};
		async function listOf(api: EngineApi): Promise<ArmyMarch[]> {
			{
				const rows = [...(await marchesOf(api, api.playerId))];
				timeline.preload(
					api,
					rows.map((r) => entity(r.id)),
				);
				const out: ArmyMarch[] = [];
				for (const row of rows) {
					await timeline.sync(api, entity(row.id));
					// Returned armies are deleted by the return event (in dry-run, check the time).
					if (row.phase !== 'done' && !(row.phase === 'returning' && row.returns_at <= api.now)) {
						const info = toInfo(row);
						out.push({
							...info,
							fromName: await placeName(api, info.from),
							...(info.report ? { reportTarget: settlements.labelOf(info.report.target) } : {}),
						});
					}
				}
				return out;
			}
		}
		// The player's marches (the Army page's `armies.marches` is assembled from it in the browser): changed by their
		// commits (arrivals are committed by `armies.sync` when the time is up).
		ctx.views.add({ id: 'armies.list', quiet: true, stamp: playerStamp, compute: (api) => listOf(api) });
		// The short marches to own settlements the command of this request settled (none in other requests): no query.
		ctx.views.add({
			id: 'armies.staged',
			compute: async (api): Promise<StagedMarch[]> => (await api.peek<StagedMarch[]>('armies:staged')) ?? [],
		});
		// Attacks on the player, with the name of the settlement each is heading for (the Army page's alerts,
		// `armies.alerts`, are assembled from it in the browser): changed only by commits that lock them (a march to them,
		// recalled or sped up; its battle).
		ctx.views.add({
			id: 'armies.incoming',
			quiet: true,
			stamp: playerStamp,
			compute: async (api): Promise<IncomingAttack[]> =>
				Promise.all((await incomingOf(api)).map(async (a) => ({ ...a, place: await placeName(api, a.settlement) }))),
		});
		// Mission names by id, for the marches shown in the browser.
		ctx.meta.add('armyMissions', () => Object.fromEntries([...missions.values()].map((m) => [m.id, m.name])));

		// When the client should wake, on any page (generic `ui.sync`), for what is not its own timeline's (`timeline.due`
		// wakes it for its armies' arrivals and returns): others' attacks coming in. The times as read, nothing worked out
		// (user 2026-10-24: "闹钟只需要'下一个时间点'，可以直接查表转发"). Changed only by commits touching the player (a
		// march on them locks them).
		ctx.views.add({
			id: 'armies.due',
			// Stale times are skipped by the widget (only those still ahead).
			quiet: true,
			flat: {
				tables: ['armies_marches', 'settlements_settlements', 'settlements_districts'],
				reads: (f) => ({
					at: f.db
						.prepare(
							`SELECT arrives_at AS at FROM armies_marches WHERE phase = 'outbound' AND mission = 'attack' AND player_id != ? AND arrives_at > ?
							 AND (target_x, target_y) IN (SELECT x, y FROM ${settlements.tilesSql})`,
						)
						.bind(f.playerId, f.now, f.playerId),
				}),
				build: ({ rows }): SyncData => ({ items: rows.at as { at: number }[] }),
			},
			async compute(api): Promise<SyncData> {
				const tiles = (await settlements.mine(api, api.playerId)).flatMap((s) => s.districts.map((d) => [d.x, d.y]));
				const items: SyncData['items'] = [];
				for (let i = 0; i < tiles.length; i += 40) {
					const chunk = tiles.slice(i, i + 40);
					const { results } = await api.db
						.prepare(
							`SELECT arrives_at AS at FROM armies_marches WHERE phase = 'outbound' AND mission = 'attack' AND player_id != ? AND arrives_at > ?
							 AND (${chunk.map(() => '(target_x = ? AND target_y = ?)').join(' OR ')})`,
						)
						.bind(api.playerId, api.now, ...chunk.flat())
						.all<{ at: number }>();
					items.push(...results);
				}
				return { items };
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.band({ band: 'top', widget: 'ui.sync', props: { view: 'armies.due' } });
		ui.page({ id: 'armies', label: 'Army', order: 7 });
		ui.block({ page: 'armies', column: 'right', widget: 'ui.timers', props: { view: 'armies.alerts' } });
		ui.block({ page: 'armies', column: 'right', widget: 'ui.timers', order: 1, props: { view: 'armies.marches' } });
	},
});
