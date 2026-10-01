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
 * Every march has a mission (`defineMission`): what it is for, which targets suit it and
 * what happens on arrival. Built in:
 *   - "attack": any target but the player's own settlements. What happens there is not decided
 *     here: plugins register encounter handlers (`addEncounter`) — raiding NPC camps, attacking
 *     players... The first handler that returns a report wins; with none, the army looks around.
 *   - "transfer": to another of the player's settlements, with supplies. The units stay there
 *     if it can hold a garrison; otherwise they unload and come back.
 * Other plugins add more (e.g. founding a settlement). A mission may carry supplies (`cargo`,
 * at most what the units can carry) and have a departure cost; both travel with the army and
 * come back home if it is recalled or the mission does not unload them.
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange, PluginError, type ReadApi } from '../../kernel';
import type { FormPatch, ViewParams } from '../../kernel';
import type { ArmyInfo, BattleReport, FormField, IncomingArmy } from '../../shared/api';
import type { Cost } from '../resources';
import type { Settlement } from '../settlements';
import type { Tile } from '../world-map';
import rulesCsv from './data/rules.csv?raw';

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
	/** Why the target does not suit this mission, or null. Must only read. */
	check(api: EngineApi, target: MissionTarget): Promise<string | null>;
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

export interface ArmiesService {
	addEncounter(handler: EncounterHandler): void;
	onArrive(listener: ArriveListener): void;
	addSendOption(option: SendOption): void;
	onReturn(listener: ReturnListener): void;
	defineMission<V>(mission: Mission<V>): void;
	/** Validate an untrusted send payload (shape only; `dispatch` checks it against the game). */
	parseOrder(raw: unknown, mission?: string): SendOrder;
	/** Send an army of the acting player. Returns its id. */
	dispatch(api: EngineApi, order: SendOrder): Promise<string>;
	/**
	 * The generic parts of a send form for `mission` at tile `params.x/y`: origin, unit counts,
	 * supplies and the send options' fields. False when the player has no troops to send.
	 */
	sendForm(
		api: EngineApi,
		params: ViewParams,
		mission: string,
		options?: { exclude?: string },
	): Promise<false | Required<Pick<FormPatch, 'defaults' | 'options' | 'fields' | 'budgets'>>>;
}

declare module '../../kernel' {
	interface ServiceMap {
		armies: ArmiesService;
	}
}

const ARRIVE = 'armies.arrive';
const RETURN = 'armies.return';

interface Row {
	id: string;
	player_id: string;
	from_settlement: string;
	target_x: number;
	target_y: number;
	phase: 'outbound' | 'returning';
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
	dependsOn: ['troops', 'settlements', 'world-map', 'timeline', 'resources', 'accounts'],
	setup(ctx) {
		const troops = ctx.services.get('troops');
		const settlements = ctx.services.get('settlements');
		const map = ctx.services.get('worldMap');
		const timeline = ctx.services.get('timeline');
		const resources = ctx.services.get('resources');
		const encounters: EncounterHandler[] = [];
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
		/** Upkeep of `units` for `seconds`, by resource. */
		const provisionsFor = (api: ReadApi, units: Record<string, number>, seconds: number) => {
			const out: Record<string, number> = {};
			for (const [u, n] of Object.entries(units))
				for (const [r, perSec] of Object.entries(troops.stats(api, u).upkeep)) out[r] = (out[r] ?? 0) + perSec * n * seconds;
			return out;
		};

		const entity = (id: string) => `army:${id}`;
		timeline.addOwnerResolver(
			'army',
			async (db, id) =>
				(await db.prepare('SELECT player_id FROM armies_marches WHERE id = ?').bind(id).first<{ player_id: string }>())?.player_id ?? null,
		);

		const load = (api: EngineApi, id: string) =>
			api.memo(
				`armies:row:${id}`,
				async () => (await api.db.prepare('SELECT * FROM armies_marches WHERE id = ?').bind(id).first<Row>()) ?? null,
			);
		const toInfo = (r: Row): ArmyInfo => ({
			id: r.id,
			from: r.from_settlement,
			target: { x: r.target_x, y: r.target_y },
			mission: r.mission ?? 'attack',
			phase: r.phase,
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
		const missions = new Map<string, Mission>();
		const optionsFor = (mission: string) => sendOptions.filter((o) => !o.missions || o.missions.includes(mission));
		const settlementAt = (occupant: string | null) => (occupant?.startsWith('settlement:') ? occupant.slice('settlement:'.length) : null);
		const noBattle = (target: BattleReport['target'], note?: string): BattleReport => ({
			target,
			outcome: 'no-battle',
			...(note ? { note } : {}),
			attack: 0,
			defense: 0,
			losses: { attacker: {}, defender: {} },
			loot: {},
			captured: {},
		});

		const service: ArmiesService = {
			addEncounter: (h) => void encounters.push(h),
			addSendOption: (o) => void sendOptions.push(o),
			onReturn: (l) => void returnListeners.push(l),
			onArrive: (l) => void arriveListeners.push(l),
			defineMission(m) {
				if (missions.has(m.id)) throw new PluginError(`Mission "${m.id}" defined twice`);
				missions.set(m.id, m as Mission);
			},

			parseOrder(raw, mission) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.from !== 'string') throw new GameError('bad_payload', 'from is required');
				const x = Number(p.x);
				const y = Number(p.y);
				if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'x and y must be integers');
				// Forms send flat "units.<id>" / "cargo.<id>" fields; the API takes nested objects.
				const counts = (prefix: string, integer: boolean) => {
					const nested = { ...((p[prefix] ?? {}) as Record<string, unknown>) };
					for (const [k, v] of Object.entries(p)) if (k.startsWith(`${prefix}.`)) nested[k.slice(prefix.length + 1)] = v;
					const out: Record<string, number> = {};
					for (const [id, n] of Object.entries(nested)) {
						const c = Number(n);
						if (!Number.isFinite(c) || c < 0 || (integer && !Number.isInteger(c)))
							throw new GameError('bad_payload', `${prefix}.${id} must be a non-negative ${integer ? 'integer' : 'number'}`);
						if (c > 0) out[id] = c;
					}
					return out;
				};
				const units = counts('units', true);
				if (!Object.keys(units).length) throw new GameError('bad_payload', 'Send at least one unit');
				const m = mission ?? (p.mission === undefined ? 'attack' : p.mission);
				if (typeof m !== 'string') throw new GameError('bad_payload', 'mission must be a string');
				return { from: p.from, tile: { x: map.wrap(x), y: map.wrap(y) }, units, cargo: counts('cargo', false), mission: m, raw: p };
			},

			async dispatch(api, { from, tile, units, cargo, mission: missionId, raw }) {
				const mission = missions.get(missionId);
				if (!mission) throw new GameError('bad_payload', `Unknown mission "${missionId}"`);
				const s = await settlements.requireOwned(api, from);
				const garrison = await troops.garrison(api, s.id);
				for (const [u, n] of Object.entries(units)) {
					if (!troops.get(u)) throw new GameError('bad_payload', `Unknown unit "${u}"`);
					if ((garrison.get(u) ?? 0) < n) throw new GameError('not_enough_units', `Not enough ${troops.get(u)!.name}`);
				}
				const distance = map.distance({ x: s.x, y: s.y }, tile);
				if (distance === 0) throw new GameError('bad_target', 'Pick a tile away from the settlement');
				const target: MissionTarget = { from: s, tile, occupant: (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null };
				const reason = await mission.check(api, target);
				if (reason) throw new GameError('bad_target', reason);
				const { value, cost = {} } = mission.parse ? await mission.parse(api, raw, target) : { value: {} };

				for (const r of Object.keys(cargo))
					if (!resources.list().some((x) => x.id === r)) throw new GameError('bad_payload', `Unknown resource "${r}"`);
				const load = Object.values(cargo).reduce((a, b) => a + b, 0);
				if (load > 0 && !mission.cargo) throw new GameError('bad_payload', `${mission.name} cannot carry supplies`);
				const carry = carryOf(api, units);
				if (load > carry) throw new GameError('over_capacity', `These units can carry at most ${Math.floor(carry)} supplies`);

				const pace = troops.totals(api, units).speed;
				const seconds = Math.max(1, minSeconds.get(api), Math.ceil(((distance / pace) * 3600) / speed.get(api)));
				const options: Record<string, unknown> = {};
				for (const o of optionsFor(missionId)) {
					const v = await o.parse(api, raw, { from: s.id, units });
					if (v !== undefined) options[o.key] = v;
				}
				// Upkeep for the whole way there and back, the supplies and the mission's cost, all up
				// front; spending never goes below zero.
				const provisions = provisionsFor(api, units, 2 * seconds);
				await resources.spend(api, settlements.entity(s.id), addCost(provisions, cargo, cost));
				for (const [u, n] of Object.entries(units)) await troops.adjust(api, s.id, u, -n);
				const id = crypto.randomUUID();
				const arrivesAt = api.now + seconds * 1000;
				api.write(
					api.db
						.prepare(
							`INSERT INTO armies_marches (id, player_id, from_settlement, target_x, target_y, phase, units, departed_at, arrives_at, returns_at, provisions, options, mission, mission_data, cargo)
							 VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.bind(
							id,
							api.playerId,
							s.id,
							tile.x,
							tile.y,
							JSON.stringify(units),
							api.now,
							arrivesAt,
							arrivesAt + seconds * 1000,
							JSON.stringify(provisions),
							JSON.stringify(options),
							missionId,
							JSON.stringify({ value, cost }),
							JSON.stringify(cargo),
						),
				);
				for (const o of optionsFor(missionId)) if (o.key in options) await o.onSend?.(api, options[o.key], { id, from: s.id });
				timeline.schedule(api, entity(id), arrivesAt, ARRIVE, { id });
				return id;
			},

			async sendForm(api, params, missionId, { exclude } = {}) {
				if (params.x === undefined || params.y === undefined) return false;
				const origins: { value: string; label: string }[] = [];
				const available = new Map<string, number>();
				for (const s of await settlements.mine(api, api.playerId)) {
					if (s.id === exclude) continue;
					const g = await troops.garrison(api, s.id);
					const total = [...g.values()].reduce((a, b) => a + b, 0);
					if (!total) continue;
					origins.push({ value: s.id, label: `${s.name} (${total})` });
					for (const [u, n] of g) available.set(u, (available.get(u) ?? 0) + n);
				}
				if (!origins.length) return false;
				const selected = params.settlement && origins.some((o) => o.value === params.settlement) ? params.settlement : origins[0].value;
				const number = (name: string, label: string) => ({ name, label, type: 'number' as const, min: 0, default: 0 });
				const units = troops.list().filter((d) => available.get(d.id));
				const cargo = missions.get(missionId)?.cargo ?? false;
				return {
					defaults: { from: selected, x: Number(params.x), y: Number(params.y) },
					options: { from: origins },
					// One count per unit type the player has anywhere; the chosen settlement must have them.
					fields: [
						...(optionsFor(missionId).some((o) => o.choosesUnits) ? [] : units.map((d) => number(`units.${d.id}`, d.name))),
						...(cargo ? resources.list().map((r) => number(`cargo.${r.id}`, `${r.name} (supplies)`)) : []),
						...(await Promise.all(optionsFor(missionId).map((o) => o.fields?.(api, params) ?? []))).flat(),
					],
					// Supplies: at most what the chosen units carry.
					budgets: cargo
						? [
								{
									label: 'Supplies',
									use: resources.list().map((r) => `cargo.${r.id}`),
									capacity: Object.fromEntries(units.map((d) => [`units.${d.id}`, troops.stats(api, d.id).carry])),
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
			name: 'Attack',
			async check(api, { occupant }) {
				return (await ownSettlement(api, occupant)) ? 'That is your own settlement: transfer troops there instead' : null;
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
			name: 'Transfer',
			cargo: true,
			async check(api, { from, occupant }) {
				const to = await ownSettlement(api, occupant);
				if (!to) return 'Troops can only be transferred to your own settlements';
				return to.id === from.id ? 'Pick another settlement' : null;
			},
			async arrive(api, { army, occupant }) {
				const id = settlementAt(occupant);
				const to = id ? await settlements.get(api, id) : null;
				// Lost on the way (e.g. abandoned): everything comes back.
				if (!to || to.ownerId !== army.playerId) return { report: noBattle({ kind: 'empty' }, 'The settlement is gone') };
				const station = settlements.kind(to.kind).garrison;
				return {
					report: noBattle({ kind: to.kind, name: to.name }, station ? 'Stationed' : 'Supplies delivered'),
					deliverTo: to.id,
					station,
				};
			},
		});

		/* ----- arrival and return ------------------------------------------------------- */

		timeline.on<{ id: string }>(ARRIVE, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (!row) return;
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
				at: event.dueAt,
				value: data.value,
				cost,
				cargo,
			});
			const { report } = outcome;
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
			for (const l of arriveListeners)
				await l(api, {
					army: { id: row.id, playerId: row.player_id, from: row.from_settlement, mission: mission.id, units },
					tile,
					at: event.dueAt,
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
				api.write(api.db.prepare('DELETE FROM armies_marches WHERE id = ?').bind(row.id));
				for (const l of returnListeners) await l(api, { id: row.id, playerId: row.player_id, from: row.from_settlement, at: deliverTo.id });
				return;
			}

			row.phase = 'returning';
			row.units = JSON.stringify(survivors);
			row.loot = JSON.stringify(addCost(report.loot, deliverTo ? {} : cargo, outcome.refund ? cost : {}));
			row.report = JSON.stringify(report);
			api.write(
				api.db
					.prepare("UPDATE armies_marches SET phase = 'returning', units = ?, loot = ?, report = ? WHERE id = ?")
					.bind(row.units, row.loot, row.report, row.id),
			);
			timeline.schedule(api, entity(row.id), row.returns_at, RETURN, { id: row.id });
		});

		timeline.on<{ id: string }>(RETURN, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (!row) return;
			const home = await settlements.get(api, row.from_settlement);
			if (home && home.ownerId === row.player_id) {
				for (const [u, n] of Object.entries(JSON.parse(row.units) as Record<string, number>))
					if (n > 0) await troops.adjust(api, home.id, u, n);
				for (const [r, n] of Object.entries(JSON.parse(row.loot) as Record<string, number>))
					if (n > 0) await resources.add(api, settlements.entity(home.id), r, n);
			}
			api.write(api.db.prepare('DELETE FROM armies_marches WHERE id = ?').bind(row.id));
			for (const l of returnListeners)
				await l(api, { id: row.id, playerId: row.player_id, from: row.from_settlement, at: row.from_settlement });
		});

		/* ----- commands ----------------------------------------------------------------- */

		const sendFields: FormField[] = [
			{ name: 'from', label: 'From', type: 'select', required: true },
			{ name: 'x', label: 'x', type: 'hidden' },
			{ name: 'y', label: 'y', type: 'hidden' },
		];

		ctx.commands.add<SendOrder>({
			type: 'armies.send',
			description:
				'Send units from a settlement to a tile. Payload: { "from": "<settlement>", "x": 1, "y": 2, "units": { "infantry-1": 10 }, "mission"?: "attack" | "transfer" | ..., "cargo"?: { "food": 100 } }',
			form: {
				title: 'Attack',
				placement: 'tile',
				fields: sendFields,
				submitLabel: 'March',
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
			execute: async (api, order) => void (await service.dispatch(api, order)),
		});

		ctx.commands.add<SendOrder>({
			type: 'armies.transfer',
			description: 'Move units (and supplies) to another of your settlements. Payload as armies.send, without "mission".',
			form: {
				title: 'Transfer troops here',
				description: 'The troops stay here if it can hold a garrison; otherwise they unload the supplies and go back.',
				placement: 'tile',
				fields: sendFields,
				submitLabel: 'Transfer',
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
			execute: async (api, order) => void (await service.dispatch(api, order)),
		});

		ctx.commands.add<{ id: string }>({
			type: 'armies.recall',
			description: 'Turn an army back before it arrives. Payload: { "id": "<army>" }',
			parse(raw) {
				const id = (raw as { id?: unknown } | null)?.id;
				if (typeof id !== 'string') throw new GameError('bad_payload', 'id is required');
				return { id };
			},
			async execute(api, { id }) {
				await timeline.sync(api, entity(id));
				const row = await load(api, id);
				if (!row || row.player_id !== api.playerId) throw new GameError('not_found', 'No such army', 404);
				if (row.phase !== 'outbound') throw new GameError('bad_state', 'The army is already on its way back');
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
				const { results } = await api.db
					.prepare(
						`SELECT id FROM armies_marches WHERE player_id = ?
						 AND ((phase = 'outbound' AND arrives_at <= ?) OR (phase = 'returning' AND returns_at <= ?))`,
					)
					.bind(api.playerId, api.now, api.now)
					.all<{ id: string }>();
				for (const { id } of results) await timeline.sync(api, entity(id));
			},
		});

		ctx.commands.add<{ id: string; seconds: number }>({
			type: 'armies.hasten',
			privileged: true,
			description:
				'Shorten the current leg of an army (to its target, or back home) by `seconds`; 0 = finish it now. The rest of the trip keeps its length. Payload: { "id": "<army>", "seconds": 600 }',
			form: {
				title: 'Speed up a march',
				placement: 'gm',
				fields: [
					{ name: 'id', label: 'Army', type: 'select', required: true },
					{ name: 'minutes', label: 'Minutes to skip (0 = arrive now)', type: 'number', min: 0, default: 0 },
				],
				submitLabel: 'Speed up',
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
					return {
						options: {
							id: live.map((r) => ({
								value: r.id,
								label: `(${r.target_x}, ${r.target_y}) · ${r.phase === 'outbound' ? 'Outbound' : 'Returning'} · ${minutesLeft(r)} min`,
							})),
						},
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.id !== 'string') throw new GameError('bad_payload', 'id is required');
				const seconds = p.seconds !== undefined ? p.seconds : Number(p.minutes ?? 0) * 60;
				return { id: p.id, seconds: numberInRange(0, 1e9)(Number(seconds)) };
			},
			async execute(api, { id, seconds }) {
				// Process anything already due, so the leg being shortened is the current one.
				await timeline.sync(api, entity(id));
				const row = await load(api, id);
				if (!row || row.player_id !== api.playerId) throw new GameError('not_found', 'No such army', 404);
				const outbound = row.phase === 'outbound';
				const due = outbound ? row.arrives_at : row.returns_at;
				if (due <= api.now) throw new GameError('bad_state', 'The army has already arrived');
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

		ctx.views.add({
			id: 'armies.incoming',
			async compute(api): Promise<IncomingArmy[]> {
				// Every tile of every settlement the player owns, mapped back to the settlement.
				const tiles = new Map<string, string>();
				for (const s of await settlements.mine(api, api.playerId)) for (const d of s.districts) tiles.set(`${d.x},${d.y}`, s.id);
				if (!tiles.size) return [];
				const coords = [...tiles.keys()].map((k) => k.split(',').map(Number));
				const out: (IncomingArmy & { playerId: string })[] = [];
				for (let i = 0; i < coords.length; i += 40) {
					const chunk = coords.slice(i, i + 40);
					const { results } = await api.db
						.prepare(
							`SELECT id, player_id, target_x, target_y, arrives_at FROM armies_marches
							 WHERE phase = 'outbound' AND mission = 'attack' AND player_id != ? AND arrives_at > ? AND (${chunk.map(() => '(target_x = ? AND target_y = ?)').join(' OR ')})`,
						)
						.bind(api.playerId, api.now, ...chunk.flat())
						.all<{ id: string; player_id: string; target_x: number; target_y: number; arrives_at: number }>();
					for (const r of results) {
						out.push({
							id: r.id,
							playerId: r.player_id,
							settlement: tiles.get(`${r.target_x},${r.target_y}`)!,
							arrivesAt: r.arrives_at,
							attackerName: null,
						});
					}
				}
				const names = await ctx.services.get('accounts').usernames(api.db, [...new Set(out.map((x) => x.playerId))]);
				return out.sort((a, b) => a.arrivesAt - b.arrivesAt).map(({ playerId, ...x }) => ({ ...x, attackerName: names[playerId] ?? null }));
			},
		});

		ctx.views.add({
			id: 'armies.list',
			async compute(api): Promise<ArmyInfo[]> {
				const { results } = await api.db
					.prepare('SELECT id FROM armies_marches WHERE player_id = ? ORDER BY departed_at')
					.bind(api.playerId)
					.all<{ id: string }>();
				const out: ArmyInfo[] = [];
				for (const { id } of results) {
					await timeline.sync(api, entity(id));
					const row = await load(api, id);
					// Returned armies are deleted by the return event (in dry-run, check the time).
					if (row && !(row.phase === 'returning' && row.returns_at <= api.now)) out.push(toInfo(row));
				}
				return out;
			},
		});
	},
});
