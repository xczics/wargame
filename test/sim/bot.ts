// A simulated player for balancing (`pnpm sim`): builds greedily, researches, adds outer cities and, with `army`,
// trains tier-1 troops from spare resources and raids the starter camps around its capital once its army is big
// enough to win surely. Plays with the game's own defaults (the test helper's are for mechanics, not balance).
import { resolveConfig } from '../../src/kernel';
import type { BuildOption, MapTile, SettlementDetail } from '../../src/shared/api';
import { db, defaultKernel, player, T0 } from '../helpers';

export const H = 3600_000;
const RESOURCE_BUILDINGS = ['farm', 'lumber-mill', 'quarry', 'ironworks', 'gold-mine'];
const CAMPS = ['barracks', 'archer-camp', 'cavalry-camp'];
const UNITS: Record<string, string> = { barracks: 'infantry-1', 'archer-camp': 'archer-1', 'cavalry-camp': 'cavalry-1' };
/** Tier-1 armies that win surely (5 or 6 battles in 6, test/sim/battle.sim.ts), by kind and level. */
const SURE: Record<string, Record<number, number>> = {
	'npc-outpost': { 1: 4000, 2: 16000, 3: 64000 },
	'npc-fortress': { 1: 8000, 2: 32000, 3: 64000 },
};

export const real = resolveConfig(defaultKernel, {}).values;
export const asPlayed = Object.fromEntries(
	[
		'starter-content.baseProduction',
		'terrain.bonus',
		'buildings.ownResourceFreeUntil',
		'buildings.productionMultiplier',
		'player-settlements.limits',
	].map((k) => [k, real[k]]),
);

interface Raid {
	id: string;
	report?: {
		target: { kind: string };
		outcome: string;
		loot: Record<string, number>;
		captured: Record<string, number>;
		losses: { attacker: Record<string, number> };
	} | null;
}

export interface Pick {
	district: string;
	slot: number;
	option: BuildOption;
}

export const options = (d: SettlementDetail): Pick[] =>
	d.districts.flatMap((district) =>
		district.slots.flatMap((s) => s.options.filter((o) => !o.blocked).map((option) => ({ district: district.id, slot: s.slot, option }))),
	);

/** Seconds until `cost` is affordable at these amounts and rates (Infinity: never at these rates). */
export function waitFor(cost: Record<string, number>, amounts: Record<string, number>, rates: Record<string, number>) {
	let t = 0;
	for (const [r, n] of Object.entries(cost)) {
		const short = n - (amounts[r] ?? 0);
		if (short > 0) t = Math.max(t, (rates[r] ?? 0) > 0 ? short / rates[r] : Infinity);
	}
	return t;
}

export interface Report {
	hour: number;
	built: number;
	researched: number;
	outers: number;
	idle: number;
	capacity: number;
	perHour: Record<string, number>;
	levels: Record<string, string>;
	army: number;
	raids: number;
	raidGains: number;
	captured: number;
	upkeepPerHour: number;
}

export async function play(hours: number[], { army = false } = {}): Promise<Report[]> {
	const p = player(asPlayed);
	const c = await p.start();
	let now = T0;
	const end = T0 + hours.at(-1)! * H;
	let idle = 0;
	let built = 0;
	let researched = 0;
	let outers = 0;
	let raids = 0;
	let raidGains = 0;
	let captured = 0;
	let next = 0;
	const raided = new Map<string, number>();
	const counted = new Set<string>();
	const log: string[] = [];
	const out: Report[] = [];
	const garrison = async () =>
		Object.fromEntries(
			(
				await db
					.prepare('SELECT unit, count FROM troops_garrison WHERE settlement_id = ?')
					.bind(c.id)
					.all<{ unit: string; count: number }>()
			).results.map((r) => [r.unit, r.count]),
		);
	while (now < end) {
		const d = await p.detail(now);
		const pool = await p.pool(now);
		const all = options(d);
		const cap = pool.capacity;
		const placed = d.districts.flatMap((x) => x.slots.flatMap((s) => (s.current ? [s.current] : [])));
		const has = (b: string) => placed.some((x) => x.building === b);

		// The resource produced least (metal and currency are needed less), then the lowest level.
		const produces = (b: string) => Object.keys(all.find((x) => x.option.building === b)?.option.effects.produces ?? {})[0];
		const weight: Record<string, number> = { metal: 0.4, gold: 0.4 };
		const rate = (b: string) => (pool.rates[produces(b)] ?? 0) / (weight[produces(b)] ?? 1);
		const resource = all
			.filter((x) => RESOURCE_BUILDINGS.includes(x.option.building))
			.sort((a, b) => rate(a.option.building) - rate(b.option.building) || a.option.level - b.option.level);
		let want: Pick | undefined = resource[0];
		const first = (b: string) => all.find((x) => x.option.building === b && x.option.level === 1);
		if (built >= 10 && first('institute')) want = first('institute');
		else if (army && built >= 15) want = CAMPS.map(first).find(Boolean) ?? want;
		const palace = all.find((x) => x.option.building === 'palace');
		if (palace && (!want || palace.option.level <= Math.floor(want.option.level / 2) + 1)) want = palace;
		// Storage for a night away (4 hours of the best production), and room for what we want.
		const best = Math.max(...Object.values(pool.rates));
		if (want && (Math.max(...Object.values(want.option.cost)) > cap * 0.9 || cap < best * 4 * 3600))
			want = all.filter((x) => x.option.building === 'warehouse').sort((a, b) => a.option.level - b.option.level)[0] ?? want;
		const queueFree = d.limits.queueUsed < d.limits.queue;
		if (want && queueFree && want.option.affordable) {
			await p.construct(now, d.id, want.district, want.slot, want.option.building);
			built++;
			continue;
		}

		// Research whenever the institute is idle: first what holds a resource building back, then the economy.
		if (has('institute')) {
			const running = ((await p.views(now, ['research.queue']))['research.queue'] as { items: unknown[] }).items.length;
			if (!running) {
				const top = (b: string) => Math.max(0, ...placed.filter((x) => x.building === b).map((x) => x.level));
				const order = ['agriculture', 'forestry', 'masonry', 'metallurgy', 'mining']
					.map((t, i) => ({ t, lvl: top(RESOURCE_BUILDINGS[i]) }))
					.sort((a, b) => a.lvl - b.lvl)
					.map((x) => x.t);
				let started = false;
				for (const tech of [...order, 'economics', 'irrigation', 'granaries', 'administration', 'frontier-towns']) {
					try {
						await p.run(now, 'research.start', { tech, settlement: d.id });
						researched++;
						started = true;
						break;
					} catch {
						// blocked or not affordable: the next one
					}
				}
				if (started) continue;
			}
		}
		// An outer city whenever allowed and affordable.
		if (d.nextOuter && !d.nextOuter.blocked && d.nextOuter.candidates.length && waitFor(d.nextOuter.cost, pool.amounts, {}) === 0) {
			const t = d.nextOuter.candidates[0];
			try {
				await p.run(now, 'settlements.addOuter', { settlement: d.id, x: t.x, y: t.y });
				outers++;
				continue;
			} catch {
				// not this time
			}
		}

		if (army) {
			// Train from what the builder does not need: stock above 60% of the cap, a batch per camp, evenly.
			const spare = Math.min(...Object.values(pool.amounts)) - cap * 0.6;
			if (spare > 0)
				for (const camp of CAMPS.filter(has)) {
					for (const n of [1000, 300, 100, 30]) {
						try {
							await p.run(now, 'troops.train', { settlement: c.id, unit: UNITS[camp], count: n });
							break;
						} catch {
							// too many for now (resources, a full plan): fewer
						}
					}
				}
			// Raid a starter camp the whole tier-1 army wins against surely, once it has refilled (8 hours).
			const g = await garrison();
			const units = Object.fromEntries(Object.values(UNITS).map((u) => [u, g[u] ?? 0]));
			const total = Object.values(units).reduce((a, b) => a + b, 0);
			const tiles = (await p.views(now, ['settlements.map'], { x: String(c.x), y: String(c.y), r: '1' }))['settlements.map'] as MapTile[];
			for (const t of tiles.filter((x) => x.kind.startsWith('npc-'))) {
				const level =
					(await db.prepare('SELECT level FROM npc_camps_levels WHERE settlement_id = ?').bind(t.settlement).first<{ level: number }>())
						?.level ?? 1;
				const needed = SURE[t.kind]?.[level];
				if (!needed || total < needed || now - (raided.get(t.settlement) ?? -Infinity) < 8 * H) continue;
				try {
					await p.run(now, 'armies.send', { from: c.id, x: t.x, y: t.y, units });
				} catch {
					continue;
				}
				raided.set(t.settlement, now);
				raids++;
				// Its report, read at the moment it fights (a view: nothing is committed ahead of time).
				const sent = ((await p.views(now, ['armies.list']))['armies.list'] as { id: string; arrivesAt: number }[]).find(
					(x) => !counted.has(x.id),
				);
				if (sent) {
					const there = ((await p.views(sent.arrivesAt + 1, ['armies.list']))['armies.list'] as Raid[]).find((x) => x.id === sent.id);
					if (there?.report) {
						counted.add(sent.id);
						const r = there.report;
						const sum = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
						raidGains += sum(r.loot);
						captured += sum(r.captured);
						log.push(`${Math.round((now - T0) / H)}h ${r.target.kind}-${level} ${r.outcome} lost ${sum(r.losses.attacker)}`);
					}
				}
				break;
			}
			// Bring finished marches home (the client does this when the time is up).
			try {
				await p.run(now, 'armies.sync');
			} catch {
				// nothing due
			}
		}

		// Wait: a construction done, the wanted one affordable, a march home, or the next checkpoint.
		const finishes = d.districts.flatMap((x) => x.slots.flatMap((s) => (s.construction ? [s.construction.finishesAt] : [])));
		const afford = want && queueFree ? now + Math.ceil(waitFor(want.option.cost, pool.amounts, pool.rates) * 1000) : Infinity;
		const step = Math.max(1000, Math.min(...finishes, afford, now + (army ? 0.25 * H : Infinity), T0 + hours[next] * H, end) - now);
		if (queueFree && want) idle += step;
		now += step;
		while (next < hours.length && now >= T0 + hours[next] * H) {
			const levels: Record<string, number[]> = {};
			for (const district of (await p.detail(now)).districts)
				for (const s of district.slots) if (s.current) (levels[s.current.building] ??= []).push(s.current.level);
			const pl = await p.pool(now);
			const g = await garrison();
			out.push({
				hour: hours[next],
				built,
				researched,
				outers,
				idle: Math.round((idle / (now - T0)) * 100),
				capacity: pl.capacity,
				perHour: Object.fromEntries(Object.entries(pl.rates).map(([r, v]) => [r, Math.round(v * 3600)])),
				levels: Object.fromEntries(Object.entries(levels).map(([b, l]) => [b, l.sort((x, y) => y - x).join(',')])),
				army: Object.values(g).reduce((a, b) => a + b, 0),
				raids,
				raidGains,
				captured,
				// A tier-1 unit's upkeep is 1 an hour (starter-army upkeep.perHour), all resources together.
				upkeepPerHour: Object.values(g).reduce((a, b) => a + b, 0),
			});
			next++;
		}
	}
	if (army) out.push({ ...out.at(-1)!, levels: { raids: log.join(' | ') } });
	return out;
}
