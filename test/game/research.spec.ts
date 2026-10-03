/** Research: institutes, queues and the tech tree. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext, resolveConfig } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo, GarrisonInfo, HeroCandidates, IncomingArmy, ResearchTree, ResolvedForm } from '../../src/shared/api';
import type { CardsData, TimersData, TreeData, UiText } from '../../src/shared/ui';
import { db, T0, defaultKernel, player, inner, outer } from '../helpers';

describe('research', () => {
	it('unlocks building levels node by node: farms 6+ at Agriculture 1, 10+ at 3, 15+ at 7', async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, gold: 1e6 } });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const at = T0 + 2_000;
		const needs = async (level: number) => {
			await p.run(at, 'buildings.setLevel', { settlement: c.id, district: outer(c).id, slot: 0, level }, true);
			const blocked = (await p.detail(at)).districts.find((d) => d.type === 'outer')!.slots[0].options[0].blocked;
			return blocked?.vars?.[1] ?? null;
		};
		// The next level (one up) is what is gated.
		expect(await needs(4)).toBeNull();
		expect(await needs(5)).toBe(1);
		await p.run(at, 'research.setLevel', { tech: 'agriculture', level: 1 }, true);
		expect(await needs(8)).toBeNull();
		expect(await needs(9)).toBe(3);
		await p.run(at, 'research.setLevel', { tech: 'agriculture', level: 3 }, true);
		expect(await needs(13)).toBeNull();
		expect(await needs(14)).toBe(7);
	});

	it('strengthen siege devices (Mohist Defence) and speed up auxiliaries (Wagon Corps) through their stats', async () => {
		const p = player();
		const c = await p.start();
		const stats = defaultKernel.services.get('stats');
		const api = {
			...engineContext(defaultKernel, p.id, T0),
			db,
			services: defaultKernel.services,
			memo: (_k: string, l: () => Promise<unknown>) => l(),
		} as never;
		expect(await stats.get(api, 'starter-siege.deviceStrength', `settlement:${c.id}`)).toBe(1);
		await p.run(T0, 'research.setLevel', { tech: 'mohist-defense', level: 4 }, true);
		await p.run(T0, 'research.setLevel', { tech: 'wagon-corps', level: 2 }, true);
		const later = {
			...engineContext(defaultKernel, p.id, T0),
			db,
			services: defaultKernel.services,
			memo: (_k: string, l: () => Promise<unknown>) => l(),
		} as never;
		expect(await stats.get(later, 'starter-siege.deviceStrength', `settlement:${c.id}`)).toBeCloseTo(1.2);
		expect(await stats.get(later, 'starter-auxiliary.speed', `player:${p.id}`)).toBeCloseTo(1.06);
	});

	it('gates building levels in bands and adds stat bonuses', async () => {
		const p = player({
			'buildings.speed': 1e6,
			'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, gold: 1e6 },
			'resources.baseCapacity': 1e7,
		});
		const c = await p.start();
		// Instant-ish builds (speed 1e6 -> 1 s each), one after another.
		for (let lv = 1; lv <= 5; lv++) await p.construct(T0 + lv * 2_000, c.id, outer(c).id, 0, 'farm');
		const at = T0 + 20_000;
		const farm = (await p.detail(at)).districts.find((d) => d.type === 'outer')!.slots[0];
		expect(farm.current?.level).toBe(5);
		expect(farm.options[0].blocked).toEqual({
			text: 'research.Requires {0} Lv {1}',
			vars: { 0: { text: 'starter-research.Agriculture' }, 1: 1 },
		});
		await p.run(at, 'research.setLevel', { tech: 'agriculture', level: 1 }, true);
		expect((await p.detail(at)).districts.find((d) => d.type === 'outer')!.slots[0].options[0].blocked).toBeUndefined();

		expect((await p.detail(at)).limits.outerTech).toBe(3);
		await p.run(at, 'research.setLevel', { tech: 'administration', level: 3 }, true);
		expect((await p.detail(at)).limits.outerTech).toBe(6);
		await p.run(at, 'research.setLevel', { tech: 'economics', level: 2 }, true);
		expect((await p.pool(at)).factor).toBeCloseTo(1.08);
	});

	it('runs in institutes: one queue per settlement, never the same tech twice at once', async () => {
		const rich = { food: 1e5, wood: 1e5, stone: 1e5, metal: 1e5, gold: 1e5 };
		const p = player({ 'resources.initial': rich, 'resources.baseCapacity': 1e6, 'player-settlements.outerCost': { food: 0 } });
		const c = await p.start();
		await expect(p.run(T0, 'research.start', { tech: 'economics', settlement: c.id })).rejects.toThrow(/Needs an institute/);
		await p.construct(T0, c.id, inner(c).id, 0, 'institute'); // 60 s
		const t1 = T0 + 60_000;
		const tree = async (now: number, settlement?: string) =>
			(await p.views(now, ['research.tree'], settlement ? { settlement } : {}))['research.tree'] as {
				current: { tech: string } | null;
				all: unknown[];
				speed: number;
				techs: { id: string; level: number; next: { seconds: number; blocked?: string } | null }[];
			};
		expect((await tree(t1)).speed).toBeCloseTo(1.1);
		expect((await tree(t1)).techs.find((t) => t.id === 'economics')?.next?.seconds).toBe(Math.ceil(600 / 1.1));
		await p.run(t1, 'research.start', { tech: 'economics', settlement: c.id });
		await expect(p.run(t1, 'research.start', { tech: 'agriculture', settlement: c.id })).rejects.toMatchObject({
			text: { text: 'research.This settlement is researching another tech' },
		});
		// Busy here, but nothing is missing: the tree (shared by all settlements) shows it as open.
		const agriculture = (await tree(t1)).techs.find((t) => t.id === 'agriculture')!.next as { blocked?: UiText; locked?: UiText };
		expect(agriculture).toMatchObject({ blocked: { text: 'research.This settlement is researching another tech' } });
		// The tech being researched says so (not "another tech").
		expect((await tree(t1)).techs.find((t) => t.id === 'economics')!.next).toMatchObject({
			blocked: { text: 'research.Being researched here' },
		});
		expect(agriculture.locked).toBeUndefined();
		// The same for the generic widgets: the queue, what this institute researches, what it can start.
		const shown = (await p.views(t1, ['research.queue', 'research.current', 'research.options'])) as {
			'research.queue': TimersData;
			'research.current': TimersData;
			'research.options': CardsData;
		};
		expect(shown['research.queue'].items).toEqual([
			expect.objectContaining({
				title: { text: 'research.{tech} {n}', vars: { tech: { text: 'starter-research.Treasury' }, n: 1 } },
				endsAt: expect.any(Number),
			}),
		]);
		expect(shown['research.current'].items).toHaveLength(1);
		// Where the speed comes from: the institute (speed 1.1 = +10%).
		expect(shown['research.current'].notes?.[1]?.text).toEqual({
			text: 'research.Speed: {0}',
			vars: { 0: [{ text: 'stats.{0} {1}', vars: { 0: { text: 'starter-research.Institute' }, 1: '+10%' } }] },
		});
		// Cards like the tree's, one branch and tier at a time (the first by default).
		const options = shown['research.options'];
		expect(options.defaultGroup).toBe(options.groups![0].id);
		const agri = options.cards.find((r) => r.id === 'agriculture')!;
		expect(agri).toMatchObject({ group: 'starter-research.Civil|1', badge: { text: 'research.Lv {n}/{max}' } });
		expect(agri.actions![0]).toMatchObject({
			command: 'research.start',
			blocked: { text: 'research.This settlement is researching another tech' },
		});
		// Not researched yet: its first node, "Lv 1: unlocks Farm Lv 6 and above".
		expect(agri.lines).toContainEqual(
			expect.objectContaining({
				text: {
					text: 'research.Lv {lv}: unlocks {building} Lv {from} and above',
					vars: { lv: 1, building: { text: 'starter-content.Farm' }, from: 6 },
				},
			}),
		);

		// A second settlement with its own institute runs its own queue, but not the same tech.
		let tile = { x: 0, y: 0 };
		for (let i = 0; ; i++) {
			tile = { x: wrap(c.x + 6 + i), y: c.y };
			const free = !(await db
				.prepare('SELECT 1 FROM world_map_tiles WHERE (x = ? OR x = ? OR x = ?) AND y BETWEEN ? AND ?')
				.bind(wrap(tile.x - 1), tile.x, wrap(tile.x + 1), wrap(tile.y - 1), wrap(tile.y + 1))
				.first());
			if (free) break;
		}
		await p.run(t1, 'settlements.found', { kind: 'city', x: tile.x, y: tile.y, name: 'Second' }, true);
		const city = (await p.mine(t1)).find((s) => s.name === 'Second')!;
		const cityInner = (await p.detail(t1, city.id)).districts[0].id;
		await p.construct(t1, city.id, cityInner, 0, 'institute');
		const t2 = t1 + 60_000;
		expect((await tree(t2, city.id)).techs.find((t) => t.id === 'economics')?.next?.blocked).toEqual({
			text: 'research.Being researched in {0}',
			vars: { 0: { text: 'player-settlements.Capital' } },
		});
		await p.run(t2, 'research.start', { tech: 'agriculture', settlement: city.id });
		expect((await tree(t2)).all).toHaveLength(2);

		const done = await tree(t1 + 700_000);
		expect(done.current).toBeNull();
		expect(done.techs.find((t) => t.id === 'economics')?.level).toBe(1);
	});

	it('accepts tech nodes registered at runtime (opaque discoveries), private or global', async () => {
		const a = player();
		const b = player();
		await a.start();
		await b.start();
		const node = (id: string) => ({
			id,
			name: 'Secret irrigation',
			maxLevel: 3,
			levels: [{ cost: { gold: 100 }, seconds: 60 }],
			percent: { 'resources.productionFactor': 10 },
		});
		const secret = `secret-${a.id.slice(0, 8)}`;
		await a.run(T0, 'research.registerNode', { def: node(secret) }, true);
		await a.run(T0, 'research.setLevel', { tech: secret, level: 2 }, true);
		const techs = async (p: ReturnType<typeof player>) =>
			((await p.views(T0, ['research.tree']))['research.tree'] as { techs: { id: string; level: number }[] }).techs;
		expect((await techs(a)).find((t) => t.id === secret)?.level).toBe(2);
		expect((await techs(b)).find((t) => t.id === secret)).toBeUndefined();
		expect((await a.pool(T0)).factor).toBeCloseTo(1.2);
		expect((await b.pool(T0)).factor).toBe(1);

		const shared = `shared-${a.id.slice(0, 8)}`;
		await a.run(T0, 'research.registerNode', { def: node(shared), global: true }, true);
		expect((await techs(b)).map((t) => t.id)).toContain(shared);
		await expect(a.run(T0, 'research.registerNode', { def: { id: 'Bad Id!', name: 'x', maxLevel: 1, levels: [] } }, true)).rejects.toThrow(
			/id:/,
		);
		await expect(a.run(T0, 'research.registerNode', { def: node('agriculture') }, true)).rejects.toThrow(/already exists/);
	});

	it('lets other plugins change research costs and grant levels', async () => {
		const hero = definePlugin({
			id: 'test-hero',
			version: '0',
			dependsOn: ['research'],
			setup(ctx) {
				ctx.services.get('research').addCostModifier(async () => ({ costFactor: 0.5, timeFactor: 0.5 }));
			},
		});
		const k = createKernel([...plugins, hero]);
		const p = player({}, k);
		const c = await p.start();
		const quote = await k.services.get('research').quote(
			{
				...engineContext(k, p.id, T0),
				db,
				services: k.services,
				memo: (_k: string, l: () => Promise<unknown>) => l(),
			} as never,
			{
				playerId: p.id,
				settlementId: c.id,
				tech: 'economics',
				level: 1,
			},
		);
		expect(quote).toEqual({ cost: { food: 400, wood: 400, stone: 400, metal: 105, gold: 200 }, seconds: 300 });
	});
});

describe('tech tree', () => {
	type Tech = ResearchTree['techs'][number];
	const tree = async (p: ReturnType<typeof player>, now = T0) => (await p.views(now, ['research.tree']))['research.tree'] as ResearchTree;

	it('is two crossing branches in four tiers, every prerequisite known and reachable', async () => {
		const p = player();
		await p.start();
		// Only the tree: other tests register runtime nodes visible to everyone (no branch).
		const techs = (await tree(p)).techs.filter((t) => t.branch);
		const byId = new Map(techs.map((t) => [t.id, t]));
		expect(techs.filter((t) => t.branch === 'starter-research.Civil')).toHaveLength(32);
		expect(techs.filter((t) => t.branch === 'starter-research.Military')).toHaveLength(24);
		for (const t of techs) {
			expect(t.tier).toBeGreaterThanOrEqual(1);
			expect(t.quote).toBeTruthy();
			for (const [req, level] of Object.entries(t.requires)) {
				const r = byId.get(req);
				expect(r, `${t.id} needs ${req}`).toBeDefined();
				expect(level).toBeLessThanOrEqual(r!.maxLevel);
				expect(r!.tier).toBeLessThanOrEqual(t.tier!); // never needs a later tier
			}
		}
		// The branches cross: some civil techs need military ones and the other way round.
		const crossing = techs.flatMap((t) => Object.keys(t.requires).filter((r) => byId.get(r)!.branch !== t.branch));
		expect(crossing.length).toBeGreaterThanOrEqual(10);
		// The old techs keep their ids (and so the levels players have).
		for (const id of ['agriculture', 'forestry', 'masonry', 'mining', 'metallurgy', 'administration', 'economics'])
			expect(byId.has(id)).toBe(true);
		expect(byId.get('mining')!.name).toBe('starter-research.Coinage');
		// Cards describe the effects, live from the rules.
		expect(byId.get('art-of-war')!.effects).toEqual([
			{ target: 'battle.attack', value: 2.5, percent: true },
			// Milestones: once, at that level.
			{ target: 'settlements.limit.fortress-military', value: 1, percent: false, atLevel: 5 },
			{ target: 'settlements.limit.fortress-military', value: 1, percent: false, atLevel: 10 },
		]);
		expect(byId.get('drill')!.effects).toContainEqual({ target: 'time.training', value: -4, percent: true });
		expect(byId.get('regiments')!.unlocks).toEqual([
			{
				building: 'barracks',
				at: [
					{ level: 1, from: 6 },
					{ level: 2, from: 11 },
					{ level: 3, from: 16 },
				],
			},
		]);
		// Resource techs: 20 levels, nodes at 1 / 3 / 7, and their resource's output.
		expect(byId.get('agriculture')).toMatchObject({
			maxLevel: 20,
			unlocks: [
				{
					building: 'farm',
					at: [
						{ level: 1, from: 6 },
						{ level: 3, from: 10 },
						{ level: 7, from: 15 },
					],
				},
			],
		});
		expect(byId.get('agriculture')!.effects).toContainEqual({ target: 'output.food', value: 2, percent: true });
		// The same as a generic tree: branches of four tiers; prerequisites in the branch as lines, the others as tags.
		const graph = (await p.views(T0, ['research.graph']))['research.graph'] as TreeData;
		// (Other tests add runtime nodes outside the branches, as group "Other".)
		expect(graph.groups.filter((g) => g.id !== 'Other').map((g) => [g.id, g.columns.length])).toEqual([
			['starter-research.Civil', 4],
			['starter-research.Military', 4],
		]);
		const nodes = graph.groups.flatMap((g) => g.columns.flatMap((c) => c.nodes));
		expect(nodes.find((n) => n.id === 'irrigation')).toMatchObject({
			state: 'locked',
			requires: [{ id: 'agriculture', met: false }],
			tags: [],
		});
		expect(nodes.find((n) => n.id === 'military-farms')!.tags).toEqual([
			{ text: { text: 'research.{tech} {n}', vars: { tech: { text: 'starter-research.Art of War' }, n: 1 } }, met: false },
		]);
	});

	it("effects: one resource's output, training time, upkeep, battle bonuses; GM can retune them", async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0, 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		await p.construct(T0, c.id, outer(c).id, 1, 'lumber-mill');
		await p.construct(T0 + 1_000, c.id, inner(c).id, 0, 'barracks'); // the queue holds two
		const at = T0 + 2_000;
		const before = (await p.pool(at)).rates;
		await p.run(at, 'research.setLevel', { tech: 'irrigation', level: 2 }, true);
		const after = (await p.pool(at)).rates;
		expect(after.food).toBeCloseTo(before.food * 1.06); // +3% a level, food only
		expect(after.wood).toBeCloseTo(before.wood);

		const seconds = async () =>
			((await p.views(at, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable.find((t) => t.unit === 'infantry-1')!.seconds;
		const base = await seconds();
		await p.run(at, 'research.setLevel', { tech: 'drill', level: 5 }, true);
		expect(await seconds()).toBeLessThan(base); // 20% faster (rounded up to whole seconds)

		// Battle: the attacker's techs become modifiers named after them.
		await p.run(at, 'research.setLevel', { tech: 'art-of-war', level: 2 }, true);
		await p.run(at, 'research.setLevel', { tech: 'foot-armour', level: 1 }, true);
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		const camp = { x: wrap(c.x + 5), y: c.y };
		await p.run(at, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		await p.run(at, 'armies.send', { from: c.id, ...camp, units: { 'infantry-1': 10 } });
		const report = ((await p.views(at + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.modifiers.attacker).toEqual(
			expect.arrayContaining([
				{ source: { text: 'starter-research.Art of War' }, stat: 'attack', percent: 5 },
				{ source: { text: 'starter-research.Foot Armour' }, stat: 'hp', percent: 3 },
			]),
		);

		// The GM retunes a tech: its rows are replaced; bad rows are refused.
		const retuned = player({ 'starter-research.effects': { 'art-of-war': [{ kind: 'battle', target: 'attack', value: 10 }] } });
		await retuned.start();
		expect(((await tree(retuned)).techs.find((t) => t.id === 'art-of-war') as Tech).effects).toEqual([
			{ target: 'battle.attack', value: 10, percent: true },
		]);
		const { errors } = resolveConfig(defaultKernel, {
			'starter-research.effects': { 'art-of-war': [{ kind: 'battle', target: 'speed', value: 1 }] },
		});
		expect(errors['starter-research.effects']).toMatchObject({
			text: 'starter-research.{0}: {1}',
			vars: { 1: { text: 'starter-research.battle target must be one of {0}' } },
		});
	});

	it('reach the other systems through their stats and hooks: caps, terrain, candidates, cargo, speed, scouts, walls, promotions', async () => {
		const rules = { 'armies.minSeconds': 0, 'buildings.speed': 1e6, 'pvp.protectionHours': 0 };
		const p = player(rules);
		const c = await p.start();
		const o = outer(c);
		await p.construct(T0, c.id, o.id, 0, 'farm');
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		let t = T0 + 2_000;
		const set = (tech: string, level: number, who = p) => who.run(t, 'research.setLevel', { tech, level }, true);

		// Building caps: Works of Heaven, +2 levels a level on resource buildings.
		const farmCap = async () => outer(await p.detail(t)).slots[0].current!.cap;
		expect(await farmCap()).toBe(20);
		await set('works-of-heaven', 2);
		expect(await farmCap()).toBe(24);

		// Terrain: irrigation adds food everywhere, and again on rivers.
		await p.run(t, 'terrain.paint', { x: o.x, y: o.y, width: 1, height: 1, terrain: 'river' }, true);
		const food = async () => (await p.pool(t)).rates.food;
		expect(await food()).toBeCloseTo(1);
		await set('irrigation', 1);
		expect(await food()).toBeCloseTo(1.06);

		// More hero candidates.
		const offered = async () =>
			((await p.views(t, ['heroes.candidates']))['heroes.candidates'] as HeroCandidates[]).find((v) => v.venue === 'tavern')!.candidates
				.length;
		const before = await offered();
		await set('examinations', 1);
		expect(await offered()).toBe(before + 1);

		// Supplies for transfers: +8% of the units' carry.
		await p.run(t, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		const fort = { x: wrap(c.x + 6), y: c.y };
		await p.run(t, 'settlements.found', { kind: 'fortress-military', ...fort }, true);
		const capacity = async () =>
			((await p.views(t, ['ui.forms'], { placement: 'tile', x: String(fort.x), y: String(fort.y) }))['ui.forms'] as ResolvedForm[]).find(
				(f) => f.command === 'armies.transfer',
			)!.budgets![0].capacity['units.infantry-1'];
		expect(await capacity()).toBeCloseTo(20);
		await set('grain-canals', 1);
		expect(await capacity()).toBeCloseTo(21.6);

		// March speed: post roads, +6% at level 2.
		const trip = async () => {
			await p.run(t, 'armies.send', { from: c.id, x: wrap(c.x + 40), y: c.y, units: { 'infantry-1': 1 } });
			const army = ((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).find((a) => a.departedAt === t)!;
			return army.arrivesAt - t;
		};
		const slow = await trip();
		t += 1_000;
		await set('post-roads', 2);
		expect((await trip()) / 1000).toBeCloseTo(Math.ceil(slow / 1000 / 1.06), 0);

		// Walls and scouts, in a real attack: the defender's fortification strengthens the wall,
		// the attacker's firearms cut its bonus, the defender's scouts see what comes.
		const q = player(rules);
		const cq = await q.start();
		const wall = inner(await p.detail(t)).slots.find((x) => x.current?.building === 'wall')!;
		await p.run(t, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: wall.slot, level: 10 }, true);
		await set('fortification', 2);
		await set('scouts', 3);
		await set('firearms', 1, q);
		await q.run(t, 'troops.grant', { settlement: cq.id, unit: 'cavalry-1', count: 10 }, true);
		await q.run(t, 'armies.send', { from: cq.id, x: c.x, y: c.y, units: { 'cavalry-1': 10 } });
		const incoming = (await p.views(t, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
		expect(incoming[0].intel).toEqual({ level: 3, total: 10, units: { 'cavalry-1': 10 } });
		const attack = ((await q.views(t, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await q.run(attack.arrivesAt, 'timeline.sync', { entity: `army:${attack.id}` }, true);
		const report = ((await q.views(attack.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		// Level 10: 100 a level x 120%, and its 10% bonus less the attacker's 3 points.
		expect(report.battle!.modifiers.defender).toContainEqual({
			source: { text: 'starter-defense.Wall Lv {0}', vars: { 0: 10 } },
			stat: 'defense',
			flat: 1200,
			percent: 7,
		});

		// Promotions cost less quota (Royal Army: battle.promotionCost -10%): the formula takes the factor.
		const battle = defaultKernel.services.get('battle');
		expect(battle.promotions({ 'infantry-1': 30 }, { 'infantry-1': 10 })).toEqual([{ from: 'infantry-1', to: 'infantry-2', count: 10 }]);
		expect(battle.promotions({ 'infantry-1': 30 }, { 'infantry-1': 10 }, 2)).toEqual([{ from: 'infantry-1', to: 'infantry-2', count: 5 }]);
	});

	it('casualty bonuses for one family spare only that family', async () => {
		const shield = definePlugin({
			id: 'test-shield',
			version: '0',
			dependsOn: ['battle'],
			setup: (ctx) =>
				ctx.services
					.get('battle')
					.addModifier(async (_api, side) =>
						side.role === 'attacker' ? [{ source: { text: 'test.Shield' }, stat: 'casualty', percent: -100, family: 'infantry' }] : [],
					),
		});
		const p = player(
			{
				'armies.speed': 1e6,
				'armies.minSeconds': 0,
				// Every family, so every lane of its random formation is manned and hits back.
				'npc-camps.levels': { 'npc-fortress': { 1: { stockade: 1e6, lane: { 3: 240 } } } },
			},
			createKernel([...plugins, shield]),
		);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 30 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-1', count: 30 }, true);
		const fortress = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...fortress }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...fortress, units: { 'infantry-1': 30, 'cavalry-1': 30 } });
		const report = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.losses.attacker['cavalry-1']).toBeGreaterThan(0);
		expect(report.losses.attacker['infantry-1'] ?? 0).toBe(0);
	});
});
