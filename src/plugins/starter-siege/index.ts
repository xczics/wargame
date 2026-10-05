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
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	PluginError,
	type ReadApi,
	type RuleView,
	shape,
} from '../../kernel';
import type { SiegeWall } from '../../shared/api';
import { amount, amounts, duration } from '../../shared/format';
import type { RowsData, TimersData, UiRow } from '../../shared/ui';
import type { BattleStat } from '../battle';
import type { Cost } from '../resources';
import devicesCsv from './data/devices.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import worksCsv from './data/works.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('starter-siege');
const text = uiTexts('starter-siege');

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
	upkeep: r.upkeep ? csvMap(r.upkeep) : undefined,
}));

/** What a job at the wall builds: `amount` defences, or a work up to level `amount`. */
interface Order {
	kind: 'device' | 'work';
	item: string;
	amount: number;
}
/** Building at the wall is queued work (queues plugin), one line. */
const KIND = 'starter-siege.build';
const LINE = 'wall';

export default definePlugin({
	id: 'starter-siege',
	version: '0.1.0',
	description: 'Wall works (moat, barbican, watchtowers) and siege defences built at the wall',
	dependsOn: ['starter-defense', 'buildings', 'settlements', 'resources', 'battle', 'timeline', 'queues', 'stats', 'ui', 'i18n'],
	setup(ctx) {
		// Texts shown in this plugin's own views (names from its tables) are its i18n keys.
		const own = ctx.services.get('i18n').scope();
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const buildings = ctx.services.get('buildings');
		ctx.services.get('stats').define({ id: 'starter-siege.deviceStrength', description: 'siege device strength', base: () => 1, min: 0 });
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
		const wallSpeed = ctx.config.define('wallSpeed', {
			description: 'Percent faster siege works and defences are built per wall level.',
			default: () => RULES.wallSpeed as number,
			parse: numberInRange(0, 1000),
		});
		const split = (total: number, shares: Record<string, number>) =>
			Object.fromEntries(Object.entries(shares).flatMap(([res, s]) => (s > 0 ? [[res, total * s]] : [])));
		/** Per defence: build cost, upkeep per hour and build seconds, from its value. */
		/** `upkeepShares`: the device's own mix (devices.csv), else the rule's. */
		const quote = (api: ReadApi, value: number, upkeepShares?: Record<string, number>) => {
			const R = rule(api);
			const r = value / R.reference;
			return {
				cost: Object.fromEntries(Object.entries(split(R.cost.base * r ** R.cost.exponent, R.shares)).map(([k, v]) => [k, Math.ceil(v)])),
				upkeep: split(R.upkeep.base * r ** R.upkeep.exponent, upkeepShares ?? R.upkeepShares),
				seconds: R.seconds.base * r ** R.seconds.exponent,
			};
		};

		/*
		 * Each defence and each work on its own (user 2026-10-05: "城防器械的GM栏，也要按具体的城防器械分别指定建造消耗、效果和维持
		 * 消耗。按表格显示。"): a table of every defence (wall level, value, cost, seconds, upkeep per hour) and of every
		 * work's levels, by default from the data files and the formula above; the GM changes any cell.
		 */
		type DeviceRow = { wall: number; value: number; cost: Record<string, number>; seconds: number; upkeep: Record<string, number> };
		type WorkLevel = { value: number; cost: Record<string, number>; seconds: number; upkeep: Record<string, number> };
		const round2 = (n: number) => Math.round(n * 100) / 100;
		const contentDevices = (view: RuleView): Record<string, DeviceRow> =>
			Object.fromEntries(
				DEVICES.map((d) => {
					const q = quote(view as unknown as ReadApi, d.value, d.upkeep);
					const upkeep = Object.fromEntries(Object.entries(q.upkeep).map(([r, n]) => [r, round2(n)]));
					return [d.id, { wall: d.wall, value: d.value, cost: q.cost, seconds: Math.round(q.seconds), upkeep }];
				}),
			);
		const contentWorks = (): Record<string, { levels: WorkLevel[] }> =>
			Object.fromEntries(
				WORKS.map((w) => [
					w.id,
					{ levels: w.values.map((value, i) => ({ value, cost: w.cost[i], seconds: w.seconds[i], upkeep: w.upkeep[i] })) },
				]),
			);
		const resourceIds = () => resources.list().map((r) => r.id);
		const costMap = (v: unknown, where: string) => {
			if (typeof v !== 'object' || v === null || Array.isArray(v))
				throw fail('bad_config', text('{0}: expected { resource: amount }', { 0: where }));
			return Object.fromEntries(
				Object.entries(v).map(([r, n]) => {
					if (!resourceIds().includes(r)) throw fail('bad_config', text('{0}: unknown resource "{1}"', { 0: where, 1: r }));
					return [r, numberInRange(0, 1e12)(n)];
				}),
			);
		};
		const devicesRule = ctx.config.define<Record<string, DeviceRow>>('devices', {
			description:
				'Each siege defence: wall level needed, value (defence or hp in every lane), build cost, build seconds and upkeep per hour. Partial: only what is given changes.',
			default: contentDevices,
			parse(raw, view) {
				const out = contentDevices(view);
				for (const [id, patch] of Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>)) {
					const row = out[id];
					if (!row) throw fail('bad_config', text('Unknown defence "{0}"', { 0: id }));
					for (const [k, v] of Object.entries(patch ?? {})) {
						if (k === 'cost' || k === 'upkeep') row[k] = costMap(v, `${id}.${k}`);
						else if (k === 'wall' || k === 'value' || k === 'seconds') row[k] = numberInRange(0, 1e12)(v);
						else throw fail('bad_config', text('{0}: unknown field "{1}"', { 0: id, 1: k }));
					}
				}
				return out;
			},
		});
		const worksRule = ctx.config.define<Record<string, { levels: WorkLevel[] }>>('works', {
			description:
				"Each wall work's levels: effect (%), build cost, build seconds and upkeep per hour. Partial: the works given replace their levels.",
			default: contentWorks,
			parse(raw) {
				const out = contentWorks();
				for (const [id, patch] of Object.entries((raw ?? {}) as Record<string, { levels?: unknown }>)) {
					if (!out[id]) throw fail('bad_config', text('Unknown work "{0}"', { 0: id }));
					if (!Array.isArray(patch?.levels) || !patch.levels.length) throw fail('bad_config', text('{0}: expected levels', { 0: id }));
					out[id] = {
						levels: patch.levels.map((l, i) => {
							const x = (l ?? {}) as Record<string, unknown>;
							const where = `${id}.${i + 1}`;
							return {
								value: numberInRange(-1000, 1000)(x.value),
								cost: costMap(x.cost ?? {}, `${where}.cost`),
								seconds: numberInRange(0, 1e9)(x.seconds),
								upkeep: costMap(x.upkeep ?? {}, `${where}.upkeep`),
							};
						}),
					};
				}
				return out;
			},
		});
		// Names for the GM's tables: each defence and work.
		ctx.meta.add('siegeItems', () => [...DEVICES, ...WORKS].map((x) => ({ id: x.id, name: `${ctx.pluginId}.${x.name}` })));
		/** A defence as the rules have it now. */
		const dev = (api: ReadApi, d: (typeof DEVICES)[number]) => devicesRule.get(api)[d.id];
		/** A work's levels as the rules have them now (as lists, like the data file). */
		const wk = (api: ReadApi, w: (typeof WORKS)[number]) => {
			const levels = worksRule.get(api)[w.id]?.levels ?? [];
			return {
				values: levels.map((l) => l.value),
				cost: levels.map((l) => l.cost),
				seconds: levels.map((l) => l.seconds),
				upkeep: levels.map((l) => l.upkeep),
			};
		};

		/* ----- data ---------------------------------------------------------------------- */

		const load = (api: ReadApi, settlementId: string) =>
			api.memo(`starter-siege:${settlementId}`, async () => {
				if (api.isFresh(settlements.entity(settlementId))) return { works: new Map<string, number>(), devices: new Map<string, number>() };
				const [works, devices] = await Promise.all([
					api.db
						.prepare('SELECT work, level FROM starter_siege_works WHERE settlement_id = ?')
						.bind(settlementId)
						.all<{ work: string; level: number }>(),
					api.db
						.prepare('SELECT device, count FROM starter_siege_devices WHERE settlement_id = ?')
						.bind(settlementId)
						.all<{ device: string; count: number }>(),
				]);
				return {
					works: new Map(works.results.map((r) => [r.work, r.level])),
					devices: new Map(devices.results.map((r) => [r.device, r.count])),
				};
			});
		const upkeepOf = async (api: ReadApi, settlementId: string) => {
			const s = await load(api, settlementId);
			const out: Record<string, number> = {};
			const add = (c: Record<string, number>, n = 1) => {
				for (const [r, v] of Object.entries(c)) out[r] = (out[r] ?? 0) + v * n;
			};
			for (const d of DEVICES) if (s.devices.get(d.id)) add(dev(api, d).upkeep, s.devices.get(d.id));
			for (const w of WORKS) {
				const lv = s.works.get(w.id);
				if (lv) add(wk(api, w).upkeep[lv - 1] ?? {});
			}
			return out;
		};
		// Upkeep (per second) of everything built at a settlement's wall.
		resources.addConsumer(async (api, holder) => {
			if (!holder.startsWith('settlement:')) return {};
			return Object.fromEntries(Object.entries(await upkeepOf(api, holder.slice('settlement:'.length))).map(([r, v]) => [r, v / 3600]));
		}, text('Wall defences'));

		const queues = ctx.services.get('queues');
		queues.define<Order>({
			id: KIND,
			// Worked out when it starts: the wall's level then speeds it up.
			async seconds(api, job) {
				const { kind, item, amount } = job.payload;
				const d = DEVICES.find((x) => x.id === item);
				const w = WORKS.find((x) => x.id === item);
				const base = kind === 'device' ? (d ? dev(api, d).seconds * amount : 1) : ((w && wk(api, w).seconds[amount - 1]) ?? 1);
				return buildSeconds(api, job.owner, base);
			},
			// Finished: the defences join (upkeep changes; the engine banked production up to now first).
			async finish(api, job) {
				const s = await load(api, job.owner);
				const { kind, item, amount } = job.payload;
				if (kind === 'device') {
					const n = (s.devices.get(item) ?? 0) + amount;
					s.devices.set(item, n);
					api.write(
						api.db
							.prepare(
								'INSERT INTO starter_siege_devices (settlement_id, device, count) VALUES (?, ?, ?) ON CONFLICT (settlement_id, device) DO UPDATE SET count = excluded.count',
							)
							.bind(job.owner, item, n),
					);
				} else {
					s.works.set(item, amount);
					api.write(
						api.db
							.prepare(
								'INSERT INTO starter_siege_works (settlement_id, work, level) VALUES (?, ?, ?) ON CONFLICT (settlement_id, work) DO UPDATE SET level = excluded.level',
							)
							.bind(job.owner, item, amount),
					);
				}
			},
		});
		/**
		 * The job from before the queues plugin (table `starter_siege_queue`, one per settlement): moved into the
		 * queues the first time the settlement is used, finishing when it would have; its old event is dropped.
		 */
		const adoptOld = (api: EngineApi, settlementId: string) =>
			api.memo(`starter-siege:adopt:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT kind, item, amount, started_at, finishes_at FROM starter_siege_queue WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ kind: 'device' | 'work'; item: string; amount: number; started_at: number; finishes_at: number }>();
				if (!row) return;
				api.write(api.db.prepare('DELETE FROM starter_siege_queue WHERE settlement_id = ?').bind(settlementId));
				timeline.cancelWhere(api, settlements.entity(settlementId), DONE, { settlementId });
				await queues.adopt(api, KIND, settlementId, [
					{
						id: crypto.randomUUID(),
						line: LINE,
						payload: { kind: row.kind, item: row.item, amount: row.amount } satisfies Order,
						// Running already: nothing to refund.
						cost: {},
						startedAt: row.started_at,
						finishesAt: row.finishes_at,
					},
				]);
			});
		// An event from before the queues plugin: the job moves over, and the queues finish it.
		timeline.on<{ settlementId: string }>(DONE, async (api, event) => {
			await adoptOld(api, event.payload.settlementId);
		});
		/** The wall's jobs: the one being built, then those waiting. */
		const jobsAt = async (api: EngineApi, settlementId: string) => {
			await adoptOld(api, settlementId);
			return queues.jobs<Order>(api, KIND, settlementId);
		};

		/** Build seconds at the wall of `settlementId`: each wall level speeds it up (`wallSpeed`). */
		const buildSeconds = async (api: ReadApi, settlementId: string, seconds: number) =>
			seconds / (1 + ((await buildings.level(api as EngineApi, settlementId, WALL)) * wallSpeed.get(api)) / 100);
		buildings.addEffectLines(WALL, async (api, _s, level) => [
			text('Siege works and defences built {0}% faster', { 0: Math.round(level * wallSpeed.get(api)) }),
		]);
		/** Queue a job at the wall: paid now, built after those already waiting. */
		async function start(api: EngineApi, settlementId: string, order: Order, cost: Cost) {
			await adoptOld(api, settlementId);
			await queues.add<Order>(api, KIND, settlementId, LINE, order, cost);
		}
		/** A work's level once everything queued is built: the next order raises it from there. */
		const plannedLevel = async (api: EngineApi, settlementId: string, work: string) =>
			Math.max(
				(await load(api, settlementId)).works.get(work) ?? 0,
				...(await jobsAt(api, settlementId))
					.filter((j) => j.payload.kind === 'work' && j.payload.item === work)
					.map((j) => j.payload.amount),
			);
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
				if (lv && w.side === side.role)
					out.push({ source: text('{0} Lv {1}', { 0: text(w.name), 1: lv }), stat: w.stat, percent: wk(api, w).values[lv - 1] ?? 0 });
			}
			if (side.role === 'defender') {
				// Others strengthen the devices (not the works), e.g. research: percent on `deviceStrength`.
				const strength = await ctx.services.get('stats').get(api, 'starter-siege.deviceStrength', settlements.entity(defended.id));
				for (const d of DEVICES) {
					const n = s.devices.get(d.id) ?? 0;
					if (n) out.push({ source: text('{0} ×{1}', { 0: text(d.name), 1: n }), stat: d.stat, flat: dev(api, d).value * n * strength });
				}
			}
			return out;
		});

		/* ----- commands (forms on the wall's entry) -------------------------------------- */

		ctx.commands.add<{ settlement: string; device: string; count: number }>({
			type: 'starter-siege.build',
			description: 'Build siege defences at the wall. Payload: { "settlement", "device", "count" }',
			form: {
				title: text('Build siege defences'),
				placement: 'building',
				fields: [
					{ name: 'settlement', label: text('settlement'), type: 'hidden' },
					{ name: 'device', label: text('Defence'), type: 'select', required: true },
					{ name: 'count', label: text('Count'), type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: text('Build'),
				async prepare(api, params) {
					if (!onWall(params)) return false;
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					const level = await wallLevel(api, s.id);
					// Costs and effects are listed in the wall's block above the form.
					const options = DEVICES.filter((d) => dev(api, d).wall <= level).map((d) => ({ value: d.id, label: text(d.name) }));
					return options.length ? { defaults: { settlement: s.id }, options: { device: options } } : false;
				},
			},
			parse: shape({ settlement: fields.id(), device: fields.id(), count: fields.int(1, 1e6) }),
			async execute(api, { settlement, device, count }) {
				const s = await settlements.requireOwned(api, settlement);
				const d = DEVICES.find((x) => x.id === device);
				if (!d) throw fail('bad_payload', 'Unknown defence');
				if (count > rule(api).maxBatch) throw fail('bad_payload', text('At most {0} at a time', { 0: rule(api).maxBatch }));
				const level = await wallLevel(api, s.id);
				const q = dev(api, d);
				if (level < q.wall) throw fail('blocked', text('Requires {0} Lv {1}', { 0: keyText(buildings.get(WALL).name), 1: q.wall }));
				const cost = Object.fromEntries(Object.entries(q.cost).map(([r, n]) => [r, n * count]));
				await start(api, s.id, { kind: 'device', item: d.id, amount: count }, cost);
			},
		});

		ctx.commands.add<{ settlement: string; work: string }>({
			type: 'starter-siege.fortify',
			description: 'Build or raise a wall work (moat, barbican, watchtowers) by one level. Payload: { "settlement", "work" }',
			form: {
				title: text('Raise wall works'),
				placement: 'building',
				fields: [
					{ name: 'settlement', label: text('settlement'), type: 'hidden' },
					{ name: 'work', label: text('Work'), type: 'select', required: true },
				],
				submitLabel: text('Build'),
				async prepare(api, params) {
					if (!onWall(params)) return false;
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					const planned = new Map(await Promise.all(WORKS.map(async (w) => [w.id, await plannedLevel(api, s.id, w.id)] as const)));
					const options = WORKS.filter((w) => (planned.get(w.id) ?? 0) < wk(api, w).values.length).map((w) => ({
						value: w.id,
						label: text(w.name),
					}));
					return options.length ? { defaults: { settlement: s.id }, options: { work: options } } : false;
				},
			},
			parse: shape({ settlement: fields.id(), work: fields.id() }),
			async execute(api, { settlement, work }) {
				const s = await settlements.requireOwned(api, settlement);
				const w = WORKS.find((x) => x.id === work);
				if (!w) throw fail('bad_payload', 'Unknown work');
				if (!(await wallLevel(api, s.id))) throw fail('blocked', text('Requires {0}', { 0: keyText(buildings.get(WALL).name) }));
				// Levels queued already count: the next order raises it one further.
				const lv = (await plannedLevel(api, s.id, w.id)) + 1;
				const levels = wk(api, w);
				if (lv > levels.values.length) throw fail('blocked', 'Already at the highest level');
				await start(api, s.id, { kind: 'work', item: w.id, amount: lv }, levels.cost[lv - 1]);
			},
		});

		/** The wall's jobs as `SiegeWall` shows them: the one being built, and those waiting. */
		async function queueOf(api: EngineApi, settlementId: string): Promise<Pick<SiegeWall, 'queue' | 'waiting'>> {
			const jobs = await jobsAt(api, settlementId);
			const run = jobs.find((j) => j.startedAt !== null);
			return {
				queue: run ? { ...run.payload, startedAt: run.startedAt!, finishesAt: run.finishesAt! } : null,
				waiting: jobs.filter((j) => j.startedAt === null).map((j) => ({ id: j.id, ...j.payload })),
			};
		}
		ctx.commands.add<{ settlement: string; id: string }>({
			type: 'starter-siege.cancel',
			description: 'Cancel an order at the wall that has not started; what it cost comes back. Payload: { "settlement", "id" }',
			parse: shape({ settlement: fields.id(), id: fields.id() }),
			async execute(api, { settlement, id }) {
				const s = await settlements.requireOwned(api, settlement);
				await adoptOld(api, s.id);
				await queues.cancel(api, KIND, s.id, id);
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
						const l = wk(api, w);
						const next =
							level < l.values.length
								? { value: l.values[level], cost: l.cost[level], seconds: l.seconds[level], upkeep: l.upkeep[level] }
								: null;
						return {
							id: w.id,
							name: own(w.name),
							icon: w.icon,
							level,
							maxLevel: l.values.length,
							effect: `${w.side}.${w.stat}`,
							value: level ? (l.values[level - 1] ?? 0) : 0,
							next,
						};
					}),
					devices: DEVICES.map((d) => {
						const q = dev(api, d);
						return {
							id: d.id,
							name: own(d.name),
							icon: d.icon,
							count: state.devices.get(d.id) ?? 0,
							stat: d.stat,
							value: q.value,
							wall: q.wall,
							cost: q.cost,
							upkeep: q.upkeep,
							seconds: Math.ceil(q.seconds),
						};
					}),
					...(await queueOf(api, s.id)),
					upkeep: await upkeepOf(api, s.id),
				};
			},
		});

		// The same for the generic widgets on the wall's entry: what is being built (timers), then the works
		// and defences with what each gives and costs (rows).
		const wallView = (api: Parameters<typeof wallLevel>[0], params: Record<string, string>) =>
			api.memo(`starter-siege:panel:${params.settlement ?? ''}`, async () => {
				const s = await settlements.resolve(api, params).catch(() => null);
				if (!s) return null;
				await timeline.sync(api, settlements.entity(s.id));
				return { s, state: await load(api, s.id), jobs: await jobsAt(api, s.id), wall: await wallLevel(api, s.id) };
			});
		const icons = () => Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
		const pct = (v: number) => `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
		ctx.views.add({
			id: 'starter-siege.queue',
			async compute(api, params): Promise<TimersData | null> {
				const w = await wallView(api, params);
				if (!w?.jobs.length) return null;
				const ic = icons();
				const label = (o: Order) => {
					const name = (o.kind === 'work' ? WORKS : DEVICES).find((x) => x.id === o.item)?.name ?? o.item;
					return o.kind === 'work'
						? text('{item} Lv {n}', { item: text(name), n: o.amount })
						: text('{item} ×{n}', { item: text(name), n: o.amount });
				};
				// The one being built counts down; those waiting can be cancelled for their cost.
				return {
					items: w.jobs.map((j) =>
						j.startedAt !== null
							? { id: j.id, title: text('Building: {0}', { 0: label(j.payload) }), startedAt: j.startedAt, endsAt: j.finishesAt! }
							: {
									id: j.id,
									title: label(j.payload),
									lines: [{ text: text('Waiting · {cost}', { cost: amounts(j.cost, ic) }), tone: 'muted' as const }],
									actions: [
										{
											command: 'starter-siege.cancel',
											payload: { settlement: w.s.id, id: j.id },
											label: text('Cancel (refund)'),
											confirm: text('Cancel this order? Its cost comes back.'),
										},
									],
								},
					),
				};
			},
		});
		ctx.views.add({
			id: 'starter-siege.rows',
			async compute(api, params): Promise<RowsData | null> {
				const w = await wallView(api, params);
				if (!w) return null;
				const ic = icons();
				const upkeep = await upkeepOf(api, w.s.id);
				return {
					sections: [
						{
							title: text('Wall works'),
							rows: await Promise.all(
								WORKS.map(async (x): Promise<UiRow> => {
									const level = w.state.works.get(x.id) ?? 0;
									const effect = text(`stat:${x.side}.${x.stat}`);
									return {
										id: x.id,
										icon: x.icon,
										title: text(x.name),
										badge: text('Lv {n}/{max}', { n: level, max: x.values.length }),
										lines: [
											...(level ? [{ text: text('{effect} {value}', { effect, value: pct(x.values[level - 1]) }) }] : []),
											...(level < x.values.length
												? [
														{
															text: text('next: {effect} {value} · {cost} · {t}', {
																effect,
																value: pct(x.values[level]),
																cost: amounts(x.cost[level], ic),
																t: duration(await buildSeconds(api, w.s.id, x.seconds[level])),
															}),
															tone: 'muted' as const,
														},
													]
												: []),
										],
									};
								}),
							),
						},
						{
							title: text('Siege defences'),
							rows: await Promise.all(
								DEVICES.map(async (d): Promise<UiRow> => {
									const q = dev(api, d);
									const count = w.state.devices.get(d.id) ?? 0;
									return {
										id: d.id,
										icon: d.icon,
										title: count ? text('{item} ×{n}', { item: text(d.name), n: count }) : text(d.name),
										lines: [
											{
												text: text('each: {effect} +{value} · {cost} · {t} · keep {upkeep}/h', {
													effect: text(`stat:${d.stat}`),
													value: amount(q.value),
													cost: amounts(q.cost, ic),
													t: duration(await buildSeconds(api, w.s.id, q.seconds)),
													upkeep: amounts(q.upkeep, ic, 2),
												}),
												tone: 'muted' as const,
											},
											...(q.wall > w.wall ? [{ text: text('needs wall Lv {n}', { n: q.wall }), tone: 'muted' as const }] : []),
										],
										locked: q.wall > w.wall,
									};
								}),
							),
						},
					],
					notes: amounts(upkeep, ic) ? [{ text: text('Upkeep: {upkeep}/h', { upkeep: amounts(upkeep, ic, 1) }) }] : [],
				};
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.entry({ kind: 'building', widget: 'ui.timers', order: -31, types: ['wall'], props: { view: 'starter-siege.queue' } });
		ui.entry({ kind: 'building', widget: 'ui.rows', order: -30, types: ['wall'], props: { view: 'starter-siege.rows' } });
	},
});
