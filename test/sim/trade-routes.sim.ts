// How hard the starter trade routes are (1.7.0 balancing; user 2026-11-16: "本地模拟一下试玩一下，看看难度是否合适"):
// teams at a few stages of a player's growth (heroes' level and the tier of their men, each hero leading as many as it
// may) fight, through the real commands, a copy of every chapter's first camp, its two-column camp and its boss. Prints
// how often each stage wins and what share of the men it sends it loses. Heroes wear nothing and have no research
// behind them (a floor: real players are stronger). The heroes are the same every run (user 2026-11-18: random tavern
// draws differed more between two runs than what was being tuned): made by the NPC hero generator, a typical hero of a
// tavern at the stage's level raised to the stage's hero level as a player would (fixed seeds), placed as a GM's gift
// and recruited, with no talents of its own (rule) so levelling keeps the attributes it was made with.
import { describe, it } from 'vitest';
import type { HeroInfo } from '../../src/shared/api';
import type { TradeBattleReport } from '../../src/shared/trade-routes';
import { parseRoutes } from '../../src/plugins/trade-routes';
import routesCsv from '../../src/plugins/starter-trade-routes/data/routes.csv?raw';
import nodesCsv from '../../src/plugins/starter-trade-routes/data/nodes.csv?raw';
import edgesCsv from '../../src/plugins/starter-trade-routes/data/edges.csv?raw';
import { inner, player, T0 } from '../helpers';

// The tavern's level a player has at each stage (暂按).
const STAGES = [
	{ level: 20, tier: 2, tavern: 5 },
	{ level: 30, tier: 3, tavern: 8 },
	{ level: 45, tier: 4, tavern: 12 },
	{ level: 60, tier: 5, tavern: 15 },
	{ level: 75, tier: 6, tavern: 18 },
	{ level: 90, tier: 6, tavern: 20 },
];
const FAMILIES = ['infantry', 'archer', 'cavalry'];
const TRIES = Number(process.env.TRIES ?? 4);

// The places fought: each chapter's n1 (a camp), n3 (two columns wide), b (the boss), on a route of their own where
// each is next to the start (no loot, no experience: the heroes stay as they are).
const starter = parseRoutes(routesCsv, nodesCsv, edgesCsv, (m) => new Error(m));
const targets = starter.flatMap((r) =>
	r.nodes.filter((n) => /-(n1|n3|b)$/.test(n.id)).map((n) => ({ route: r.id, id: n.id, width: n.width, enemies: n.enemies })),
);
const custom = {
	routes: 'id,name,order\nsim,Sim,1',
	nodes: [
		'route,id,chapter,kind,x,y,width,enemies',
		'sim,s,1,start,0,0,1,',
		// A copy for each try (a place won stays cleared).
		...targets.flatMap((t, i) =>
			Array.from(
				{ length: TRIES },
				(_, k) =>
					`sim,${t.id}-t${k},1,enemy,${i},${k},${t.width},"${t.enemies
						.map((c) =>
							Object.entries(c)
								.map(([u, n]) => `${u}:${n}`)
								.join('; '),
						)
						.join(' | ')}"`,
			),
		),
	].join('\n'),
	edges: ['route,a,b', ...targets.flatMap((t) => Array.from({ length: TRIES }, (_, k) => `sim,s,${t.id}-t${k}`))].join('\n'),
};

async function stage(level: number, tier: number, tavern: number) {
	// The three heroes, as the generator makes them (with the usual talents: a player of its own for it).
	const maker = player();
	await maker.start();
	const made = await maker.probe(T0, async (api, k) =>
		[0, 1, 2].map((i) => k.services.get('npcHeroes').make(api, { venue: 'tavern', venueLevel: tavern, level }, `sim-hero-${i}`)),
	);
	const p = player({
		'buildings.speed': 1e6,
		'trade-routes.custom': custom,
		'heroes.cap': 10,
		'starter-heroes.talents': { tavern: { '0': 1 } },
	});
	const c = await p.start();
	let now = T0 + 1000;
	for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(now, r, 1e9);
	await p.construct(now, c.id, inner(c).id, 0, 'tavern');
	now += 2000;
	for (const m of made) {
		const attrs = Object.fromEntries(Object.entries(m.attrs).map(([a, v]) => [`attrs.${a}`, Math.round(v)]));
		await p.run(now, 'heroes.gift', { settlement: c.id, venue: 'tavern', ...attrs }, true);
		const gift = (await p.candidates(now)).find((v) => v.venue === 'tavern')!.candidates.find((x) => x?.gift)!;
		await p.run(now, 'heroes.recruit', { settlement: c.id, venue: 'tavern', gift: gift.gift });
	}
	const roster = async () => ((await p.views(now, ['heroes.roster']))['heroes.roster'] as HeroInfo[]).filter((h) => h.home === c.id);
	// Up to the level: no talents, so the attributes stay as made (their free points already spent in them).
	for (const h of await roster()) {
		for (let i = 0; i < 200; i++) {
			const x = (await roster()).find((y) => y.id === h.id)!;
			if (x.level >= level || x.expToNext === null) break;
			await p.run(now, 'heroes.grantExp', { hero: h.id, exp: x.expToNext - x.exp }, true);
		}
	}
	const heroes = (await roster()).slice(0, 3);
	const r = (
		await p.static<{ rules: { capLevel: number; capAttrs: Record<string, number>; capOther: number } }>(now, 'trade-routes.routes')
	).rules;
	const cap = (h: HeroInfo) => {
		let n = h.level * r.capLevel;
		for (const [a, v] of Object.entries(h.attrs)) n += (v + (h.bonus[a] ?? 0)) * (r.capAttrs[a] ?? r.capOther);
		return Math.floor(n);
	};
	const team = heroes.map((h, i) => ({ hero: h.id, units: { [`${FAMILIES[i % 3]}-${tier}`]: cap(h) } }));
	const results: Record<string, { won: number; lostShare: number }> = {};
	for (const t of targets) {
		let won = 0;
		let share = 0;
		for (let k = 0; k < TRIES; k++) {
			now += 60_000;
			for (const col of team)
				for (const [unit, count] of Object.entries(col.units)) await p.run(now, 'troops.grant', { settlement: c.id, unit, count }, true);
			await p.run(now, 'troops.grant', { settlement: c.id, unit: 'supply-train', count: 200 }, true);
			await p.run(now, 'trade-routes.depart', { settlement: c.id, route: 'sim', hours: 1, team, auxiliaries: { 'supply-train': 200 } });
			const sent = team.slice(0, t.width);
			await p.run(now, 'trade-routes.fight', { node: `${t.id}-t${k}`, heroes: sent.map((s) => s.hero) });
			const report = (await p.views(now, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
			const men = sent.reduce((a, s) => a + Object.values(s.units).reduce((x, y) => x + y, 0), 0);
			const lost = Object.values(report.lost).reduce((a, u) => a + Object.values(u).reduce((x, y) => x + y, 0), 0);
			if (report.log.won) won++;
			share += lost / men;
			await p.run(now, 'trade-routes.recall', null);
		}
		results[t.id] = { won: won / TRIES, lostShare: share / TRIES };
	}
	return { results, heroes: heroes.map((h) => ({ level: h.level, cap: cap(h) })) };
}

describe('trade routes difficulty', () => {
	it('who wins where, and at what cost', async () => {
		const all = [];
		for (const s of STAGES) all.push({ ...s, ...(await stage(s.level, s.tier, s.tavern)) });
		const lines = [
			'stage: ' + all.map((s) => `L${s.level}/t${s.tier} (${s.heroes.map((h) => h.cap).join('+')} men)`).join(' | '),
			'place'.padEnd(12) + all.map((s) => `L${s.level}/t${s.tier}`.padStart(14)).join(''),
		];
		for (const t of targets) {
			const men = t.enemies.reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0);
			const head = `${t.id}`.padEnd(12);
			lines.push(
				head +
					all
						.map((s) => {
							const r = s.results[t.id];
							return `${Math.round(r.won * 100)}% -${Math.round(r.lostShare * 100)}%`.padStart(14);
						})
						.join('') +
					`   (${men} men, ${t.enemies.map((c) => Object.keys(c)[0].split('-')[1]).join('/')} tier)`,
			);
		}
		throw new Error(lines.join('\n'));
	}, 1_800_000);
});
