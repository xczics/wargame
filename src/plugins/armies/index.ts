/**
 * Armies: units sent from a settlement to a map tile and back.
 *
 *   send -> (travel) -> arrive: encounter at the target -> (travel back) -> return home
 *
 * Travel uses the shortest way around the wrapping map at the pace of the slowest unit.
 * Arrival and return are timeline events on the army entity (`army:<id>`), so they happen
 * on time even when the player is offline (cron sweep).
 *
 * What happens at the target is not decided here: plugins register encounter handlers
 * (`addEncounter`) — raiding NPC camps, attacking players, and later scouting, settling...
 * The first handler that returns a report wins; with none, the army just looks around.
 */
import { definePlugin, GameError, numberInRange, type EngineApi } from '../../kernel';
import type { ArmyInfo, BattleReport, IncomingArmy } from '../../shared/api';
import type { Tile } from '../world-map';

export interface Encounter {
	army: { id: string; playerId: string; from: string; units: Record<string, number> };
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

/** Multiplies an army's attack (e.g. a hero leading it). Must only read. */
export type AttackModifier = (api: EngineApi, encounter: Encounter) => Promise<{ source: string; factor: number } | null>;

export interface ArmiesService {
	addEncounter(handler: EncounterHandler): void;
	addAttackModifier(modifier: AttackModifier): void;
	/** An arriving army's attack after all modifiers — what combat handlers should use. */
	attack(api: EngineApi, encounter: Encounter): Promise<{ attack: number; factors: { source: string; factor: number }[] }>;
	/** Attack strength of a group of units (before modifiers). */
	attackOf(units: Record<string, number>): number;
	/**
	 * The shared battle formula: the stronger side wins; the closer the fight, the heavier
	 * the losses. Returns the share (0-1) of each side that dies.
	 */
	battle(attack: number, defense: number): { victory: boolean; attackerLoss: number; defenderLoss: number };
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
		const attackModifiers: AttackModifier[] = [];

		const speed = ctx.config.define('speed', {
			description: 'Marching speed multiplier (2 = armies travel twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});

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
			report: r.report ? JSON.parse(r.report) : null,
			departedAt: r.departed_at,
			arrivesAt: r.arrives_at,
			returnsAt: r.returns_at,
		});
		const carryOf = (units: Record<string, number>) => {
			const defs = new Map(troops.list().map((d) => [d.id, d]));
			return Object.entries(units).reduce((sum, [u, n]) => sum + (defs.get(u)?.carry ?? 0) * n, 0);
		};

		const service: ArmiesService = {
			addEncounter: (h) => void encounters.push(h),
			addAttackModifier: (m) => void attackModifiers.push(m),
			async attack(api, encounter) {
				let attack = service.attackOf(encounter.army.units);
				const factors: { source: string; factor: number }[] = [];
				for (const m of attackModifiers) {
					const f = await m(api, encounter);
					if (f) {
						factors.push(f);
						attack *= f.factor;
					}
				}
				return { attack, factors };
			},
			attackOf(units) {
				const defs = new Map(troops.list().map((d) => [d.id, d]));
				return Object.entries(units).reduce((sum, [u, n]) => sum + (defs.get(u)?.attack ?? 0) * n, 0);
			},
			battle(attack, defense) {
				if (defense <= 0) return { victory: true, attackerLoss: 0, defenderLoss: 1 };
				if (attack <= 0) return { victory: false, attackerLoss: 1, defenderLoss: 0 };
				const victory = attack > defense;
				const ratio = victory ? defense / attack : attack / defense; // < 1
				const light = 0.5 * ratio ** 1.5; // the winner's losses
				return victory ? { victory, attackerLoss: light, defenderLoss: 1 } : { victory, attackerLoss: 1 - light, defenderLoss: light };
			},
		};
		ctx.services.provide('armies', service);

		timeline.on<{ id: string }>(ARRIVE, async (api, event) => {
			const row = await load(api, event.payload.id);
			if (!row) return;
			const units = JSON.parse(row.units) as Record<string, number>;
			const tile = { x: row.target_x, y: row.target_y };
			const occupant = (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null;
			const encounter: Encounter = {
				army: { id: row.id, playerId: row.player_id, from: row.from_settlement, units },
				tile,
				occupant,
				carry: carryOf(units),
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
		});

		ctx.commands.add<{ from: string; tile: Tile; units: Record<string, number> }>({
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
						fields: troops
							.list()
							.filter((d) => available.get(d.id))
							.map((d) => ({ name: `units.${d.id}`, label: d.name, type: 'number' as const, min: 0, default: 0 })),
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
				return { from: p.from, tile: { x: map.wrap(x), y: map.wrap(y) }, units };
			},
			async execute(api, { from, tile, units }) {
				const s = await settlements.requireOwned(api, from);
				const garrison = await troops.garrison(api, s.id);
				const defs = new Map(troops.list().map((d) => [d.id, d]));
				for (const [u, n] of Object.entries(units)) {
					if (!defs.has(u)) throw new GameError('bad_payload', `Unknown unit "${u}"`);
					if ((garrison.get(u) ?? 0) < n) throw new GameError('not_enough_units', `Not enough ${defs.get(u)!.name}`);
				}
				const pace = Math.min(...Object.keys(units).map((u) => defs.get(u)!.speed));
				const distance = map.distance({ x: s.x, y: s.y }, tile);
				if (distance === 0) throw new GameError('bad_target', 'Pick a tile away from the settlement');
				const seconds = Math.max(1, Math.ceil(((distance / pace) * 3600) / speed.get(api)));
				for (const [u, n] of Object.entries(units)) await troops.adjust(api, s.id, u, -n);
				const id = crypto.randomUUID();
				const arrivesAt = api.now + seconds * 1000;
				api.write(
					api.db
						.prepare(
							`INSERT INTO armies_marches (id, player_id, from_settlement, target_x, target_y, phase, units, departed_at, arrives_at, returns_at)
							 VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?)`,
						)
						.bind(id, api.playerId, s.id, tile.x, tile.y, JSON.stringify(units), api.now, arrivesAt, arrivesAt + seconds * 1000),
				);
				timeline.schedule(api, entity(id), arrivesAt, ARRIVE, { id });
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
