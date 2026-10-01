/**
 * Siege defences on the wall (docs/design/gameplay.md §3.13, the "defence works" §3.4 left room
 * for); all numbers in ./data:
 *   - works (moat, barbican, watchtowers): one each per wall, levels 1-3, percent battle effects
 *     — the moat weakens the attackers, the others strengthen the defence;
 *   - defences (rockfall platforms ... cannons): build any number, each a flat bonus to every lane
 *     of the defence; cost, upkeep and time follow the value (cheap to build and dear to keep
 *     low down, the other way round higher up), unlocked by the wall's level.
 * Built one job at a time per wall (a timeline event finishes it); everything built costs upkeep.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	GameError,
	numberFields,
	PluginError,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { SiegeWall } from '../../shared/api';
import type { BattleStat } from '../battle';
import type { Cost } from '../resources';
import devicesCsv from './data/devices.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import worksCsv from './data/works.csv?raw';

const WALL = 'wall';
const DONE = 'starter-siege.done';
const RULES = csvRules(rulesCsv);
const perLevel = (cell: string, sep: string) => cell.split(sep).map((x) => x.trim());
const WORKS = csvRows(worksCsv).map((r) => {
	const [side, stat] = r.effect.split('.');
	if ((side !== 'attacker' && side !== 'defender') || !stat) throw new PluginError(`works.csv: bad effect "${r.effect}" (${r.id})`);
	const values = perLevel(r.values, ';').map(Number);
	const cost = perLevel(r.cost, '|').map(csvMap);
	const seconds = perLevel(r.seconds, ';').map(Number);
	const upkeep = perLevel(r.upkeep, '|').map(csvMap);
	if (![cost, seconds, upkeep].every((l) => l.length === values.length))
		throw new PluginError(`works.csv: ${r.id} needs every column per level`);
	return { id: r.id, name: r.name, icon: r.icon || undefined, side, stat: stat as BattleStat, values, cost, seconds, upkeep };
});
const DEVICES = csvRows(devicesCsv).map((r) => ({
	id: r.id,
	name: r.name,
	icon: r.icon || undefined,
	stat: r.stat as BattleStat,
	value: csvNumber(r, 'value'),
	wall: csvNumber(r, 'wall'),
}));

interface Job {
	kind: 'device' | 'work';
	item: string;
	amount: number;
	startedAt: number;
	finishesAt: number;
}

export default definePlugin({
	id: 'starter-siege',
	version: '0.1.0',
	description: 'Wall works (moat, barbican, watchtowers) and siege defences built at the wall',
	dependsOn: ['starter-defense', 'buildings', 'settlements', 'resources', 'battle', 'timeline'],
	setup(ctx) {
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const rules = ctx.config.define('rules', {
			description:
				'Defence cost / upkeep / time from value: r = value / reference; cost.base x r^cost.exponent (split by shares), upkeep.base x r^upkeep.exponent per hour (split by upkeepShares), seconds.base x r^seconds.exponent; maxBatch.',
			default: () => RULES as Record<string, unknown>,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				const num = (key: string) => numberFields(() => RULES[key] as Record<string, number>, 0, 1e9)(r[key] ?? {});
				return {
					reference:
						r.reference === undefined
							? (RULES.reference as number)
							: numberFields(() => ({ v: RULES.reference as number }), 1, 1e9)({ v: r.reference }).v,
					maxBatch:
						r.maxBatch === undefined
							? (RULES.maxBatch as number)
							: numberFields(() => ({ v: RULES.maxBatch as number }), 1, 1e6)({ v: r.maxBatch }).v,
					cost: num('cost'),
					upkeep: num('upkeep'),
					seconds: num('seconds'),
					shares: num('shares'),
					upkeepShares: num('upkeepShares'),
				};
			},
		});
		type Rules = { reference: number; maxBatch: number } & Record<
			'cost' | 'upkeep' | 'seconds' | 'shares' | 'upkeepShares',
			Record<string, number>
		>;
		const rule = (api: ReadApi) => rules.get(api) as unknown as Rules;
		const split = (total: number, shares: Record<string, number>) =>
			Object.fromEntries(Object.entries(shares).flatMap(([res, s]) => (s > 0 ? [[res, total * s]] : [])));
		/** Per defence: build cost, upkeep per hour and build seconds, from its value. */
		const quote = (api: ReadApi, value: number) => {
			const R = rule(api);
			const r = value / R.reference;
			return {
				cost: Object.fromEntries(Object.entries(split(R.cost.base * r ** R.cost.exponent, R.shares)).map(([k, v]) => [k, Math.ceil(v)])),
				upkeep: split(R.upkeep.base * r ** R.upkeep.exponent, R.upkeepShares),
				seconds: R.seconds.base * r ** R.seconds.exponent,
			};
		};

		/* ----- data ---------------------------------------------------------------------- */

		const load = (api: ReadApi, settlementId: string) =>
			api.memo(`starter-siege:${settlementId}`, async () => {
				const [works, devices, queue] = await Promise.all([
					api.db
						.prepare('SELECT work, level FROM starter_siege_works WHERE settlement_id = ?')
						.bind(settlementId)
						.all<{ work: string; level: number }>(),
					api.db
						.prepare('SELECT device, count FROM starter_siege_devices WHERE settlement_id = ?')
						.bind(settlementId)
						.all<{ device: string; count: number }>(),
					api.db
						.prepare('SELECT kind, item, amount, started_at, finishes_at FROM starter_siege_queue WHERE settlement_id = ?')
						.bind(settlementId)
						.first<{ kind: 'device' | 'work'; item: string; amount: number; started_at: number; finishes_at: number }>(),
				]);
				return {
					works: new Map(works.results.map((r) => [r.work, r.level])),
					devices: new Map(devices.results.map((r) => [r.device, r.count])),
					queue: queue
						? ({
								kind: queue.kind,
								item: queue.item,
								amount: queue.amount,
								startedAt: queue.started_at,
								finishesAt: queue.finishes_at,
							} as Job)
						: null,
				};
			});
		const upkeepOf = async (api: ReadApi, settlementId: string) => {
			const s = await load(api, settlementId);
			const out: Record<string, number> = {};
			const add = (c: Record<string, number>, n = 1) => {
				for (const [r, v] of Object.entries(c)) out[r] = (out[r] ?? 0) + v * n;
			};
			for (const d of DEVICES) if (s.devices.get(d.id)) add(quote(api, d.value).upkeep, s.devices.get(d.id));
			for (const w of WORKS) {
				const lv = s.works.get(w.id);
				if (lv) add(w.upkeep[lv - 1]);
			}
			return out;
		};
		// Upkeep (per second) of everything built at a settlement's wall.
		resources.addConsumer(async (api, holder) => {
			if (!holder.startsWith('settlement:')) return {};
			return Object.fromEntries(Object.entries(await upkeepOf(api, holder.slice('settlement:'.length))).map(([r, v]) => [r, v / 3600]));
		});

		// Finished: the defences join (upkeep changes; the engine banked production up to now first).
		timeline.on<{ settlementId: string }>(DONE, async (api, event) => {
			const s = await load(api, event.payload.settlementId);
			const job = s.queue;
			if (!job || job.finishesAt > event.dueAt) return;
			const id = event.payload.settlementId;
			if (job.kind === 'device') {
				const n = (s.devices.get(job.item) ?? 0) + job.amount;
				s.devices.set(job.item, n);
				api.write(
					api.db
						.prepare(
							'INSERT INTO starter_siege_devices (settlement_id, device, count) VALUES (?, ?, ?) ON CONFLICT (settlement_id, device) DO UPDATE SET count = excluded.count',
						)
						.bind(id, job.item, n),
				);
			} else {
				s.works.set(job.item, job.amount);
				api.write(
					api.db
						.prepare(
							'INSERT INTO starter_siege_works (settlement_id, work, level) VALUES (?, ?, ?) ON CONFLICT (settlement_id, work) DO UPDATE SET level = excluded.level',
						)
						.bind(id, job.item, job.amount),
				);
			}
			s.queue = null;
			api.write(api.db.prepare('DELETE FROM starter_siege_queue WHERE settlement_id = ?').bind(id));
		});

		/** Start a job: checks the wall, the queue and pays. */
		async function start(api: EngineApi, settlementId: string, job: Omit<Job, 'startedAt' | 'finishesAt'>, cost: Cost, seconds: number) {
			const holder = settlements.entity(settlementId);
			await timeline.sync(api, holder);
			const s = await load(api, settlementId);
			if (s.queue) throw new GameError('busy', 'Something is already being built at the wall');
			await resources.spend(api, holder, cost);
			s.queue = { ...job, startedAt: api.now, finishesAt: api.now + Math.max(1, Math.ceil(seconds)) * 1000 };
			api.write(
				api.db
					.prepare('INSERT INTO starter_siege_queue (settlement_id, kind, item, amount, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(settlementId, job.kind, job.item, job.amount, s.queue.startedAt, s.queue.finishesAt),
			);
			timeline.schedule(api, holder, s.queue.finishesAt, DONE, { settlementId });
		}
		const wallLevel = (api: EngineApi, settlementId: string) => buildings.level(api, settlementId, WALL);
		const onWall = (params: Record<string, string>) => params.type === WALL;

		/* ----- battle -------------------------------------------------------------------- */

		ctx.services.get('battle').addModifier(async (api, side, battle) => {
			const defended = battle.defender.settlement;
			if (!defended?.ownerId) return [];
			const s = await load(api, defended.id);
			const out = [];
			for (const w of WORKS) {
				const lv = s.works.get(w.id);
				if (lv && w.side === side.role) out.push({ source: `${w.name} Lv ${lv}`, stat: w.stat, percent: w.values[lv - 1] });
			}
			if (side.role === 'defender')
				for (const d of DEVICES) {
					const n = s.devices.get(d.id) ?? 0;
					if (n) out.push({ source: `${d.name} ×${n}`, stat: d.stat, flat: d.value * n });
				}
			return out;
		});

		/* ----- commands (forms on the wall's entry) -------------------------------------- */

		ctx.commands.add<{ settlement: string; device: string; count: number }>({
			type: 'starter-siege.build',
			description: 'Build siege defences at the wall. Payload: { "settlement", "device", "count" }',
			form: {
				title: 'Build siege defences',
				placement: 'building',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'device', label: 'Defence', type: 'select', required: true },
					{ name: 'count', label: 'Count', type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: 'Build',
				async prepare(api, params) {
					if (!onWall(params)) return false;
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					const level = await wallLevel(api, s.id);
					// Costs and effects are listed in the wall's block above the form.
					const options = DEVICES.filter((d) => d.wall <= level).map((d) => ({ value: d.id, label: d.name }));
					return options.length ? { defaults: { settlement: s.id }, options: { device: options } } : false;
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.device !== 'string')
					throw new GameError('bad_payload', 'settlement and device are required');
				const count = Number(p.count);
				if (!Number.isInteger(count) || count < 1) throw new GameError('bad_payload', 'count must be a positive whole number');
				return { settlement: p.settlement, device: p.device, count };
			},
			async execute(api, { settlement, device, count }) {
				const s = await settlements.requireOwned(api, settlement);
				const d = DEVICES.find((x) => x.id === device);
				if (!d) throw new GameError('bad_payload', 'Unknown defence');
				if (count > rule(api).maxBatch) throw new GameError('bad_payload', `At most ${rule(api).maxBatch} at a time`);
				const level = await wallLevel(api, s.id);
				if (level < d.wall) throw new GameError('blocked', `Requires ${buildings.get(WALL).name} Lv ${d.wall}`);
				const q = quote(api, d.value);
				const cost = Object.fromEntries(Object.entries(q.cost).map(([r, n]) => [r, n * count]));
				await start(api, s.id, { kind: 'device', item: d.id, amount: count }, cost, q.seconds * count);
			},
		});

		ctx.commands.add<{ settlement: string; work: string }>({
			type: 'starter-siege.fortify',
			description: 'Build or raise a wall work (moat, barbican, watchtowers) by one level. Payload: { "settlement", "work" }',
			form: {
				title: 'Raise wall works',
				placement: 'building',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'work', label: 'Work', type: 'select', required: true },
				],
				submitLabel: 'Build',
				async prepare(api, params) {
					if (!onWall(params)) return false;
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					const state = await load(api, s.id);
					const options = WORKS.filter((w) => (state.works.get(w.id) ?? 0) < w.values.length).map((w) => ({ value: w.id, label: w.name }));
					return options.length ? { defaults: { settlement: s.id }, options: { work: options } } : false;
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.work !== 'string')
					throw new GameError('bad_payload', 'settlement and work are required');
				return { settlement: p.settlement, work: p.work };
			},
			async execute(api, { settlement, work }) {
				const s = await settlements.requireOwned(api, settlement);
				const w = WORKS.find((x) => x.id === work);
				if (!w) throw new GameError('bad_payload', 'Unknown work');
				if (!(await wallLevel(api, s.id))) throw new GameError('blocked', `Requires ${buildings.get(WALL).name}`);
				const state = await load(api, s.id);
				const lv = (state.works.get(w.id) ?? 0) + 1;
				if (lv > w.values.length) throw new GameError('blocked', 'Already at the highest level');
				await start(api, s.id, { kind: 'work', item: w.id, amount: lv }, w.cost[lv - 1], w.seconds[lv - 1]);
			},
		});

		ctx.views.add({
			id: 'starter-siege.wall',
			async compute(api, params): Promise<SiegeWall | null> {
				const s = await settlements.resolve(api, params).catch(() => null);
				if (!s) return null;
				await timeline.sync(api, settlements.entity(s.id));
				const state = await load(api, s.id);
				return {
					settlement: s.id,
					wall: await wallLevel(api, s.id),
					works: WORKS.map((w) => {
						const level = state.works.get(w.id) ?? 0;
						const next =
							level < w.values.length
								? { value: w.values[level], cost: w.cost[level], seconds: w.seconds[level], upkeep: w.upkeep[level] }
								: null;
						return {
							id: w.id,
							name: w.name,
							icon: w.icon,
							level,
							maxLevel: w.values.length,
							effect: `${w.side}.${w.stat}`,
							value: level ? w.values[level - 1] : 0,
							next,
						};
					}),
					devices: DEVICES.map((d) => {
						const q = quote(api, d.value);
						return {
							id: d.id,
							name: d.name,
							icon: d.icon,
							count: state.devices.get(d.id) ?? 0,
							stat: d.stat,
							value: d.value,
							wall: d.wall,
							cost: q.cost,
							upkeep: q.upkeep,
							seconds: Math.ceil(q.seconds),
						};
					}),
					queue: state.queue,
					upkeep: await upkeepOf(api, s.id),
				};
			},
		});
	},
});
