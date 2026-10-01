/**
 * Default items (names and numbers in ./data), each using an extension point the core systems left for items:
 *   expansion-permit    an outer city past the research limit (up to the hard limit, ring 2)
 *   breakthrough-stone  raise one building's level cap by 1-3 (random)
 *   land-grant          one more building slot in an outer city
 * and the data-driven ones in uses.csv: resource vouchers, speed-ups (construction / training /
 * research), a timed production boost, and hero items (heal, experience, respec).
 */
import {
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	GameError,
	numberFields,
	numberInRange,
	PluginError,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { Hero } from '../heroes';
import type { Tile } from '../world-map';
import itemsCsv from './data/items.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import usesCsv from './data/uses.csv?raw';

/** Names, icons and descriptions by item id (./data/items.csv). */
const INFO = new Map(
	csvRows(itemsCsv).map((r) => [r.id, { name: r.name, icon: r.icon || undefined, description: r.description || undefined }]),
);
const RULES = csvRules(rulesCsv);
const USES = csvRows(usesCsv).map((r) => ({ id: r.id, effect: r.effect, target: r.target, amount: csvNumber(r, 'amount', 0) }));
const BOOST_END = 'starter-items.boostEnd';
const info = (id: string) => {
	const i = INFO.get(id);
	if (!i) throw new PluginError(`starter-items: "${id}" is missing from data/items.csv`);
	return { id, ...i };
};

const str = (raw: unknown, name: string) => {
	if (typeof raw !== 'string' || !raw) throw new GameError('bad_payload', `${name} is required`);
	return raw;
};

export default definePlugin({
	id: 'starter-items',
	version: '0.1.0',
	description: 'Expansion permit, breakthrough stone, land grant; vouchers, speed-ups, boosts and hero items',
	dependsOn: ['items', 'settlements', 'buildings', 'world-map', 'resources', 'stats', 'timeline', 'troops', 'research', 'heroes', 'realms'],
	setup(ctx) {
		const items = ctx.services.get('items');
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const map = ctx.services.get('worldMap');
		const breakthrough = ctx.config.define('breakthrough', {
			description: 'A breakthrough stone raises a level cap by a random whole number of levels in [min, max].',
			default: () => RULES.breakthrough as { min: number; max: number },
			parse: (raw) => {
				const v = numberFields(() => RULES.breakthrough as { min: number; max: number }, 1, 1000)(raw);
				if (v.max < v.min) throw new GameError('bad_config', 'max must be at least min');
				return { min: Math.floor(v.min), max: Math.floor(v.max) };
			},
		});

		items.define<{ settlement: string; tile: Tile }>({
			...info('expansion-permit'),
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					const [x, y] = str(p.tile, 'tile').split(',').map(Number);
					if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'tile must be "x,y"');
					return { settlement: str(p.settlement, 'settlement'), tile: { x: map.wrap(x), y: map.wrap(y) } };
				},
				async apply(api, { settlement, tile }) {
					const s = await settlements.requireOwned(api, settlement);
					await settlements.addOuter(api, s.id, tile, { ignoreTechLimit: true });
				},
				form: {
					title: 'Use an expansion permit',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'tile', label: 'Where', type: 'select', required: true },
					],
					submitLabel: 'Build outer city',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s || settlements.kind(s.kind).layout !== 'ring') return false;
						const candidates = await settlements.outerCandidates(api, s);
						if (!candidates.length) return false;
						return {
							defaults: { settlement: s.id },
							options: {
								tile: await Promise.all(
									candidates.map(async (t) => ({ value: `${t.x},${t.y}`, label: await settlements.tileLabel(api, t) })),
								),
							},
						};
					},
				},
			},
		});

		items.define<{ settlement: string; district: string; slot: number }>({
			...info('breakthrough-stone'),
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					const [district, slot] = str(p.target, 'target').split(':');
					return { settlement: str(p.settlement, 'settlement'), district, slot: Number(slot) };
				},
				async apply(api, { settlement, district, slot }) {
					const s = await settlements.requireOwned(api, settlement);
					const { min, max } = breakthrough.get(api);
					const by = min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
					await buildings.raiseCap(api, s.id, district, slot, by);
				},
				form: {
					title: 'Use a breakthrough stone',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'target', label: 'Building', type: 'select', required: true },
					],
					submitLabel: 'Break through',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s) return false;
						const placed = await buildings.placed(api, s.id);
						const options: { value: string; label: string }[] = [];
						for (const d of s.districts)
							for (const [slot, p] of placed.get(d.id) ?? new Map())
								options.push({
									value: `${d.id}:${slot}`,
									label: `${buildings.get(p.building).name} Lv ${p.level}/${await buildings.capOf(api, s.id, p)} (${d.type === 'outer' ? `outer ${d.idx}` : d.type})`,
								});
						return options.length ? { defaults: { settlement: s.id }, options: { target: options } } : false;
					},
				},
			},
		});

		items.define<{ settlement: string; district: string }>({
			...info('land-grant'),
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					return { settlement: str(p.settlement, 'settlement'), district: str(p.district, 'district') };
				},
				async apply(api, { settlement, district }) {
					const s = await settlements.requireOwned(api, settlement);
					const { district: d } = settlements.district(s, district);
					if (d.type !== 'outer') throw new GameError('bad_target', 'Land grants only work on outer cities');
					await settlements.addSlots(api, s.id, d.id, 1);
				},
				form: {
					title: 'Use a land grant',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'district', label: 'Outer city', type: 'select', required: true },
					],
					submitLabel: 'Add slot',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						const outer = s?.districts.filter((d) => d.type === 'outer') ?? [];
						if (!s || !outer.length) return false;
						return {
							defaults: { settlement: s.id },
							options: { district: outer.map((d) => ({ value: d.id, label: `Outer city ${d.idx} (${d.slots} slots)` })) },
						};
					},
				},
			},
		});

		/* ----- data-driven items (uses.csv) ------------------------------------------------- */

		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const heroes = ctx.services.get('heroes');
		const realms = ctx.services.get('realms');
		const speedUps: Record<string, (api: EngineApi, settlementId: string, seconds: number) => Promise<boolean>> = {
			construction: (api, s, n) => buildings.speedUp(api, s, n),
			training: (api, s, n) => ctx.services.get('troops').speedUp(api, s, n),
			research: (api, s, n) => ctx.services.get('research').speedUp(api, s, n),
		};
		const boostRule = ctx.config.define('boost', {
			description: 'hours: how long a production boost (harvest prayer) lasts; another one adds as much.',
			default: () => RULES.boost as { hours: number },
			parse: numberFields(() => RULES.boost as { hours: number }, 0, 24 * 365),
		});

		// Production boosts: active while their row exists; the end event removes it (production is settled up to then first).
		const loadBoost = (api: ReadApi, settlementId: string) =>
			api.memo(`starter-items:boost:${settlementId}`, async () => ({
				row: await api.db
					.prepare('SELECT percent, until FROM starter_items_boosts WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ percent: number; until: number }>(),
			}));
		stats.contribute('resources.productionFactor', async (api, target) => {
			if (!target.startsWith('settlement:')) return null;
			const { row } = await loadBoost(api, target.slice('settlement:'.length));
			return row ? { percent: row.percent } : null;
		});
		timeline.on<{ settlementId: string }>(BOOST_END, async (api, event) => {
			const b = await loadBoost(api, event.payload.settlementId);
			if (!b.row || b.row.until > event.dueAt) return;
			b.row = null;
			api.write(api.db.prepare('DELETE FROM starter_items_boosts WHERE settlement_id = ?').bind(event.payload.settlementId));
		});

		const settlementField = { name: 'settlement', label: 'settlement', type: 'hidden' as const };
		const heroField = { name: 'hero', label: 'Hero', type: 'select' as const, required: true };
		const heroOptions = (list: Hero[]) => list.map((h) => ({ value: h.id, label: `${heroes.nameOf(h)} (Lv ${h.level})` }));
		const ownHero = async (api: EngineApi, id: string) => {
			const h = (await heroes.list(api, api.playerId)).find((x) => x.id === id);
			if (!h) throw new GameError('not_found', 'No such hero', 404);
			return h;
		};
		/** Heroes an item can be used on, for its form (none: the form is hidden). */
		const heroItem = (
			id: string,
			pick: (api: ReadApi, h: Hero) => Promise<boolean> | boolean,
			apply: (api: EngineApi, h: Hero) => Promise<void>,
			submit: string,
		) =>
			items.define<{ hero: string }>({
				...info(id),
				use: {
					parse: (raw) => ({ hero: str((raw as Record<string, unknown> | null)?.hero, 'hero') }),
					apply: async (api, { hero }) => apply(api, await ownHero(api, hero)),
					form: {
						title: `Use: ${info(id).name}`,
						fields: [heroField],
						submitLabel: submit,
						async prepare(api) {
							const list: Hero[] = [];
							for (const h of await heroes.list(api, api.playerId)) if (await pick(api, h)) list.push(h);
							return list.length ? { options: { hero: heroOptions(list) } } : false;
						},
					},
				},
			});

		for (const u of USES) {
			if (u.effect === 'resources') {
				if (!resources.list().some((r) => r.id === u.target)) throw new PluginError(`uses.csv: unknown resource "${u.target}"`);
				items.define<{ settlement: string }>({
					...info(u.id),
					use: {
						parse: (raw) => ({ settlement: str((raw as Record<string, unknown> | null)?.settlement, 'settlement') }),
						async apply(api, { settlement }) {
							const s = await settlements.requireOwned(api, settlement);
							await resources.add(api, settlements.entity(s.id), u.target, u.amount);
						},
						form: {
							title: `Use: ${info(u.id).name}`,
							fields: [settlementField],
							submitLabel: 'Use',
							async prepare(api, params) {
								const s = await settlements.resolve(api, params);
								return s ? { defaults: { settlement: s.id } } : false;
							},
						},
					},
				});
			} else if (u.effect === 'speedup') {
				const speedUp = speedUps[u.target];
				if (!speedUp) throw new PluginError(`uses.csv: unknown speed-up "${u.target}"`);
				items.define<{ settlement: string }>({
					...info(u.id),
					use: {
						parse: (raw) => ({ settlement: str((raw as Record<string, unknown> | null)?.settlement, 'settlement') }),
						async apply(api, { settlement }) {
							const s = await settlements.requireOwned(api, settlement);
							if (!(await speedUp(api, s.id, numberInRange(0, 1e9)(u.amount)))) throw new GameError('blocked', 'Nothing to speed up here');
						},
						form: {
							title: `Use: ${info(u.id).name}`,
							fields: [settlementField],
							submitLabel: 'Use',
							async prepare(api, params) {
								const s = await settlements.resolve(api, params);
								return s ? { defaults: { settlement: s.id } } : false;
							},
						},
					},
				});
			} else if (u.effect === 'boost') {
				items.define<{ settlement: string }>({
					...info(u.id),
					use: {
						parse: (raw) => ({ settlement: str((raw as Record<string, unknown> | null)?.settlement, 'settlement') }),
						async apply(api, { settlement }) {
							const s = await settlements.requireOwned(api, settlement);
							const holder = settlements.entity(s.id);
							const b = await loadBoost(api, s.id);
							const hours = boostRule.get(api).hours;
							// A new boost changes the rate: bank production at the old one first. Another one only extends it.
							if (!b.row) await resources.settle(api, holder);
							else timeline.cancelWhere(api, holder, BOOST_END, { settlementId: s.id });
							b.row = { percent: b.row?.percent ?? u.amount, until: Math.max(b.row?.until ?? 0, api.now) + hours * 3600_000 };
							api.write(
								api.db
									.prepare(
										'INSERT INTO starter_items_boosts (settlement_id, percent, until) VALUES (?, ?, ?) ON CONFLICT (settlement_id) DO UPDATE SET percent = excluded.percent, until = excluded.until',
									)
									.bind(s.id, b.row.percent, b.row.until),
							);
							timeline.schedule(api, holder, b.row.until, BOOST_END, { settlementId: s.id });
						},
						form: {
							title: `Use: ${info(u.id).name}`,
							fields: [settlementField],
							submitLabel: 'Use',
							async prepare(api, params) {
								const s = await settlements.resolve(api, params);
								if (!s) return false;
								const { row } = await loadBoost(api, s.id);
								return {
									defaults: { settlement: s.id },
									...(row ? { description: `Boosted until ${new Date(row.until).toISOString().slice(0, 16).replace('T', ' ')} UTC` } : {}),
								};
							},
						},
					},
				});
			} else if (u.effect === 'heal') {
				heroItem(
					u.id,
					(api, h) => realms.isInjured(api, h.id),
					(api, h) => realms.healNow(api, h.id),
					'Heal',
				);
			} else if (u.effect === 'exp') {
				heroItem(
					u.id,
					(api, h) => heroes.expToNext(api, h.level) !== null,
					async (api, h) => {
						if (heroes.expToNext(api, h.level) === null) throw new GameError('blocked', 'That hero is at the highest level');
						await heroes.grantExp(api, h.id, u.amount);
					},
					'Read',
				);
			} else if (u.effect === 'respec') {
				heroItem(
					u.id,
					(_api, h) => Object.values(h.alloc).some((n) => n > 0),
					(api, h) => heroes.resetFree(api, h.id),
					'Take',
				);
			} else throw new PluginError(`uses.csv: unknown effect "${u.effect}" (${u.id})`);
		}
	},
});
