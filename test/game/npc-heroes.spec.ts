// NPC heroes (npc-heroes, recipes from starter-heroes): drawn as the venue's candidates, raised to their level as a
// player would; the same seed the same hero.
import { describe, expect, it } from 'vitest';
import type { HeroInfo } from '../../src/shared/api';
import type { TradeBattleReport, TradeRoutesStatic } from '../../src/shared/trade-routes';
import { resolveConfig } from '../../src/kernel';
import { defaultKernel, inner, outer, player, T0 } from '../helpers';

describe('npc heroes', () => {
	it('are fixed by their seed, differ between seeds, grow with the venue level and their own', async () => {
		const p = player();
		await p.start();
		const made = await p.probe(T0 + 1000, async (api, k) => {
			const npc = k.services.get('npcHeroes');
			const sum = (h: { attrs: Record<string, number> }) => Object.values(h.attrs).reduce((a, b) => a + b, 0);
			const a = npc.make(api, { venue: 'tavern', venueLevel: 3, level: 30 }, 'x');
			const again = npc.make(api, { venue: 'tavern', venueLevel: 3, level: 30 }, 'x');
			const other = npc.make(api, { venue: 'tavern', venueLevel: 3, level: 30 }, 'y');
			// Many seeds, so the averages compare the specs, not one draw.
			const mean = (venueLevel: number, level: number) =>
				Array.from({ length: 40 }, (_, i) => sum(npc.make(api, { venue: 'tavern', venueLevel, level }, `m${i}`))).reduce((x, y) => x + y) /
				40;
			let unknown = '';
			try {
				npc.make(api, { venue: 'nowhere', venueLevel: 1, level: 1 }, 'z');
			} catch (e) {
				unknown = String(e);
			}
			return { a, again, other, low: mean(3, 30), venue: mean(8, 30), level: mean(3, 60), unknown };
		});
		expect(made.again).toEqual(made.a);
		expect(made.other).not.toEqual(made.a);
		expect(made.a.surname).toBeTruthy();
		expect(made.a.build).toMatch(/^starter-heroes\./);
		expect(made.venue).toBeGreaterThan(made.low);
		expect(made.level).toBeGreaterThan(made.low);
		// Each level its talents and the free points (6 a level): at least those over the 29 levels up.
		expect(made.level - made.low).toBeGreaterThan(30 * 6);
		expect(made.unknown).toContain('no recipe');
	});

	it("lead the trade routes' enemy columns: made in full in the static view, leaderless at the start", async () => {
		const p = player();
		const routes = (await p.static<TradeRoutesStatic>(T0, 'trade-routes.routes')).routes;
		const silk = routes.find((r) => r.id === 'silk')!;
		const first = silk.nodes.find((n) => n.id === 'silk-1-1')!;
		expect(first.generals?.some(Boolean) ?? false).toBe(false);
		const boss = silk.nodes.find((n) => n.id === 'silk-1-b')!;
		const elite = boss.generals?.[1];
		expect(elite).toMatchObject({ venue: 'tavern' });
		expect(Object.keys(elite?.attrs ?? {}).length).toBeGreaterThan(0);
		expect(elite?.surname).toBeTruthy();
		// Further on, every column has one, and stronger.
		const late = routes.find((r) => r.id === 'sea')!.nodes.find((n) => n.id === 'sea-4-1')!;
		expect(late.generals?.[0]?.level).toBeGreaterThan(elite!.level);
	});

	it('a general makes its column stronger and sees what it counters', async () => {
		const custom = {
			routes: 'id,name,order\ntest,Test,1',
			nodes: [
				'route,id,chapter,kind,x,y,width,enemies,generals',
				'test,a,1,start,0,0,1,,',
				'test,plain,1,enemy,100,0,1,infantry-1:30,',
				'test,led,1,enemy,0,100,1,infantry-1:30,tavern/10/90',
			].join('\n'),
			edges: 'route,a,b\ntest,a,plain\ntest,a,led',
		};
		const p = player({ 'buildings.speed': 1e6, 'trade-routes.custom': custom });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 100_000;
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(at - 10_000, r, 100_000);
		await p.construct(at - 10_000, c.id, outer(c).id, 0, 'trade-post');
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const h = ((await p.views(at, ['heroes.roster']))['heroes.roster'] as HeroInfo[])[0];
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 100 }, true);
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 100 } }],
		});
		const fight = async (node: string) => {
			await p.run(at, 'trade-routes.fight', { node, heroes: [h.id] });
			const r = (await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
			if (r.log.won) await p.run(at, 'trade-routes.move', { node: 'a' });
			return r.log.theirs[0];
		};
		const plain = await fight('plain');
		const led = await fight('led');
		expect(led.attack).toBeGreaterThan(plain.attack * 1.5);
		expect(led.hp).toBeGreaterThan(plain.hp);
		expect(plain.aim ?? 0).toBe(0);
		expect(led.aim).toBeGreaterThan(0);
	});

	it("lead NPC camps (from level 3) and bandit bands: the camps' table takes them as specs, the GM's too", () => {
		const errorOf = (patch: unknown) =>
			resolveConfig(defaultKernel, { 'npc-camps.levels': { 'npc-outpost': { 3: patch } } }).errors['npc-camps.levels'];
		expect(errorOf({ generals: 'tavern/4/20 | tavern/4/20' })).toBeUndefined();
		expect(JSON.stringify(errorOf({ generals: 'tavern/x/20' }))).toContain('tavern/3/45');
		expect(errorOf({ generals: 3 })).toBeTruthy();
		const levels = resolveConfig(defaultKernel, {}).values['npc-camps.levels'] as Record<string, Record<number, { generals: string }>>;
		expect(levels['npc-outpost'][2].generals).toBe('');
		expect(levels['npc-outpost'][10].generals.split('|').length).toBe(5);
	});
});
