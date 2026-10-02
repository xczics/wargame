/**
 * Default items (names and numbers in ./data), each using an extension point the core systems left for items:
 *   expansion-permit    may raise a settlement's outer-city quota by one past the research limit
 *   breakthrough-stone  may raise one building's level cap by one
 *   land-grant          may add a building slot to an outer city
 *   *-charter           may raise how many cities / fortresses the player may found by one (cities: never past 20)
 * ("may": a chance that falls as the target grows, sure after a run of failures — ./data/chances.csv)
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
import type { Placed } from '../buildings';
import chancesCsv from './data/chances.csv?raw';
import itemsCsv from './data/items.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import usesCsv from './data/uses.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

/** Names, icons and descriptions by item id (./data/items.csv). */
const INFO = new Map(
	csvRows(itemsCsv).map((r) => [
		r.id,
		{
			name: r.name,
			icon: r.icon || undefined,
			description: r.description || undefined,
			category: r.category || undefined,
			shortcuts: r.shortcuts
				? r.shortcuts
						.split(';')
						.map((x) => x.trim())
						.filter(Boolean)
				: undefined,
		},
	]),
);
const RULES = csvRules(rulesCsv);
/** "May raise" items: chance = base x e^(-rate x (n - normal)), sure on the pity-th try in a row (./data/chances.csv). */
const CHANCES: Record<string, { base: number; rate: number; normal: number; pity: number }> = Object.fromEntries(
	csvRows(chancesCsv).map((r) => [
		r.item,
		{ base: csvNumber(r, 'base'), rate: csvNumber(r, 'rate'), normal: csvNumber(r, 'normal'), pity: csvNumber(r, 'pity') },
	]),
);
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
	dependsOn: [
		'items',
		'settlements',
		'buildings',
		'mail',
		'resources',
		'stats',
		'timeline',
		'troops',
		'research',
		'heroes',
		'realms',
		'i18n',
	],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const items = ctx.services.get('items');
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const stats = ctx.services.get('stats');
		const mail = ctx.services.get('mail');
		const pityRule = ctx.config.define('pity', {
			description: 'days: failed attempts of "may raise" items on a target are forgotten this many days after the last one.',
			default: () => RULES.pity as { days: number },
			parse: numberFields(() => RULES.pity as { days: number }, 0, 365),
		});
		const chances = ctx.config.define('chances', {
			description:
				'"May raise" items: chance = base x e^(-rate x (n - normal)) (n = how far the target already is above normal), sure on the pity-th try in a row (pity 0 = ceil(1 / chance), the expected number of tries). By item, partial.',
			default: () => CHANCES,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { item: { base, rate, normal, pity } }');
				const out = structuredClone(CHANCES);
				for (const [item, v] of Object.entries(raw as Record<string, unknown>)) {
					if (!out[item]) throw new GameError('bad_config', `Unknown item "${item}"`);
					const c = numberFields(() => CHANCES[item], 0, 1000)(v);
					if (c.base > 1) throw new GameError('bad_config', `${item}: base is a share (0-1)`);
					out[item] = c;
				}
				return out;
			},
		});
		const loadPity = (api: ReadApi, target: string) =>
			api.memo(`starter-items:pity:${api.playerId}:${target}`, async () => {
				const row = await api.db
					.prepare('SELECT fails, expires_at FROM starter_items_pity WHERE player_id = ? AND target = ?')
					.bind(api.playerId, target)
					.first<{ fails: number; expires_at: number }>();
				return { fails: row && row.expires_at > api.now ? row.fails : 0 };
			});
		/** Chance now and the failures counted towards the pity rule, for a target `n` above normal. */
		async function odds(api: ReadApi, item: string, target: string, n: number) {
			const c = chances.get(api)[item];
			const { fails } = await loadPity(api, target);
			const chance = Math.min(1, c.base * Math.exp(-c.rate * Math.max(0, n - c.normal)));
			// Pity: by default the expected number of tries (1% -> sure by the 100th); the GM may fix it instead.
			const pity = c.pity > 0 ? c.pity : chance > 0 ? Math.ceil(1 / chance) : 0;
			const sure = pity > 0 && fails >= pity - 1;
			return { chance: sure ? 1 : chance, fails, pity };
		}
		/** For form labels: the pity progress, and the chance only for the GM (players do not see odds). */
		const describe = (api: ReadApi, o: { chance: number; fails: number; pity: number }) =>
			[api.gmViewer ? `${Math.round(o.chance * 100)}%` : '', o.pity ? `pity ${o.fails}/${o.pity}` : ''].filter(Boolean).join(' · ');
		/** Roll; count a failure (or clear the count on success) and tell the player how it went. */
		async function attempt(api: EngineApi, item: string, target: string, n: number, what: string) {
			const o = await odds(api, item, target, n);
			const ok = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 < o.chance;
			const state = await loadPity(api, target);
			state.fails = ok ? 0 : state.fails + 1;
			api.write(
				ok
					? api.db.prepare('DELETE FROM starter_items_pity WHERE player_id = ? AND target = ?').bind(api.playerId, target)
					: api.db
							.prepare(
								`INSERT INTO starter_items_pity (player_id, target, fails, expires_at) VALUES (?, ?, ?, ?)
								 ON CONFLICT (player_id, target) DO UPDATE SET fails = excluded.fails, expires_at = excluded.expires_at`,
							)
							.bind(api.playerId, target, state.fails, api.now + pityRule.get(api).days * 86_400_000),
			);
			mail.send(api, api.playerId, {
				kind: 'starter-items.attempt',
				title: ok ? '{item} worked: {what}' : '{item} failed: {what} (pity {fails}/{pity})',
				vars: { item: info(item).name, what, fails: state.fails, pity: o.pity },
			});
			return ok;
		}
		// Forgotten failures go.
		ctx.tasks.add({
			id: 'starter-items.pity',
			async run({ env }) {
				await env.DB.prepare('DELETE FROM starter_items_pity WHERE expires_at < ?').bind(Date.now()).run();
			},
		});

		// Outer-city quota won with permits counts towards the research limit (never past the hard limit).
		const loadOuter = (api: ReadApi, settlementId: string) =>
			api.memo(`starter-items:outer:${settlementId}`, async () => ({
				extra:
					(
						await api.db
							.prepare('SELECT extra FROM starter_items_outer WHERE settlement_id = ?')
							.bind(settlementId)
							.first<{ extra: number }>()
					)?.extra ?? 0,
			}));
		stats.contribute('settlements.outer.tech', async (api, target) =>
			target.startsWith('settlement:') ? { flat: (await loadOuter(api, target.slice('settlement:'.length))).extra } : null,
		);

		items.define<{ settlement: string }>({
			...info('expansion-permit'),
			use: {
				parse: (raw) => ({ settlement: str((raw as Record<string, unknown> | null)?.settlement, 'settlement') }),
				async apply(api, { settlement }) {
					const s = await settlements.requireOwned(api, settlement);
					if (settlements.kind(s.kind).layout !== 'ring') throw new GameError('bad_target', 'Only capitals and cities have outer cities');
					const entity = settlements.entity(s.id);
					if ((await stats.get(api, 'settlements.outer.tech', entity)) >= (await stats.get(api, 'settlements.outer.hard', entity)))
						throw new GameError('blocked', 'Outer city limit reached');
					const o = await loadOuter(api, s.id);
					if (await attempt(api, 'expansion-permit', `outer:${s.id}`, o.extra, s.name)) {
						o.extra++;
						api.write(
							api.db
								.prepare(
									'INSERT INTO starter_items_outer (settlement_id, extra) VALUES (?, ?) ON CONFLICT (settlement_id) DO UPDATE SET extra = excluded.extra',
								)
								.bind(s.id, o.extra),
						);
					}
				},
				form: {
					title: 'Use an expansion permit',
					fields: [{ name: 'settlement', label: 'settlement', type: 'hidden' }],
					submitLabel: 'Try',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s || settlements.kind(s.kind).layout !== 'ring') return false;
						const o = await odds(api, 'expansion-permit', `outer:${s.id}`, (await loadOuter(api, s.id)).extra);
						return { defaults: { settlement: s.id }, description: `${s.name}: ${describe(api, o)}` };
					},
				},
			},
		});

		/** How many levels a placed building's cap is above its regular one. */
		const aboveCap = async (api: EngineApi, settlementId: string, p: Placed) =>
			p.cap === null
				? 0
				: Math.max(0, (await buildings.capOf(api, settlementId, p)) - (await buildings.capOf(api, settlementId, { ...p, cap: null })));
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
					const p = (await buildings.placed(api, s.id)).get(district)?.get(slot);
					if (!p) throw new GameError('not_found', 'No building there', 404);
					const name = buildings.get(p.building).name;
					if (await attempt(api, 'breakthrough-stone', `cap:${s.id}:${district}:${slot}`, await aboveCap(api, s.id, p), name))
						await buildings.raiseCap(api, s.id, district, slot, 1);
				},
				form: {
					title: 'Use a breakthrough stone',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'target', label: 'Building', type: 'select', required: true },
					],
					submitLabel: 'Try',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s) return false;
						const placed = await buildings.placed(api, s.id);
						const options: { value: string; label: string }[] = [];
						for (const d of s.districts)
							for (const [slot, p] of placed.get(d.id) ?? new Map<number, Placed>()) {
								const o = await odds(api, 'breakthrough-stone', `cap:${s.id}:${d.id}:${slot}`, await aboveCap(api, s.id, p));
								options.push({
									value: `${d.id}:${slot}`,
									label: `${buildings.get(p.building).name} · Lv ${p.level}/${await buildings.capOf(api, s.id, p)} · ${describe(api, o)}`,
								});
							}
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
					if (await attempt(api, 'land-grant', `slot:${s.id}:${d.id}`, d.slots, `${s.name} / outer ${d.idx}`))
						await settlements.addSlots(api, s.id, d.id, 1);
				},
				form: {
					title: 'Use a land grant',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'district', label: 'Outer city', type: 'select', required: true },
					],
					submitLabel: 'Try',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						const outer = s?.districts.filter((d) => d.type === 'outer') ?? [];
						if (!s || !outer.length) return false;
						const options = [];
						for (const d of outer)
							options.push({
								value: d.id,
								label: `Outer city ${d.idx} · ${d.slots} slots · ${describe(api, await odds(api, 'land-grant', `slot:${s.id}:${d.id}`, d.slots))}`,
							});
						return { defaults: { settlement: s.id }, options: { district: options } };
					},
				},
			},
		});

		/* ----- data-driven items (uses.csv) ------------------------------------------------- */

		const resources = ctx.services.get('resources');
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

		// Permanent player stat bonuses won with items (effect "stat"); counted for the player and each of their settlements.
		const loadPlayerStat = (api: ReadApi, playerId: string, stat: string) =>
			api.memo(`starter-items:stat:${playerId}:${stat}`, async () => ({
				amount:
					(
						await api.db
							.prepare('SELECT amount FROM starter_items_stats WHERE player_id = ? AND stat = ?')
							.bind(playerId, stat)
							.first<{ amount: number }>()
					)?.amount ?? 0,
			}));
		const contributedStats = new Set<string>();
		function ensurePlayerStat(stat: string) {
			if (contributedStats.has(stat)) return;
			if (!stats.list().some((x) => x.id === stat)) throw new PluginError(`uses.csv: unknown stat "${stat}"`);
			contributedStats.add(stat);
			stats.contribute(stat, async (api, target) => {
				const owner = target.startsWith('player:')
					? target.slice(7)
					: target.startsWith('settlement:')
						? ((await settlements.get(api, target.slice(11)))?.ownerId ?? null)
						: null;
				if (!owner) return null;
				const { amount } = await loadPlayerStat(api, owner, stat);
				return amount ? { flat: amount } : null;
			});
		}

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
			} else if (u.effect === 'speedup' && u.target === 'training') {
				// Training: one barracks of the settlement (each has its own queue); from a barracks' entry, that one.
				const troops = ctx.services.get('troops');
				items.define<{ settlement: string; barracks: string }>({
					...info(u.id),
					use: {
						parse: (raw) => {
							const r = (raw as Record<string, unknown> | null) ?? {};
							return { settlement: str(r.settlement, 'settlement'), barracks: str(r.barracks, 'barracks') };
						},
						async apply(api, { settlement, barracks }) {
							const s = await settlements.requireOwned(api, settlement);
							if (!(await troops.speedUp(api, s.id, numberInRange(0, 1e9)(u.amount), barracks)))
								throw new GameError('blocked', 'Nothing is training in that barracks');
						},
						form: {
							title: `Use: ${info(u.id).name}`,
							fields: [settlementField, { name: 'barracks', label: 'Barracks', type: 'select', required: true }],
							submitLabel: 'Use',
							async prepare(api, params) {
								const s = await settlements.resolve(api, params);
								if (!s) return false;
								const busy = [...new Set((await troops.queue(api, s.id)).filter((b) => b.startedAt !== null).map((b) => b.line))];
								if (!busy.length) return false;
								const name = (type: string) => buildings.list().find((b) => b.id === type)?.name ?? type;
								return {
									defaults: { settlement: s.id, barracks: busy.includes(params.type ?? '') ? params.type! : busy[0] },
									options: { barracks: busy.map((b) => ({ value: b, label: name(b) })) },
								};
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
			} else if (u.effect === 'stat') {
				ensurePlayerStat(u.target);
				items.define<null>({
					...info(u.id),
					use: {
						parse: () => null,
						async apply(api) {
							const row = await loadPlayerStat(api, api.playerId, u.target);
							row.amount += u.amount;
							api.write(
								api.db
									.prepare(
										'INSERT INTO starter_items_stats (player_id, stat, amount) VALUES (?, ?, ?) ON CONFLICT (player_id, stat) DO UPDATE SET amount = excluded.amount',
									)
									.bind(api.playerId, u.target, row.amount),
							);
						},
						form: { title: `Use: ${info(u.id).name}`, fields: [], submitLabel: 'Use', confirm: `Use one ${info(u.id).name}?` },
					},
				});
			} else throw new PluginError(`uses.csv: unknown effect "${u.effect}" (${u.id})`);
		}

		// Charters raise how many settlements of a kind the player may found; kept as a permanent player stat
		// bonus, so n = how many already won with them. Never past the kind's hard limit, if it has one.
		for (const [item, kind] of [
			['city-charter', 'city'],
			['resource-fortress-charter', 'fortress-resource'],
			['military-fortress-charter', 'fortress-military'],
		]) {
			const stat = `settlements.limit.${kind}`;
			ensurePlayerStat(stat);
			const label = (lim: { limit: number; max: number }) => (Number.isFinite(lim.max) ? `${lim.limit}/${lim.max}` : `${lim.limit}`);
			items.define<null>({
				...info(item),
				use: {
					parse: () => null,
					async apply(api) {
						const lim = await settlements.limitOf(api, api.playerId, kind);
						const name = settlements.kind(kind).name;
						if (!lim) throw new GameError('blocked', `Not limited: ${name}`);
						if (lim.limit >= lim.max) throw new GameError('blocked', `Limit reached: ${name}`);
						const row = await loadPlayerStat(api, api.playerId, stat);
						if (await attempt(api, item, `limit:${kind}`, row.amount, `${name} ${lim.limit} → ${lim.limit + 1}`)) {
							row.amount++;
							api.write(
								api.db
									.prepare(
										'INSERT INTO starter_items_stats (player_id, stat, amount) VALUES (?, ?, ?) ON CONFLICT (player_id, stat) DO UPDATE SET amount = excluded.amount',
									)
									.bind(api.playerId, stat, row.amount),
							);
						}
					},
					form: {
						title: `Use: ${info(item).name}`,
						fields: [],
						submitLabel: 'Try',
						async prepare(api) {
							const lim = await settlements.limitOf(api, api.playerId, kind);
							if (!lim) return false;
							const o = await odds(api, item, `limit:${kind}`, (await loadPlayerStat(api, api.playerId, stat)).amount);
							return { description: `Limit (${settlements.kind(kind).name}): ${label(lim)} · ${describe(api, o)}` };
						},
					},
				},
			});
		}
	},
});
