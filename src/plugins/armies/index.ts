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
 * What happens at the target is not decided here: plugins register encounter handlers
 * (`addEncounter`) — raiding NPC camps, attacking players, and later scouting, settling...
 * The first handler that returns a report wins; with none, the army just looks around.
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange, type ReadApi } from '../../kernel';
import type { ArmyInfo, BattleReport, FormField, IncomingArmy } from '../../shared/api';
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

/**
 * Extra orders another plugin attaches to a march (e.g. a battle formation). The armies
 * plugin only stores the parsed value and hands it to encounter handlers.
 */
export interface SendOption {
	key: string;
	/** Fields added to the send form (`params` as for form `prepare`). */
	fields?(api: EngineApi, params: Record<string, string>): Promise<FormField[]>;
	/** Validate the order from the raw send payload (API or form); undefined = none. Throw `GameError` if invalid. */
	parse(api: EngineApi, raw: Record<string, unknown>, send: { from: string; units: Record<string, number> }): Promise<unknown>;
	/** Once the army exists (same commit): side effects of the order, e.g. putting heroes at its head. */
	onSend?(api: EngineApi, value: unknown, army: { id: string; from: string }): Promise<void>;
}

/** An army that has come home (its units and loot are back). Runs in the timeline. */
export type ReturnListener = (api: EngineApi, army: { id: string; playerId: string; from: string }) => Promise<void>;

export interface ArmiesService {
	addEncounter(handler: EncounterHandler): void;
	addSendOption(option: SendOption): void;
	onReturn(listener: ReturnListener): void;
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
}

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
			phase: r.phase,
			units: JSON.parse(r.units),
			loot: JSON.parse(r.loot),
			provisions: JSON.parse(r.provisions ?? '{}'),
			report: r.report ? JSON.parse(r.report) : null,
			departedAt: r.departed_at,
			arrivesAt: r.arrives_at,
			returnsAt: r.returns_at,
		});
		const carryOf = (api: ReadApi, units: Record<string, number>) => troops.totals(api, units).carry;

		const service: ArmiesService = {
			addEncounter: (h) => void encounters.push(h),
			addSendOption: (o) => void sendOptions.push(o),
			onReturn: (l) => void returnListeners.push(l),
		};
		ctx.services.provide('armies', service);

		timeline.on<{ id: string }>(ARRIVE, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (!row) return;
			const units = JSON.parse(row.units) as Record<string, number>;
			const tile = { x: row.target_x, y: row.target_y };
			const occupant = (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null;
			const encounter: Encounter = {
				army: { id: row.id, playerId: row.player_id, from: row.from_settlement, units, options: JSON.parse(row.options ?? '{}') },
				tile,
				occupant,
				carry: carryOf(api, units),
				at: event.dueAt,
			};
			let report: BattleReport | null = null;
			for (const handle of encounters) {
				report = await handle(api, encounter);
				if (report) break;
			}
			report ??= {
				target: { kind: occupant ? occupant.split(':')[0] : 'empty' },
				outcome: 'no-battle',
				attack: 0,
				defense: 0,
				losses: { attacker: {}, defender: {} },
				loot: {},
				captured: {},
			};
			const survivors: Record<string, number> = {};
			for (const [u, n] of Object.entries(units)) survivors[u] = Math.max(0, n - (report.losses.attacker[u] ?? 0));
			for (const [u, n] of Object.entries(report.captured)) survivors[u] = (survivors[u] ?? 0) + n;
			for (const p of report.promoted?.attacker ?? []) {
				survivors[p.from] = Math.max(0, (survivors[p.from] ?? 0) - p.count);
				survivors[p.to] = (survivors[p.to] ?? 0) + p.count;
			}
			row.phase = 'returning';
			row.units = JSON.stringify(survivors);
			row.loot = JSON.stringify(report.loot);
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
			for (const l of returnListeners) await l(api, { id: row.id, playerId: row.player_id, from: row.from_settlement });
		});

		ctx.commands.add<{ from: string; tile: Tile; units: Record<string, number>; raw: Record<string, unknown> }>({
			type: 'armies.send',
			description:
				'Send units from a settlement to a tile. Payload: { "from": "<settlement>", "x": 1, "y": 2, "units": { "militia": 10 } }',
			form: {
				title: 'Send troops here',
				placement: 'tile',
				fields: [
					{ name: 'from', label: 'From', type: 'select', required: true },
					{ name: 'x', label: 'x', type: 'hidden' },
					{ name: 'y', label: 'y', type: 'hidden' },
				],
				submitLabel: 'March',
				async prepare(api, params) {
					if (params.x === undefined || params.y === undefined) return false;
					const origins: { value: string; label: string }[] = [];
					const available = new Map<string, number>();
					for (const s of await settlements.mine(api, api.playerId)) {
						const g = await troops.garrison(api, s.id);
						const total = [...g.values()].reduce((a, b) => a + b, 0);
						if (!total) continue;
						origins.push({ value: s.id, label: `${s.name} (${total})` });
						for (const [u, n] of g) available.set(u, (available.get(u) ?? 0) + n);
					}
					if (!origins.length) return false;
					const selected = params.settlement && origins.some((o) => o.value === params.settlement) ? params.settlement : origins[0].value;
					return {
						defaults: { from: selected, x: Number(params.x), y: Number(params.y) },
						options: { from: origins },
						// One count per unit type the player has anywhere; the chosen settlement must have them.
						fields: [
							...troops
								.list()
								.filter((d) => available.get(d.id))
								.map((d) => ({ name: `units.${d.id}`, label: d.name, type: 'number' as const, min: 0, default: 0 })),
							...(await Promise.all(sendOptions.map((o) => o.fields?.(api, params) ?? []))).flat(),
						],
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.from !== 'string') throw new GameError('bad_payload', 'from is required');
				const x = Number(p.x);
				const y = Number(p.y);
				if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'x and y must be integers');
				const units: Record<string, number> = {};
				// Forms send flat "units.<id>" fields; the API takes a nested object.
				const nested = { ...((p.units ?? {}) as Record<string, unknown>) };
				for (const [k, v] of Object.entries(p)) if (k.startsWith('units.')) nested[k.slice(6)] = v;
				for (const [u, n] of Object.entries(nested)) {
					const c = Number(n);
					if (!Number.isInteger(c) || c < 0) throw new GameError('bad_payload', `units.${u} must be a non-negative integer`);
					if (c > 0) units[u] = c;
				}
				if (!Object.keys(units).length) throw new GameError('bad_payload', 'Send at least one unit');
				return { from: p.from, tile: { x: map.wrap(x), y: map.wrap(y) }, units, raw: p };
			},
			async execute(api, { from, tile, units, raw }) {
				const s = await settlements.requireOwned(api, from);
				const garrison = await troops.garrison(api, s.id);

				for (const [u, n] of Object.entries(units)) {
					if (!troops.get(u)) throw new GameError('bad_payload', `Unknown unit "${u}"`);
					if ((garrison.get(u) ?? 0) < n) throw new GameError('not_enough_units', `Not enough ${troops.get(u)!.name}`);
				}
				const pace = troops.totals(api, units).speed;
				const distance = map.distance({ x: s.x, y: s.y }, tile);
				if (distance === 0) throw new GameError('bad_target', 'Pick a tile away from the settlement');
				const seconds = Math.max(1, minSeconds.get(api), Math.ceil(((distance / pace) * 3600) / speed.get(api)));
				const options: Record<string, unknown> = {};
				for (const o of sendOptions) {
					const value = await o.parse(api, raw, { from: s.id, units });
					if (value !== undefined) options[o.key] = value;
				}
				// Upkeep for the whole way there and back, up front; spending never goes below zero.
				const provisions = provisionsFor(api, units, 2 * seconds);
				await resources.spend(api, settlements.entity(s.id), provisions);
				for (const [u, n] of Object.entries(units)) await troops.adjust(api, s.id, u, -n);
				const id = crypto.randomUUID();
				const arrivesAt = api.now + seconds * 1000;
				api.write(
					api.db
						.prepare(
							`INSERT INTO armies_marches (id, player_id, from_settlement, target_x, target_y, phase, units, departed_at, arrives_at, returns_at, provisions, options)
							 VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
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
						),
				);
				for (const o of sendOptions) if (o.key in options) await o.onSend?.(api, options[o.key], { id, from: s.id });
				timeline.schedule(api, entity(id), arrivesAt, ARRIVE, { id });
			},
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
				// The unused provisions travel back with the army and are stored when it gets home.
				const carried = Object.fromEntries(
					Object.entries(JSON.parse(row.provisions ?? '{}') as Record<string, number>)
						.map(([r, n]) => [r, n * unused])
						.filter(([, n]) => (n as number) > 0),
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
						.prepare('SELECT id, target_x, target_y, phase, arrives_at, returns_at FROM armies_marches WHERE player_id = ? ORDER BY departed_at')
						.bind(api.playerId)
						.all<Pick<Row, 'id' | 'target_x' | 'target_y' | 'phase' | 'arrives_at' | 'returns_at'>>();
					const live = results.filter((r) => (r.phase === 'outbound' ? r.arrives_at : r.returns_at) > api.now);
					if (!live.length) return false;
					const minutesLeft = (r: (typeof live)[number]) => Math.ceil(((r.phase === 'outbound' ? r.arrives_at : r.returns_at) - api.now) / 60_000);
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
				api.write(api.db.prepare('UPDATE armies_marches SET arrives_at = ?, returns_at = ? WHERE id = ?').bind(row.arrives_at, row.returns_at, id));
				// A leg ending "now" is processed on the next read of the army (or the minute sweep).
				timeline.cancelWhere(api, entity(id), outbound ? ARRIVE : RETURN, { id });
				timeline.schedule(api, entity(id), at, outbound ? ARRIVE : RETURN, { id });
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
							 WHERE phase = 'outbound' AND player_id != ? AND arrives_at > ? AND (${chunk.map(() => '(target_x = ? AND target_y = ?)').join(' OR ')})`,
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
