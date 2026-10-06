// A year of a player who looks in four times a day (user 2026-10-06: "再模拟每天上线，坚持玩一年，记录每个月都可以干
// 什么"). Each visit it does what it can: fills the build queue with the cheapest useful upgrade, keeps research going,
// recruits heroes and sends them on the best adventures they clear (healing, points, gear, keys), turns levy orders
// into quota and trains the best units its camps and quota allow, uses vouchers, experience books and breakthrough
// stones, and raids the NPC camps around its capital that its army beats surely. Prints a line a month.
import { csvRows } from '../../src/kernel';
import { wrap } from '../../src/plugins/world-map';
import type { EquipmentBag, HeroCandidates, HeroInfo, ItemStack, RealmsOverview } from '../../src/shared/api';
import { margin } from '../../src/shared/realms';
import techsCsv from '../../src/plugins/starter-research/data/techs.csv?raw';
import levelsCsv from '../../src/plugins/npc-camps/data/levels.csv?raw';
import { db, player, T0 } from '../helpers';
import { asPlayed, H, options, type Pick } from './bot';

const DAY = 24 * H;
const VISITS = [8, 13, 19, 23]; // hours of the day
const TECHS = csvRows(techsCsv).map((r) => r.id);
/** Techs that open higher levels of resource buildings, storage and barracks. */
const GATES = ['agriculture', 'forestry', 'masonry', 'metallurgy', 'mining', 'regiments', 'archery', 'horse-breeding'];
const RESOURCE = ['farm', 'lumber-mill', 'quarry', 'ironworks', 'gold-mine'];
const CAMPS: Record<string, string> = { barracks: 'infantry', 'archer-camp': 'archer', 'cavalry-camp': 'cavalry' };
/** Barracks level needed for each tier (starter-army barracksLevels). */
const TIER_AT = [0, 1, 5, 10, 15];
/** Total attributes against tier 1, by tier (gameplay.md §2.5.3): upkeep is 1.5 x this^0.8 an hour. */
const RATIO = [0, 1, 2.15, 6.24, 18.67, 57.4, 181.1];
/** Rough strength of a unit by tier (total attributes x2 at tier 2, then x2.5 a tier). */
const POWER = [0, 1, 2, 5, 12.5, 31, 78];
/** The other buildings' level as a share of the resource buildings' (built at least once). */
const TARGET: Record<string, number> = {
	palace: 0.8,
	institute: 0.6,
	barracks: 0.8,
	'archer-camp': 0.8,
	'cavalry-camp': 0.8,
	tavern: 0.6,
	academy: 0.5,
	'music-house': 0.5,
	'hidden-store': 0.4,
};
const ADV = ['adv.attack', 'adv.defense', 'adv.hp', 'adv.recovery'];

/** NPC garrisons' strength (five lanes, tiers by POWER, heroes' attack bonus), by kind and level. */
const GARRISON = new Map<string, number>();
for (const r of csvRows(levelsCsv)) {
	const perLane = r.lane.split(';').reduce((a, x) => {
		const [t, n] = x.split(':').map((v) => Number(v.trim()));
		return a + n * POWER[t];
	}, 0);
	GARRISON.set(`${r.kind}:${r.level}`, perLane * 5 * (1 + Number(r.heroAttack || 0) / 100) + Number(r.stockade) * 5);
}

interface Month {
	built: number;
	researched: number;
	adventures: number;
	raids: number;
	raidLoot: number;
	captured: number;
	levies: number;
	quotaUsed: number;
	stones: number;
	trained: Record<number, number>;
	replaced: number;
	full: number;
	visits: number;
	parties: number;
}
const fresh = (): Month => ({
	built: 0,
	researched: 0,
	adventures: 0,
	raids: 0,
	raidLoot: 0,
	captured: 0,
	levies: 0,
	quotaUsed: 0,
	stones: 0,
	trained: {},
	replaced: 0,
	full: 0,
	visits: 0,
	parties: 0,
});

/** Time spent by kind of call (test/sim/profile.sim.ts). */
export const timing = new Map<string, { n: number; ms: number }>();
const timed =
	<A extends unknown[], R>(kind: (...a: A) => string, f: (...a: A) => Promise<R>) =>
	async (...a: A): Promise<R> => {
		const t = performance.now();
		try {
			return await f(...a);
		} finally {
			const k = kind(...a);
			const e = timing.get(k) ?? { n: 0, ms: 0 };
			e.n++;
			e.ms += performance.now() - t;
			timing.set(k, e);
		}
	};

export async function year(days = 365) {
	const raw = player({ ...asPlayed, 'npc-camps.starterCamps': [] });
	const p = {
		...raw,
		run: timed(
			(_now: number, type: string, _payload?: unknown, _privileged?: boolean) => `run ${type.startsWith('items.use') ? 'items.use' : type}`,
			raw.run,
		),
		views: timed((_now: number, ids: string[], _params?: Record<string, string>) => `view ${ids.join(',')}`, raw.views),
		detail: timed((_now: number, _s?: string) => 'detail', raw.detail),
		pool: timed((_now: number, _s?: string) => 'pool', raw.pool),
		construct: timed((_now: number, _s: string, _d: string, _slot: number, _b?: string) => 'construct', raw.construct),
	};
	const c = await p.start();
	// Camps around the capital: one outpost and one fortress of every level, 3-9 tiles away.
	let k = 0;
	for (let level = 1; level <= 10; level++)
		for (const kind of ['npc-outpost', 'npc-fortress']) {
			for (let tries = 0; tries < 20; tries++) {
				const angle = (k++ * 2.4) % (2 * Math.PI);
				const r = 3 + ((level - 1) * 6) / 9;
				const at = { x: wrap(Math.round(c.x + r * Math.cos(angle))), y: wrap(Math.round(c.y + r * Math.sin(angle))) };
				try {
					await p.run(T0, 'npc-camps.spawnAt', { kind, ...at, level }, true);
					break;
				} catch {
					// taken: another spot
				}
			}
		}
	const camps = (
		await db
			.prepare(
				`SELECT s.id, s.kind, s.x, s.y, l.level FROM settlements_settlements s JOIN npc_camps_levels l ON l.settlement_id = s.id
				 WHERE s.owner_id IS NULL AND abs(s.x - ?) <= 12 AND abs(s.y - ?) <= 12`,
			)
			.bind(c.x, c.y)
			.all<{ id: string; kind: string; x: number; y: number; level: number }>()
	).results;
	const raidedAt = new Map<string, number>();
	const levels = new Map<string, number>();
	const out: string[] = [];
	let m = fresh();
	const seen = new Set<string>();

	for (let day = 0; day < days; day++)
		// New players look in often: every hour the first three days, then four times a day.
		for (const hour of day < 3 ? Array.from({ length: 16 }, (_, i) => 7 + i) : VISITS) {
			const now = T0 + day * DAY + hour * H;
			await p.run(now, 'realms.sync').catch(() => {});
			await p.run(now, 'armies.sync').catch(() => {});

			// Build: resource buildings level by level (the least produced resource first); the others follow at a share of
			// their level (TARGET); storage when it holds less than 8 hours. Until the queue is full.
			for (let i = 0; i < 6; i++) {
				const d = await p.detail(now);
				if (d.limits.queueUsed >= d.limits.queue) break;
				const pool = await p.pool(now);
				const all = options(d);
				const placedNow = d.districts.flatMap((x) => x.slots.flatMap((s) => (s.current ? [s.current] : [])));
				const top = (b: string) => Math.max(0, ...placedNow.filter((x) => x.building === b).map((x) => x.level));
				const resLevel = Math.max(1, ...RESOURCE.map(top));
				const produces = (b: string) => Object.keys(all.find((x) => x.option.building === b)?.option.effects.produces ?? {})[0];
				const rate = (b: string) => (pool.rates[produces(b)] ?? 0) / (b === 'ironworks' || b === 'gold-mine' ? 0.4 : 1);
				const wanted: Pick[] = [];
				const best = Math.max(...Object.values(pool.rates));
				if (pool.capacity < best * 4 * 3600)
					wanted.push(...all.filter((x) => x.option.building === 'warehouse').sort((a, b) => b.option.level - a.option.level));
				for (const [b, share] of Object.entries(TARGET))
					if (top(b) < Math.floor(resLevel * share) || top(b) === 0)
						wanted.push(...all.filter((x) => x.option.building === b).sort((a, b2) => a.option.level - b2.option.level));
				wanted.push(
					...all
						.filter((x) => RESOURCE.includes(x.option.building))
						.sort((a, b) => a.option.level - b.option.level || rate(a.option.building) - rate(b.option.building)),
				);
				const pick = wanted.find((x) => x.option.affordable);
				if (!pick) break;
				await p.construct(now, d.id, pick.district, pick.slot, pick.option.building);
				m.built++;
			}
			// An outer city whenever allowed and affordable.
			const d = await p.detail(now);
			if (d.nextOuter && !d.nextOuter.blocked && d.nextOuter.candidates[0])
				await p
					.run(now, 'settlements.addOuter', { settlement: c.id, ...d.nextOuter.candidates[0] })
					.then(() => m.built++)
					.catch(() => {});
			// Research: the gates of resource buildings and barracks first, then the tech with the fewest levels so far.
			if (!((await p.views(now, ['research.queue']))['research.queue'] as { items: unknown[] }).items.length) {
				const order = [...TECHS].sort(
					(a, b) => (levels.get(a) ?? 0) + (GATES.includes(a) ? -100 : 0) - ((levels.get(b) ?? 0) + (GATES.includes(b) ? -100 : 0)),
				);
				for (const tech of order)
					if (
						await p
							.run(now, 'research.start', { tech, settlement: c.id })
							.then(() => true)
							.catch(() => false)
					) {
						levels.set(tech, (levels.get(tech) ?? 0) + 1);
						m.researched++;
						break;
					}
			}

			// Items: levy orders into quota, vouchers into the capital, books into the lowest hero, stones on capped buildings.
			const items = (await p.views(now, ['items.inventory']))['items.inventory'] as ItemStack[];
			const heroes = (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];
			const lowest = [...heroes].sort((a, b) => a.level - b.level)[0];
			for (const it of items)
				for (let n = 0; n < it.count; n++) {
					const id = it.id;
					if (id.startsWith('levy-'))
						await p
							.run(now, `items.use.${id}`, null)
							.then(() => m.levies++)
							.catch(() => {});
					else if (id.endsWith('-voucher')) await p.run(now, `items.use.${id}`, { settlement: c.id }).catch(() => {});
					else if (['field-notes', 'manual-scrap', 'war-manual'].includes(id) && lowest)
						await p.run(now, `items.use.${id}`, { hero: lowest.id }).catch(() => {});
					else if (id.startsWith('realm-key-')) await p.run(now, `items.use.${id}`, { action: 'unlock' }).catch(() => {});
					else if (id === 'breakthrough-stone') {
						const capped = d.districts.flatMap((x) =>
							x.slots
								.filter((s) => s.current && RESOURCE.includes(s.current.building) && s.current.level >= s.current.cap)
								.map((s) => `${x.id}:${s.slot}`),
						)[0];
						if (capped)
							await p
								.run(now, 'items.use.breakthrough-stone', { settlement: c.id, target: capped })
								.then(() => m.stones++)
								.catch(() => {});
					}
				}

			// Heroes: recruit up to the cap, then keep each adventuring.
			// The best candidate of every venue here (what adventures value: might x2 + leadership, its talents counting
			// for the levels ahead); with the roster full, it replaces the weakest hero if clearly better born.
			const worth = (attrs: Record<string, number>, talents?: Record<string, number> | null) =>
				2 * (attrs.might ?? 0) + (attrs.leadership ?? 0) + 30 * (2 * (talents?.might ?? 0) + (talents?.leadership ?? 0));
			const born = (h: HeroInfo) =>
				Object.fromEntries(Object.entries(h.attrs).map(([a, v]) => [a, v - (h.alloc?.[a] ?? 0) - (h.talents?.[a] ?? 0) * (h.level - 1)]));
			const offers = (await p.views(now, ['heroes.candidates'], { settlement: c.id }))['heroes.candidates'] as HeroCandidates[];
			const bestOffer = offers
				.flatMap((o) =>
					o.candidates.flatMap((x) => (x && x.slot >= 0 ? [{ venue: o.venue, slot: x.slot, w: worth(x.attrs, x.talents) }] : [])),
				)
				.sort((a, b) => b.w - a.w)[0];
			if (bestOffer) {
				const mine = (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];
				const recruit = () =>
					p
						.run(now, 'heroes.recruit', { settlement: c.id, venue: bestOffer.venue, slot: bestOffer.slot })
						.then(() => true)
						.catch(() => false);
				if (!(await recruit())) {
					const weakest = [...mine].sort((a, b) => worth(born(a), a.talents) - worth(born(b), b.talents))[0];
					if (weakest && bestOffer.w > 1.3 * worth(born(weakest), weakest.talents))
						if (
							await p
								.run(now, 'heroes.dismiss', { hero: weakest.id })
								.then(() => true)
								.catch(() => false)
						)
							if (await recruit()) m.replaced++;
				}
			}
			const o = (await p.views(now, ['realms.overview']))['realms.overview'] as RealmsOverview;
			const bag = (await p.views(now, ['equipment.bag']))['equipment.bag'] as EquipmentBag;
			const taken = new Set<string>();
			// Storage full of plain pieces: smelt the white and green ones nobody wears.
			if (bag.pieces.filter((x) => x.hero === null).length > 40)
				for (const rarity of ['white', 'green']) await p.run(now, 'equipment.smeltMany', { settlement: c.id, rarity }).catch(() => {});
			for (const h of (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[]) {
				if (h.freePoints > 0) {
					const half = Math.floor(h.freePoints / 2);
					await p.run(now, 'heroes.allocate', { hero: h.id, points: { might: h.freePoints - half, leadership: half } }).catch(() => {});
				}
				// The best free piece for each slot, one hero at a time (a piece goes to one hero; worn ones stay).
				const score = (x: EquipmentBag['pieces'][number]) =>
					ADV.reduce((acc, st) => acc + (x.stats[st] ?? 0) * (st === 'adv.hp' ? 0.1 : 1), 0);
				const worn = new Map(bag.pieces.filter((x) => x.hero === h.id).map((x) => [x.slot, x]));
				for (const piece of bag.pieces) {
					if (piece.hero !== null || taken.has(piece.id) || (piece.minLevel && piece.minLevel > h.level)) continue;
					const now2 = worn.get(piece.slot);
					if (now2 && score(now2) >= score(piece)) continue;
					if (
						await p
							.run(now, 'equipment.equip', { piece: piece.id, hero: h.id })
							.then(() => true)
							.catch(() => false)
					) {
						taken.add(piece.id);
						worn.set(piece.slot, piece);
					}
				}
				const hurt = o.injured.find((x) => x.hero === h.id);
				if (hurt) {
					if (hurt.healingUntil === null) await p.run(now, 'realms.heal', { hero: h.id }).catch(() => {});
					continue;
				}
				if (o.adventures.some((a) => a.hero === h.id)) continue;
				const stats = o.heroStats[h.id];
				let pick: { realm: string; task: number; v: number } | null = null;
				for (const r of o.realms.filter((x) => x.unlocked))
					for (const t of r.tasks) {
						const v = t.exp.reduce((a, b) => a + b, 0) / t.groups.length;
						if (stats && margin(stats, t.groups, o.minDamage) >= o.outlook.even && (!pick || v > pick.v))
							pick = { realm: r.id, task: t.index, v };
					}
				pick ??= { realm: o.realms[0].id, task: 0, v: 0 };
				if (
					await p
						.run(now, 'realms.adventure', { hero: h.id, realm: pick.realm, task: pick.task })
						.then(() => true)
						.catch(() => false)
				)
					m.adventures++;
			}

			// Train: the best tier each camp and the quota allow, from stock above half the cap, while currency still grows.
			const pool = await p.pool(now);
			const placed = d.districts.flatMap((x) => x.slots.flatMap((s) => (s.current ? [s.current] : [])));
			const spare = Math.min(...Object.values(pool.amounts)) - pool.capacity * 0.5;
			// Upkeep against gross production: a player stops growing the army before it eats more than 40%.
			const army0 = (
				await db
					.prepare('SELECT unit, count FROM troops_garrison WHERE settlement_id = ? AND count > 0')
					.bind(c.id)
					.all<{ unit: string; count: number }>()
			).results;
			const upkeep = army0.reduce((a, g) => a + g.count * 1.5 * RATIO[Number(g.unit.split('-')[1]) || 1] ** 0.8, 0) / 3600;
			const gross = Object.values(pool.rates).reduce((x, y) => x + y, 0) + upkeep;
			if (Object.values(pool.amounts).some((v) => v >= pool.capacity * 0.99)) m.full++;
			m.visits++;
			const heavy = upkeep > 0.4 * gross || Object.values(pool.rates).some((r) => r < 0);
			if (spare > 0 && !heavy)
				for (const [camp, family] of Object.entries(CAMPS)) {
					const level = Math.max(0, ...placed.filter((x) => x.building === camp).map((x) => x.level));
					for (let tier = 4; tier >= 1; tier--) {
						if (level < TIER_AT[tier]) continue;
						let done = false;
						for (const n of [2000, 500, 100, 20])
							if (
								await p
									.run(now, 'troops.train', { settlement: c.id, unit: `${family}-${tier}`, count: n })
									.then(() => true)
									.catch(() => false)
							) {
								m.trained[tier] = (m.trained[tier] ?? 0) + n;
								if (tier > 1) m.quotaUsed += n;
								done = true;
								break;
							}
						if (done) break;
					}
				}

			// Raids: several parties at once (user 2026-10-06: "让模拟玩家每次上线同时多派出几支部队去刷营寨资源"). Refilled camps
			// from the strongest down; each gets a share of what is left of every unit, 4x its garrison's strength.
			const garrison = (
				await db
					.prepare('SELECT unit, count FROM troops_garrison WHERE settlement_id = ? AND count > 0')
					.bind(c.id)
					.all<{ unit: string; count: number }>()
			).results.filter((g) => g.unit.includes('-'));
			const left = new Map(garrison.map((g) => [g.unit, g.count]));
			const strength = () => [...left].reduce((a, [u, n]) => a + n * POWER[Number(u.split('-')[1]) || 1], 0);
			const ready = camps
				// Fortresses bring troops (and their upkeep): not while the army already eats too much.
				.filter((x) => !(heavy && x.kind === 'npc-fortress') && now - (raidedAt.get(x.id) ?? -Infinity) >= 8 * H)
				.sort((a, b) => b.level - a.level);
			for (const target of ready) {
				const needed = 4 * (GARRISON.get(`${target.kind}:${target.level}`) ?? Infinity);
				const have = strength();
				if (have < needed || have <= 0) continue;
				const share = needed / have;
				const units = Object.fromEntries(
					[...left].map(([u, n]) => [u, Math.min(n, Math.ceil(n * share))]).filter(([, n]) => (n as number) > 0),
				);
				if (
					!(await p
						.run(now, 'armies.send', { from: c.id, x: target.x, y: target.y, units })
						.then(() => true)
						.catch(() => false))
				)
					continue;
				for (const [u, n] of Object.entries(units)) left.set(u, (left.get(u) ?? 0) - (n as number));
				raidedAt.set(target.id, now);
				m.parties++;
				const sent = ((await p.views(now, ['armies.list']))['armies.list'] as { id: string; arrivesAt: number }[]).filter(
					(a) => !seen.has(a.id),
				);
				for (const a of sent) {
					seen.add(a.id);
					const there = (
						(await p.views(a.arrivesAt + 1, ['armies.list']))['armies.list'] as {
							id: string;
							report?: { outcome: string; loot: Record<string, number>; captured: Record<string, number> } | null;
						}[]
					).find((x) => x.id === a.id);
					if (there?.report?.outcome === 'victory') {
						m.raids++;
						m.raidLoot += Object.values(there.report.loot).reduce((x, y) => x + y, 0);
						m.captured += Object.values(there.report.captured).reduce((x, y) => x + y, 0);
					}
				}
			}

			// A line a month.
			if (hour === (day < 3 ? 22 : VISITS.at(-1)) && (day + 1) % 30 === 0) {
				const dd = await p.detail(now);
				const top: Record<string, number> = {};
				for (const x of dd.districts)
					for (const s of x.slots) if (s.current) top[s.current.building] = Math.max(top[s.current.building] ?? 0, s.current.level);
				const hs = ((await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[]).map((h) => h.level).sort((a, b) => b - a);
				const o2 = (await p.views(now, ['realms.overview']))['realms.overview'] as RealmsOverview;
				const perHour = Object.values(pool.rates).reduce((a, b) => a + b, 0) * 3600;
				const g2 = garrison.reduce<Record<string, number>>(
					(a, g) => ({ ...a, [`t${g.unit.split('-')[1]}`]: (a[`t${g.unit.split('-')[1]}`] ?? 0) + g.count }),
					{},
				);
				// The next level of the best farm: its cost in days of production, and what it adds.
				const farm = dd.districts
					.flatMap((x) => x.slots)
					.filter((s) => s.current?.building === 'farm')
					.sort((a, b) => b.current!.level - a.current!.level)[0];
				const next = farm?.options[0];
				const nextCost = next ? Object.values(next.cost).reduce((a, b) => a + b, 0) : 0;
				// The next level of core buildings: against the capital's storage and a week's raids.
				const core = (b: string) => {
					const slot = dd.districts.flatMap((x) => x.slots).find((s) => s.current?.building === b);
					const o = slot?.options[0];
					if (!o) return `${b} -`;
					const cost = Object.values(o.cost).reduce((a, x) => a + x, 0);
					return `${b} ${slot!.current!.level}->${o.level}: ${(cost / 1e6).toFixed(1)}M (${(cost / pool.capacity / 5).toFixed(1)}x storage, ${(cost / Math.max(1, m.raidLoot / 4)).toFixed(1)} weeks of raids, ${(o.seconds / 3600).toFixed(0)} h)`;
				};
				out.push(
					`month ${(day + 1) / 30}: built ${m.built}, research ${m.researched}, production ${Math.round(gross * 3600)}/h gross, ${Math.round(perHour)}/h net (upkeep ${Math.round(upkeep * 3600)}/h), cap ${Math.round(pool.capacity)} (a resource full at ${Math.round((m.full / Math.max(1, m.visits)) * 100)}% of visits)` +
						`\n    ${core('palace')}; ${core('barracks')}` +
						`\n    top levels ${JSON.stringify(top)}, outer cities ${dd.districts.length - 1}` +
						`\n    heroes ${hs.join(',')} (replaced ${m.replaced}), realms open ${o2.realms.filter((r) => r.unlocked).length}, adventures ${m.adventures}` +
						`\n    army ${JSON.stringify(g2)}, trained ${JSON.stringify(m.trained)}, levies used ${m.levies} (quota spent ${m.quotaUsed}), stones ${m.stones}` +
						`\n    raids ${m.raids} won of ${m.parties} sent, loot ${m.raidLoot} (${(m.raidLoot / Math.max(1, perHour * 24 * 30)).toFixed(3)} of the month's production), captured ${m.captured}` +
						`\n    next farm level ${farm?.current?.level ?? 0}->${next?.level ?? '-'}: ${nextCost} (${(nextCost / Math.max(1, perHour)).toFixed(1)} h of production, ${(nextCost / Math.max(1, m.raidLoot / 4)).toFixed(1)} weeks of raids), ${next?.seconds ? (next.seconds / 3600).toFixed(1) + ' h to build' : ''}${next?.blocked ? ` (blocked: ${JSON.stringify(next.blocked)})` : ''}` +
						`\n    techs ${JSON.stringify(Object.fromEntries(levels))}`,
				);
				// As it goes, so a long run can be followed (pnpm sim prints console output as it comes).
				console.log(out.at(-1));
				m = fresh();
			}
		}
	return out;
}
