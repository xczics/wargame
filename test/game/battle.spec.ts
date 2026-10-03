/** Battles: player against player, NPC settlements, bandits and the watchtower example. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin } from '../../src/kernel';
import watchtower from '../../examples/watchtower/server';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type {
	ArmyInfo,
	BattleFormationInfo,
	DefenseMail,
	GarrisonInfo,
	HeroInfo,
	IncomingArmy,
	MapTile,
	PrestigeStatus,
	RealmsOverview,
	ResolvedForm,
	SiegeWall,
} from '../../src/shared/api';
import type { CardsData, GridData, SyncData, RowsData, TimersData } from '../../src/shared/ui';
import { db, T0, defaultKernel, NO_TERRAIN_BONUS, unitsKernel, player, inner, inbox } from '../helpers';

describe('pvp', () => {
	it('does not hurt players under beginner protection', async () => {
		const a = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, unitsKernel);
		const b = player(undefined, unitsKernel);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'spearman', count: 20 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { spearman: 20 } });
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'no-battle', note: { text: 'pvp.Under beginner protection' } });
		expect((await b.pool(army.arrivesAt)).amounts.food).toBe(500);
	});

	it('attacks another player: garrison battle and looting in one atomic commit', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		// 200 tier-2 cavalry, 40 per lane (attack 1104 each), against 5 tier-1 infantry behind a level-1 wall.
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-2', count: 200 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 5 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-2': 200 } });

		// The defender sees it coming (without unit details).
		const incoming = (await b.views(T0, ['armies.incoming']))['armies.incoming'] as { settlement: string }[];
		expect(incoming).toEqual([expect.objectContaining({ settlement: cb.id })]);

		// Process the arrival (as the sweep would) and look at the result.
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		// The clients act on time: the attacker's commits the arrival, the defender's refreshes.
		expect(((await a.views(T0, ['armies.due']))['armies.due'] as SyncData).items).toEqual([{ at: army.arrivesAt, command: 'armies.sync' }]);
		expect(((await b.views(T0, ['armies.due']))['armies.due'] as SyncData).items).toEqual([{ at: army.arrivesAt }]);
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'victory', target: { kind: 'capital' } });
		expect(report.battle).toMatchObject({ wins: { attacker: 5, defender: 0 }, grade: { attacker: 'crushing', defender: 'routed' } });
		expect(report.battle!.modifiers.defender).toContainEqual(
			expect.objectContaining({ source: { text: 'starter-defense.Wall Lv {0}', vars: { 0: 1 } }, flat: 100 }),
		);
		expect(report.losses.defender['infantry-1']).toBeGreaterThanOrEqual(1);
		const taken = Object.values(report.loot).reduce((x, y) => x + y, 0);
		expect(taken).toBeGreaterThan(0);

		// The defender's formation was fixed by the battle, and the losses are real.
		expect(((await b.views(army.arrivesAt, ['battle.formation']))['battle.formation'] as BattleFormationInfo).saved).toBe(true);
		const defenses = (await b.views(army.arrivesAt, ['pvp.defenses']))['pvp.defenses'] as { report: { outcome: string } }[];
		expect(defenses).toHaveLength(1);
		// Both sides get a report in their mailbox.
		expect((await inbox(b, army.arrivesAt)).messages).toEqual([
			expect.objectContaining({
				kind: 'war-reports.defense',
				title: expect.objectContaining({ text: 'war-reports.{settlement} was raided by {name}' }),
				read: false,
			}),
		]);
		expect((await inbox(a, army.arrivesAt)).messages).toEqual([
			expect.objectContaining({
				kind: 'war-reports.march',
				title: { text: 'war-reports.Victory at ({x}, {y})', vars: expect.objectContaining({ x: cb.x }) },
			}),
		]);
		// Shown as generic reports: each side sees the lanes from its own side.
		const march = (await inbox(a, army.arrivesAt)).messages[0].report!;
		expect(march).toMatchObject({ tone: 'good', badge: { text: 'armies.mission:attack' } });
		expect(march.fields?.map((f) => f.label.text)).toContain('war-reports.Enemy losses');
		expect(march.lanes?.rows).toHaveLength(5);
		// Each side's lane: its family and total, then unit by unit.
		expect(march.lanes?.rows[0].cells[0][1].text).toEqual({
			text: 'war-reports.{0}',
			vars: { 0: [{ text: 'war-reports.{0} ×{1}', vars: { 0: { text: 'starter-army.Light Horse (Cavalry)' }, 1: '40' } }] },
		});
		expect(march.lanes?.rows.map((r) => r.tone)).toEqual(report.battle!.lanes.map((l) => (l.winner === 'attacker' ? 'good' : 'bad')));
		const defense = (await inbox(b, army.arrivesAt)).messages[0].report!;
		expect(defense.tone).toBe('bad');
		expect(defense.lanes?.rows.map((r) => r.tone)).toEqual(report.battle!.lanes.map((l) => (l.winner === 'defender' ? 'good' : 'bad')));
		const g = (await b.views(army.arrivesAt, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(g.units.find((u) => u.id === 'infantry-1')?.count ?? 0).toBe(5 - report.losses.defender['infantry-1']);
		expect((await b.pool(army.arrivesAt)).amounts.food).toBeLessThan(500);
	});

	it('plunders by result: a share of each stock, minus the hidden store, within what survivors carry', async () => {
		// The design example (§3.9). No wall defence, so 120 tier-1 cavalry win all 5 lanes unharmed.
		const rules = {
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'pvp.protectionHours': 0,
			'starter-defense.wallDefense': { capital: 0 },
			// 1000 kept from raiders at level 2 (the numbers below); the store's own curve has its test.
			'starter-defense.hiddenStore': { perLevel: 500 },
			'buildings.speed': 1e6,
		};
		const a = player(rules);
		const b = player(rules);
		const ca = await a.start();
		const cb = await b.start();
		await b.construct(T0, cb.id, inner(cb).id, 0, 'hidden-store');
		await b.run(T0 + 1_000, 'buildings.setLevel', { settlement: cb.id, district: inner(cb).id, slot: 0, level: 2 }, true);
		await b.grant(T0 + 1_000, 'food', 10_000 - (await b.pool(T0 + 1_000)).amounts.food);
		await b.grant(T0 + 1_000, 'wood', 2_000 - (await b.pool(T0 + 1_000)).amounts.wood);
		await a.run(T0 + 1_000, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 120 }, true);
		await a.run(T0 + 1_000, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 120 } });
		const army = ((await a.views(T0 + 1_000, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.grade.attacker).toBe('crushing');
		// 50%: food 5000, wood 1000 (stone, metal, currency are all under the 1000 protected);
		// 6000 > 120 x 25 = 3000 carry, so both halve.
		expect(report.loot).toEqual({ food: 2500, wood: 500 });
	});

	it('fights lane by lane: the design example of 100 against 100 tier-1 cavalry', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
		const empty = { family: 'cavalry', units: {} };
		await a.run(T0, 'armies.send', {
			from: ca.id,
			x: cb.x,
			y: cb.y,
			units: { 'cavalry-1': 100 },
			formation: [{ family: 'cavalry', units: { 'cavalry-1': 100 } }, empty, empty, empty, empty],
		});
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const { battle, losses } = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		// Lane 1: attack 1150 vs defence 1000 + wall 100: the attacker wins it. The defender takes
		// 50 damage (5 dead), the attacker 1150 - 1000 = 150 (15 dead).
		expect(battle!.lanes[0]).toMatchObject({
			winner: 'attacker',
			attacker: { attack: 1150, defense: 1000, hp: 1000 },
			defender: { defense: 1100 },
		});
		expect(battle!.lanes[0].defender.lost).toEqual({ 'cavalry-1': 5 });
		expect(battle!.lanes[0].attacker.lost).toEqual({ 'cavalry-1': 15 });
		// Empty attacking lanes: no attack. Archers counter cavalry, but counters multiply only what
		// troops bring: an empty lane's wall defence stays 100.
		expect(battle!.lanes[1]).toMatchObject({ winner: 'defender', attacker: { attack: 0, counters: true }, defender: { defense: 100 } });
		expect(battle!.lanes[2]).toMatchObject({ winner: 'defender', defender: { defense: 100, counters: true } });
		// 1 lane of 5: the attacker is routed (x0.2), the defender won (x0.65).
		expect(battle).toMatchObject({ wins: { attacker: 1, defender: 4 }, grade: { attacker: 'routed', defender: 'victory' } });
		expect(losses).toEqual({ attacker: { 'cavalry-1': 3 }, defender: { 'cavalry-1': 3 } });
		// The routed attacker gains nothing; the defender's 3 dead promote 3 survivors (§2.6).
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.promoted).toEqual({ attacker: [], defender: [{ from: 'cavalry-1', to: 'cavalry-2', count: 3 }] });
		const g = (await b.views(army.arrivesAt, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(Object.fromEntries(g.units.map((u) => [u.id, u.count]))).toEqual({ 'cavalry-1': 94, 'cavalry-2': 3 });
	});

	it('lets auxiliary units stay out of the lanes and change losses through casualty hooks', async () => {
		// A stand-in for an "auxiliary units" plugin: medics march along without fighting; each
		// medic saves one of the fallen (final step), and the change shows in the report.
		const medics = definePlugin({
			id: 'test-medics',
			version: '0',
			dependsOn: ['troops', 'battle'],
			setup(ctx) {
				ctx.services.get('troops').define({
					id: 'medic',
					name: 'Medic',
					stats: { attack: 0, defense: 0, hp: 1, speed: 100, carry: 0, cost: {}, seconds: 1, upkeep: {} },
				});
				ctx.services.get('battle').addCasualtyHook({
					source: { text: 'test.Medics' },
					async final(_api, { units, losses }) {
						let saved = units.medic ?? 0;
						if (!saved) return null;
						const out: Record<string, number> = {};
						for (const [u, n] of Object.entries(losses)) {
							const s = Math.min(n, saved);
							saved -= s;
							out[u] = n - s;
						}
						return out;
					},
				});
			},
		});
		const kernel = createKernel([...plugins, medics]);
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast, kernel);
		const b = player(fast, kernel);
		const ca = await a.start();
		const cb = await b.start();
		// The 3.8 example again (the attacker loses 3), now with 2 medics along.
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 100 }, true);
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'medic', count: 2 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
		const empty = { family: 'cavalry', units: {} };
		await a.run(T0, 'armies.send', {
			from: ca.id,
			x: cb.x,
			y: cb.y,
			units: { 'cavalry-1': 100, medic: 2 },
			formation: [{ family: 'cavalry', units: { 'cavalry-1': 100 } }, empty, empty, empty, empty],
		});
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const back = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		expect(back.report!.losses.attacker).toEqual({ 'cavalry-1': 1 });
		expect(back.report!.battle!.adjustments).toContainEqual({ side: 'attacker', stage: 'final', source: { text: 'test.Medics' } });
		expect(back.units).toMatchObject({ 'cavalry-1': 99, medic: 2 });
	});

	it('auxiliaries: surgeons save part of the fallen, carts carry the slowest units, the supply depot trains them', async () => {
		// Training needs the depot (carts a higher level).
		const t = player({ 'buildings.speed': 1e6 });
		const ct = await t.start();
		const trainable = async () => ((await t.views(T0 + 1_000, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable;
		await t.construct(T0, ct.id, inner(ct).id, 0, 'supply-depot');
		expect((await trainable()).find((u) => u.unit === 'field-surgeon')?.blocked).toBeUndefined();
		expect((await trainable()).find((u) => u.unit === 'mule-cart')?.blocked).toEqual({
			text: 'starter-auxiliary.Requires {0} Lv {1}',
			vars: { 0: { text: 'starter-auxiliary.Supply Depot' }, 1: 3 },
		});

		// Surgeons: the same battle with and without them.
		const fight = async (surgeons: number) => {
			const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
			const a = player(fast);
			const b = player(fast);
			const ca = await a.start();
			const cb = await b.start();
			await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 100 }, true);
			if (surgeons) await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'field-surgeon', count: surgeons }, true);
			await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 300 }, true);
			await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
			const empty = { family: 'cavalry', units: {} };
			await a.run(T0, 'armies.send', {
				from: ca.id,
				x: cb.x,
				y: cb.y,
				units: { 'infantry-1': 100, ...(surgeons ? { 'field-surgeon': surgeons } : {}) },
				formation: [{ family: 'infantry', units: { 'infantry-1': 100 } }, empty, empty, empty, empty],
			});
			const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
			await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
			return ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		};
		const plain = (await fight(0)).losses.attacker['infantry-1'];
		expect(plain).toBeGreaterThan(10);
		const helped = await fight(50); // 100 saves asked, capped at 30% of the losses
		expect(helped.losses.attacker['infantry-1']).toBe(plain - Math.floor(plain * 0.3));
		expect(helped.losses.attacker['field-surgeon'] ?? 0).toBe(0);

		// Carts: 10 infantry ride a mule cart (150 tiles/h instead of 120); 20 do not all fit.
		const p = player({ 'armies.minSeconds': 0 });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 40 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'mule-cart', count: 2 }, true);
		const trip = async (units: Record<string, number>) => {
			await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x + 60), y: c.y, units });
			const list = (await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[];
			const army = list[list.length - 1];
			await p.run(T0, 'armies.recall', { id: army.id });
			return (army.arrivesAt - T0) / 1000;
		};
		const walk = await trip({ 'infantry-1': 10 });
		expect(walk).toBe(Math.ceil((60 / 120) * 3600));
		expect(await trip({ 'infantry-1': 10, 'mule-cart': 1 })).toBe(Math.ceil((60 / 150) * 3600));
		expect(await trip({ 'infantry-1': 11, 'mule-cart': 1 })).toBe(walk); // one walks
	});

	it('flat hp (siege defences) takes damage before the troops: fewer of them fall', async () => {
		const losses = async (buffer: number) => {
			const plugin = definePlugin({
				id: 'test-buffer',
				version: '0',
				dependsOn: ['battle'],
				setup(ctx) {
					ctx.services
						.get('battle')
						.addModifier(async (_api, side) =>
							side.role === 'defender' && buffer ? [{ source: { text: 'test.Buffer' }, stat: 'hp', flat: buffer }] : [],
						);
				},
			});
			const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
			const k = createKernel([...plugins, plugin]);
			const a = player(fast, k);
			const b = player(fast, k);
			const ca = await a.start();
			const cb = await b.start();
			await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 150 }, true);
			await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 100 }, true);
			await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['infantry', 'archer', 'cavalry', 'cavalry', 'cavalry'] });
			const empty = { family: 'archer', units: {} };
			await a.run(T0, 'armies.send', {
				from: ca.id,
				x: cb.x,
				y: cb.y,
				units: { 'infantry-1': 150 },
				formation: [{ family: 'infantry', units: { 'infantry-1': 150 } }, empty, empty, empty, empty],
			});
			const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
			await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
			return ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!.losses.defender['infantry-1'] ?? 0;
		};
		const plain = await losses(0);
		expect(plain).toBeGreaterThan(10);
		expect(await losses(300)).toBeLessThan(plain);
	});

	it('walls show what they do on their card, and speed up siege works by level; hidden stores show what they keep', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(T0, r, 50_000);
		const cards = async (now: number) =>
			((await p.views(now, ['buildings.slots'], { settlement: c.id }))['buildings.slots'] as CardsData).cards;
		const wallCard = (await cards(T0)).find((x) => JSON.stringify(x.title).includes('"starter-defense.Wall"'))!;
		const shown = JSON.stringify(wallCard.lines);
		expect(shown).toContain('starter-defense.Defence +{0} in every lane');
		expect(shown).toContain('starter-siege.Siege works and defences built {0}% faster');
		// A level-1 wall: 5% faster than the table's time.
		const moat = (await p.views(T0, ['starter-siege.wall'], { settlement: c.id }))['starter-siege.wall'] as SiegeWall;
		const seconds = moat.works.find((w) => w.id === 'moat')!.next!.seconds;
		await p.run(T0, 'starter-siege.fortify', { settlement: c.id, work: 'moat' });
		const q = ((await p.views(T0, ['starter-siege.wall'], { settlement: c.id }))['starter-siege.wall'] as SiegeWall).queue!;
		expect(q.finishesAt - q.startedAt).toBe(Math.ceil(seconds / 1.05) * 1000);
		await p.construct(T0, c.id, inner(c).id, 0, 'hidden-store');
		const store = (await cards(T0 + 1_000)).find((x) => JSON.stringify(x.title).includes('"starter-defense.Hidden Store"'))!;
		expect(JSON.stringify(store.lines)).toContain('starter-defense.Keeps {0} of every resource from raiders');
	});

	it('siege defences at the wall: works weaken attackers or strengthen the defence, defences add flat values and cost upkeep', async () => {
		// Build times as in the table (the wall's speed-up has its own test).
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0, 'starter-siege.wallSpeed': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		const wall = async (now: number) =>
			(await b.views(now, ['starter-siege.wall'], { settlement: cb.id }))['starter-siege.wall'] as SiegeWall;
		for (const r of ['stone', 'wood', 'metal', 'gold']) await b.grant(T0, r, 50_000);
		const forms = (
			(await b.views(T0, ['ui.forms'], { placement: 'building', type: 'wall', settlement: cb.id }))['ui.forms'] as ResolvedForm[]
		).map((f) => f.command);
		expect(forms).toEqual(expect.arrayContaining(['starter-siege.build', 'starter-siege.fortify']));

		// Cost from value (r = 1 for a rockfall platform): 100 split 35 / 35 / 20 / 10, 30 s each.
		const stone = (await b.pool(T0)).amounts.stone;
		await b.run(T0, 'starter-siege.build', { settlement: cb.id, device: 'rock-drop', count: 5 });
		expect((await b.pool(T0)).amounts.stone).toBeCloseTo(stone - 5 * 35);
		// A second order waits its turn (paid now); cancelled before it starts, its cost comes back.
		const beforeMoat = (await b.pool(T0)).amounts.stone;
		await b.run(T0, 'starter-siege.fortify', { settlement: cb.id, work: 'moat' });
		const waiting = (await wall(T0)).waiting;
		expect(waiting).toEqual([{ id: expect.any(String), kind: 'work', item: 'moat', amount: 1 }]);
		expect((await b.pool(T0)).amounts.stone).toBeLessThan(beforeMoat);
		await b.run(T0, 'starter-siege.cancel', { settlement: cb.id, id: waiting[0].id });
		expect((await b.pool(T0)).amounts.stone).toBeCloseTo(beforeMoat);
		expect((await wall(T0)).waiting).toEqual([]);
		await expect(b.run(T0, 'starter-siege.build', { settlement: cb.id, device: 'cheval', count: 1 })).rejects.toMatchObject({
			text: { text: 'starter-siege.Requires {0} Lv {1}', vars: { 0: { text: 'starter-defense.Wall' }, 1: 3 } },
		});
		const done = T0 + 150_000;
		expect((await wall(done)).devices.find((d) => d.id === 'rock-drop')!.count).toBe(5);
		// A rockfall platform is kept with stones and pay (its own upkeep mix in devices.csv).
		expect((await wall(done)).upkeep).toEqual({ stone: 5 * 1.5 * 0.5, gold: 5 * 1.5 * 0.5 });
		expect((await b.pool(done)).upkeep.stone).toBeCloseTo((5 * 1.5 * 0.5) / 3600);
		await b.run(done, 'starter-siege.fortify', { settlement: cb.id, work: 'moat' });
		expect((await wall(done + 600_000)).works.find((w) => w.id === 'moat')).toMatchObject({ level: 1, value: -4 });
		// The same for the generic widgets on the wall's entry: the queue (timers) and the works / defences (rows).
		const shown = async (now: number) =>
			(await b.views(now, ['starter-siege.queue', 'starter-siege.rows'], { settlement: cb.id })) as {
				'starter-siege.queue': TimersData | null;
				'starter-siege.rows': RowsData;
			};
		expect((await shown(done + 1))['starter-siege.queue']!.items[0]).toMatchObject({
			title: {
				text: 'starter-siege.Building: {0}',
				vars: { 0: { text: 'starter-siege.{item} Lv {n}', vars: { item: { text: 'starter-siege.Moat' }, n: 1 } } },
			},
			endsAt: done + 600_000,
		});
		const rows = (await shown(done + 600_000))['starter-siege.rows'];
		expect((await shown(done + 600_000))['starter-siege.queue']).toBeNull();
		expect(rows.sections[0].rows.find((r) => r.id === 'moat')).toMatchObject({ badge: { vars: { n: 1, max: 3 } } });
		expect(rows.sections[1].rows.find((r) => r.id === 'rock-drop')).toMatchObject({ title: { vars: { n: 5 } }, locked: false });
		expect(rows.sections[1].rows.find((r) => r.id === 'cheval')!.locked).toBe(true);

		// In battle: the attacker's attack -4% (moat), the defence +100 per lane (five platforms).
		const t = done + 600_000;
		await a.run(t, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 10 }, true);
		await a.run(t, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 10 } });
		const army = ((await a.views(t, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		// The Army page's generic timers: the attacker's march (recallable), the defender's warning.
		const march = ((await a.views(t, ['armies.marches']))['armies.marches'] as TimersData).items[0];
		expect(march).toMatchObject({ endsAt: army.arrivesAt, actions: [{ command: 'armies.recall', payload: { id: army.id } }] });
		const alert = (await b.views(t, ['armies.alerts']))['armies.alerts'] as TimersData;
		expect(alert).toMatchObject({ tone: 'warn', items: [{ id: army.id, endsAt: army.arrivesAt }] });
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const back = ((await a.views(army.arrivesAt, ['armies.marches']))['armies.marches'] as TimersData).items[0];
		expect(back.actions).toEqual([{ page: 'mail', label: { text: 'armies.Full report in the mailbox' } }]);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.modifiers.attacker).toContainEqual({
			source: { text: 'starter-siege.{0} Lv {1}', vars: { 0: { text: 'starter-siege.Moat' }, 1: 1 } },
			stat: 'attack',
			percent: -4,
		});
		expect(report.battle!.modifiers.defender).toContainEqual({
			source: { text: 'starter-siege.{0} ×{1}', vars: { 0: { text: 'starter-siege.Rockfall Platform' }, 1: 5 } },
			stat: 'defense',
			flat: 100,
		});
	});

	it('promotes survivors with the quota of the fallen, tier by tier and then across families', () => {
		const battle = defaultKernel.services.get('battle');
		// The design example: 100 tier-1 dead, 20 survive -> all 20 promote; 80 left / 2 = 40 tier-2
		// quota, which promotes 20 of the 30 who were tier 2 from the start (not the new ones).
		expect(battle.promotions({ 'infantry-1': 120, 'infantry-2': 30 }, { 'infantry-1': 100 })).toEqual([
			{ from: 'infantry-1', to: 'infantry-2', count: 20 },
			{ from: 'infantry-2', to: 'infantry-3', count: 20 },
		]);
		// No infantry survived: their quota promotes archers 1:1; 5 left / 2 = 2.5 at tier 2 -> one cavalry.
		expect(battle.promotions({ 'infantry-1': 10, 'archer-1': 5, 'cavalry-2': 3 }, { 'infantry-1': 10 })).toEqual([
			{ from: 'archer-1', to: 'archer-2', count: 5 },
			{ from: 'cavalry-2', to: 'cavalry-3', count: 1 },
		]);
		// The top tier cannot go higher.
		expect(battle.promotions({ 'cavalry-6': 15 }, { 'cavalry-6': 10 })).toEqual([]);
	});
});

describe('NPC settlements', () => {
	it('counts battle modifiers such as a hero leading the army', async () => {
		const hero = definePlugin({
			id: 'test-general',
			version: '0',
			dependsOn: ['battle'],
			setup(ctx) {
				ctx.services
					.get('battle')
					.addModifier(async (_api, side) =>
						side.role === 'attacker' ? [{ source: { text: 'test-general.Hero: Zhang Fei' }, stat: 'attack', percent: 100 }] : [],
					);
			},
		});
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, createKernel([...plugins, hero]));
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 20 }, true);
		const at = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...at, units: { 'infantry-1': 20 } });
		const { battle } = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(battle!.modifiers.attacker).toEqual([{ source: { text: 'test-general.Hero: Zhang Fei' }, stat: 'attack', percent: 100 }]);
		// 4 infantry per lane, attack 10 each, doubled — and tripled again against archers.
		for (const lane of battle!.lanes) expect(lane.attacker.attack).toBeCloseTo(4 * 10 * 2 * (lane.attacker.counters ? 3 : 1));
	});

	it('leave no resource pool behind for an army (only settlements hold resources)', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 5 }, true);
		const at = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...at, units: { 'infantry-1': 5 } });
		const [army] = (await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[];
		await p.run(T0 + 5_000, 'armies.sync'); // arrives and comes back
		const row = await db
			.prepare('SELECT COUNT(*) AS n FROM resources_balances WHERE holder = ?')
			.bind(`army:${army.id}`)
			.first<{ n: number }>();
		expect(row!.n).toBe(0);
	});

	it('can be raided: outposts give food, fortresses give troops, strong defence wins', async () => {
		const p = player({
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'npc-camps.levels': {
				'npc-outpost': { 1: { stockade: 10, lane: {} } },
				'npc-fortress': { 1: { stockade: 1e6, lane: { 1: 80 } } },
			},
		});
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-2', count: 50 }, true);
		// Place an outpost and a fortress right next to the capital's ring.
		const place = async (kind: string, dx: number) => {
			await p.run(T0, 'npc-camps.spawnAt', { kind, x: wrap(c.x + dx), y: c.y }, true);
			return { x: wrap(c.x + dx), y: c.y };
		};
		const outpost = await place('npc-outpost', 5);
		const fortress = await place('npc-fortress', 7);

		await p.run(T0, 'armies.send', { from: c.id, x: outpost.x, y: outpost.y, units: { 'cavalry-2': 25 } });
		await p.run(T0, 'armies.send', { from: c.id, x: fortress.x, y: fortress.y, units: { 'cavalry-2': 25 } });
		// Each leg takes 1 s at this speed: look while they are on the way back.
		const list = (await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[];
		const raid = list.find((a) => a.target.x === outpost.x)!;
		expect(raid.report).toMatchObject({ outcome: 'victory', target: { kind: 'npc-outpost' } });
		// Level 1: 5,000 resources split evenly (no terrain bonus here), within what survivors carry (1,250).
		expect(raid.loot).toEqual({ food: 250, wood: 250, stone: 250, metal: 250, gold: 250 });
		const siege = list.find((a) => a.target.x === fortress.x)!;
		expect(siege.report?.outcome).toBe('defeat');
		expect(siege.units['cavalry-2']).toBeLessThan(25);
	});

	it('come in levels 1-10: garrison per lane by tier, stockade, loot leaning to the tile, captured units, heroes from level 3', async () => {
		// Garrisons as small as a hundredth of the data's, so 200 dragon riders can win.
		const p = player({
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'terrain.bonus': { ...NO_TERRAIN_BONUS, forest: { wood: 30 } },
			'npc-camps.levels': {
				'npc-outpost': { 7: { lane: { 1: 50, 2: 40, 3: 20, 4: 3 } } },
				'npc-fortress': { 5: { lane: { 1: 45, 2: 22, 3: 3 } } },
			},
		});
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-6', count: 300 }, true);
		const at = (dx: number) => ({ x: wrap(c.x + dx), y: c.y });
		await p.run(T0, 'terrain.paint', { ...at(5), width: 1, height: 1, terrain: 'forest' }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at(5), level: 7 }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...at(7), level: 5 }, true);
		const camps = (await p.views(T0, ['settlements.map'], { x: String(c.x), y: String(c.y), r: '9' }))['settlements.map'] as MapTile[];
		expect(camps.find((t) => t.x === at(5).x && t.y === c.y)!.name).toBe('npc-camps.Rebel Granary');
		expect(camps.find((t) => t.x === at(7).x && t.y === c.y)!.name).toBe('npc-camps.Border Fort');
		await expect(p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at(9), level: 11 }, true)).rejects.toThrow();

		await p.run(T0, 'armies.send', { from: c.id, ...at(5), units: { 'cavalry-6': 200 } }); // carry 30,000
		await p.run(T0, 'armies.send', { from: c.id, ...at(7), units: { 'cavalry-6': 100 } });
		const list = (await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[];
		const raid = list.find((a) => a.target.x === at(5).x)!.report!;
		expect(raid.outcome).toBe('victory');
		// Level 7: 220,000, within the 30,000 carried, with bias 0.45 to wood (forest): wood 11% + 45% (16,800), the others 11% (3,300) each.
		expect(raid.loot).toEqual({ wood: 16800, food: 3300, stone: 3300, metal: 3300, gold: 3300 });
		// Garrison: each lane 50 / 40 / 20 / 3 of tiers 1-4; stockade 450; three heroes.
		for (const lane of raid.battle!.lanes) expect(Object.values(lane.defender.units).reduce((a, b) => a + b, 0)).toBe(113);
		expect(raid.battle!.modifiers.defender).toEqual(
			expect.arrayContaining([
				{ source: { text: 'npc-camps.Stockade' }, stat: 'defense', flat: 450 },
				{
					// Three named leaders: name-part keys the client spells.
					source: {
						text: 'npc-camps.Defending heroes: {0}',
						vars: { 0: Array(3).fill({ text: 'i18n.{0}', vars: { 0: expect.stringMatching(/^s:\S+ m:\S+$/) } }) },
					},
					stat: 'attack',
					percent: 72,
				},
			]),
		);
		const siege = list.find((a) => a.target.x === at(7).x)!.report!;
		expect(siege.outcome).toBe('victory');
		// Level 5 fortress: 750 tier-1, 400 tier-2, 100 tier-3 captured, families at random.
		const byTier = (tier: number) =>
			Object.entries(siege.captured)
				.filter(([u]) => u.endsWith(`-${tier}`))
				.reduce((a, [, n]) => a + n, 0);
		expect([byTier(1), byTier(2), byTier(3)]).toEqual([750, 400, 100]);
	});

	it('seed a new world block by block: about three in each 16 x 16 block, once', async () => {
		const gm = player(undefined, unitsKernel);
		// Camps (any test's) in block (bx, by): x from bx * 16, y likewise (blocks below 32 need no wrapping).
		const campsIn = async (bx: number, by: number) =>
			(await db
				.prepare(
					"SELECT COUNT(*) AS n FROM settlements_settlements WHERE kind IN ('npc-outpost', 'npc-fortress') AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?",
				)
				.bind(bx * 16, bx * 16 + 15, by * 16, by * 16 + 15)
				.first<{ n: number }>())!.n;
		let block: [number, number] = [1, 1];
		for (let i = 0; (await campsIn(...block)) > 0; i++) block = [1 + (i % 30), 1 + Math.floor(i / 30)];
		await gm.run(T0, 'npc-camps.populate', { blocks: [block] }, true);
		const n = await campsIn(...block);
		expect(n).toBeGreaterThanOrEqual(2);
		expect(n).toBeLessThanOrEqual(4);
		// Again: the block has camps, so nothing more.
		await gm.run(T0, 'npc-camps.populate', { blocks: [block] }, true);
		expect(await campsIn(...block)).toBe(n);
		await expect(gm.run(T0, 'npc-camps.populate', { blocks: [] }, true)).rejects.toMatchObject({
			text: { text: 'kernel.{0} must be a list of {1}-{2} items', vars: { 0: 'blocks', 1: 1, 2: 32 } },
		});
		// On the map, a camp's tile tells its level, defenders and what a victory brings.
		const camp = await db
			.prepare(
				"SELECT x, y, kind FROM settlements_settlements WHERE kind IN ('npc-outpost', 'npc-fortress') AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT 1",
			)
			.bind(block[0] * 16, block[0] * 16 + 15, block[1] * 16, block[1] * 16 + 15)
			.first<{ x: number; y: number; kind: string }>();
		const grid = (await gm.views(T0, ['world-map.grid'], { x: String(camp!.x), y: String(camp!.y), r: '0' }))['world-map.grid'] as GridData;
		const texts = grid.cells[0].info!.map((l) => l.text.text);
		expect(texts.some((t) => t.startsWith('npc-camps.Defenders: about {0} in all, up to tier {1}, '))).toBe(true);
		expect(texts).toContain(
			camp!.kind === 'npc-outpost'
				? 'npc-camps.Victory: up to {0} resources (as much as your survivors carry)'
				: 'npc-camps.Victory: captures {0}',
		);
	});

	it('are registered by their own plugin and spawned by the GM onto free land', async () => {
		const gm = player(undefined, unitsKernel);
		await gm.run(T0, 'npc-camps.spawn', { kind: 'npc-outpost', count: 3 }, true);
		await expect(gm.run(T0, 'npc-camps.spawn', { kind: 'npc-outpost', count: 1 })).rejects.toThrow(/Unknown command/);
		const { results } = await db
			.prepare(
				"SELECT s.owner_id, s.x, s.y, (SELECT COUNT(*) FROM world_map_tiles t WHERE t.entity = 'settlement:' || s.id) AS tiles FROM settlements_settlements s WHERE kind = 'npc-outpost' AND created_at = ?",
			)
			.bind(T0)
			.all<{ owner_id: string | null; tiles: number }>();
		expect(results.length).toBeGreaterThanOrEqual(3);
		expect(results.every((r) => r.owner_id === null && r.tiles === 1)).toBe(true);
	});
});

describe('bandits', () => {
	const H = 3_600_000;
	const incoming = async (p: ReturnType<typeof player>, now: number) =>
		(await p.views(now, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
	const prestigeOf = async (p: ReturnType<typeof player>, now: number) =>
		((await p.views(now, ['prestige.status']))['prestige.status'] as PrestigeStatus).value;
	const sync = (p: ReturnType<typeof player>, now: number) => p.run(now, 'timeline.sync', { entity: `bandits:${p.id}` }, true);

	it('start with the capital: none in the first hours nor without prestige, then they come, sooner as prestige rises', async () => {
		// No jitter, so the times are exact.
		const p = player({ 'bandits.rules': { interval: { jitter: 0 } } });
		const c = await p.start();
		// First check 4 hours after founding (prestige 0 stands still): no prestige, no band.
		await sync(p, T0 + 4 * H);
		expect(await incoming(p, T0 + 4 * H)).toEqual([]);
		// With prestige: the next check (4 hours on) sends one; it arrives 3 minutes later (no scouts).
		await p.run(T0 + 4 * H, 'prestige.grant', { amount: 60 }, true);
		await sync(p, T0 + 8 * H);
		const [band] = await incoming(p, T0 + 8 * H);
		expect(band).toMatchObject({ settlement: c.id, arrivesAt: T0 + 8 * H + 3 * 60_000 });
		expect(band.attackerName).toBeTruthy();
		// The prestige just granted counts as "recent": the following check comes sooner than 4 hours.
		const row = await db.prepare('SELECT next_at FROM bandits_players WHERE player_id = ?').bind(p.id).first<{ next_at: number }>();
		expect(row!.next_at - (T0 + 8 * H)).toBeLessThan(4 * H);
		expect(row!.next_at - (T0 + 8 * H)).toBeGreaterThanOrEqual(20 * 60_000);
	});

	it('win against an empty town: they plunder, and the player loses prestige for what was taken', async () => {
		const p = player();
		const c = await p.start();
		await p.run(T0, 'prestige.grant', { amount: 100 }, true);
		await p.run(T0, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0);
		const before = (await p.pool(T0)).amounts;
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		expect(await incoming(p, band.arrivesAt)).toEqual([]); // gone once it struck
		const after = (await p.pool(band.arrivesAt)).amounts;
		const taken = Object.keys(before).reduce((sum, r) => sum + Math.max(0, before[r] - after[r]), 0);
		expect(taken).toBeGreaterThan(0);
		expect(await prestigeOf(p, band.arrivesAt)).toBeCloseTo(100 - taken * 0.5 * 0.001, 3);
		const mail = (await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!;
		expect(mail).toMatchObject({ title: { text: 'war-reports.{settlement} was raided by {name}' } });
		const report = (mail.data as DefenseMail).report;
		expect(report.attacker).toMatchObject({ name: band.attackerName!.text, level: expect.any(Number) });
		expect(report.prestige).toBeLessThan(0);
	});

	it('beaten by a garrison: the player gains prestige for their fallen and may find something', async () => {
		// Always a drop, worth next to nothing: exactly one draw.
		const p = player({ 'bandits.rules': { drops: { chance: 1, value: 0.001, perLevel: 0 } }, 'loot.rules': { empty: { share: 0 } } });
		const c = await p.start();
		await p.run(T0, 'prestige.grant', { amount: 60 }, true);
		for (const u of ['infantry-3', 'archer-3', 'cavalry-3'])
			await p.run(T0, 'troops.grant', { settlement: c.id, unit: u, count: 500 }, true);
		await p.run(T0, 'bandits.spawn', { settlement: c.id }, true);
		await expect(p.run(T0, 'bandits.spawn', { settlement: c.id }, true)).rejects.toThrow(/No settlement/); // one band at a time
		const [band] = await incoming(p, T0);
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.outcome).toBe('defeat'); // the attackers'
		expect(Object.values(report.losses.attacker).some((n) => n > 0)).toBe(true);
		expect(report.prestige).toBeGreaterThan(0);
		expect(await prestigeOf(p, band.arrivesAt)).toBeCloseTo(60 + report.prestige!, 3);
		// One draw: a resource cache or a levy order for one of their families.
		expect(report.rewards).toEqual([
			expect.objectContaining({ kind: expect.stringMatching(/^(resource|item)$/), count: expect.any(Number) }),
		]);
	});

	it('come in numbers by prestige, in tiers by level, never in round blocks', async () => {
		const band = async (amount: number, rules: Record<string, unknown> = {}) => {
			const p = player({ 'bandits.rules': rules });
			await p.start();
			await p.run(T0, 'prestige.grant', { amount }, true);
			await p.run(T0, 'bandits.spawn', {}, true);
			const row = await db
				.prepare('SELECT level, lanes FROM bandits_raids WHERE player_id = ?')
				.bind(p.id)
				.first<{ level: number; lanes: string }>();
			const lanes = JSON.parse(row!.lanes) as { family: string; units: Record<string, number> }[];
			const counts = lanes.flatMap((l) => Object.values(l.units));
			const tiers = lanes.flatMap((l) => Object.keys(l.units).map((u) => Number(u.split('-').at(-1))));
			return { level: row!.level, total: counts.reduce((a, b) => a + b, 0), counts, maxTier: Math.max(...tiers) };
		};
		// Prestige 10,000: about 60 + 2 x 10,000 bandits, give or take 20%.
		const big = await band(10_000, { level: { spread: 0 } });
		expect(big.total).toBeGreaterThan(20_060 * 0.79);
		expect(big.total).toBeLessThan(20_060 * 1.21);
		// The level (from the same prestige: rank 9 of office -> level 3) only says which tiers: level 3 brings tiers 1-2.
		expect(big).toMatchObject({ level: 3, maxTier: 2 });
		// Not in round blocks: lanes and tiers differ.
		expect(new Set(big.counts).size).toBeGreaterThan(3);
		// Without jitter, the size is exact: level 1-2 bands at prestige 100 bring 60 + 200 tier-1 units.
		const small = await band(100, { size: { jitter: 0, laneJitter: 0, mixJitter: 0 }, level: { spread: 0 } });
		expect(small.maxTier).toBe(1);
		expect(Math.abs(small.total - 260)).toBeLessThanOrEqual(5);
	});

	it('injure the heroes leading a routed army', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0, 'buildings.speed': 1e6 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		await a.construct(T0, ca.id, inner(ca).id, 0, 'tavern');
		await a.grant(T0 + 1_000, 'gold', 5000);
		await a.run(T0 + 1_000, 'heroes.recruit', { settlement: ca.id, venue: 'tavern', slot: 0 });
		const [hero] = (await a.views(T0 + 1_000, ['heroes.list']))['heroes.list'] as HeroInfo[];
		await a.run(T0 + 1_000, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 5 }, true);
		for (const u of ['infantry-3', 'archer-3', 'cavalry-3'])
			await b.run(T0 + 1_000, 'troops.grant', { settlement: cb.id, unit: u, count: 2000 }, true);
		await a.run(T0 + 1_000, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'infantry-1': 5 }, hero1: hero.id });
		const army = ((await a.views(T0 + 1_000, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0]?.report;
		expect(report?.battle?.grade.attacker).toBe('routed');
		expect(((await a.views(army.arrivesAt, ['heroes.list']))['heroes.list'] as HeroInfo[])[0].duty).toBe('realms.injured');
	});

	it('injure the heroes defending a routed town, as a lost adventure does', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await p.run(T0 + 1_000, 'prestige.grant', { amount: 2000 }, true);
		await p.run(T0 + 1_000, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0 + 1_000);
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.battle!.grade.defender).toBe('routed'); // no troops at all
		const [hero] = (await p.views(band.arrivesAt, ['heroes.list']))['heroes.list'] as HeroInfo[];
		expect(hero.duty).toBe('realms.injured');
		const injured = ((await p.views(band.arrivesAt, ['realms.overview']))['realms.overview'] as RealmsOverview).injured;
		expect(injured.map((i) => i.hero)).toEqual([hero.id]);
	});

	it('scouts see them coming sooner', async () => {
		const p = player();
		await p.start();
		await p.run(T0, 'research.setLevel', { tech: 'scouts', level: 2 }, true);
		await p.run(T0, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0);
		expect(band.arrivesAt).toBe(T0 + 30 * 60_000);
		expect(band.intel).toMatchObject({ level: 2 });
	});
});

// The example plugin of docs/plugin-guide.md: kept working by this test.
describe('example plugin (watchtower)', () => {
	const kernel = createKernel([...plugins, watchtower]);

	it('is built like any building and adds its defence to every lane when the settlement is attacked', async () => {
		const p = player({ 'buildings.speed': 1e6, 'watchtower.rules': { defensePerLevel: 50 } }, kernel);
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(T0, r, 100_000);
		await p.construct(T0, c.id, inner(c).id, 0, 'watchtower');
		await p.construct(T0 + 1_000, c.id, inner(c).id, 0); // to level 2
		await p.run(T0 + 2_000, 'prestige.grant', { amount: 60 }, true);
		await p.run(T0 + 2_000, 'bandits.spawn', {}, true);
		const [band] = (await p.views(T0 + 2_000, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.battle!.modifiers.defender).toContainEqual(
			expect.objectContaining({ source: { text: 'watchtower.Watchtower' }, stat: 'defense', flat: 100 }),
		);
	});
});

describe('uprooting NPC camps', () => {
	const levels = {
		'npc-camps.levels': {
			'npc-fortress': { 1: { stockade: 0, lane: { 1: 10 }, loot: { 1: 3 } }, 2: { stockade: 1e6, lane: { 1: 10 } } },
		},
	};
	const setup = async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0, ...levels });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-2', count: 500 }, true);
		const camp = async (dx: number, dy: number, level: number) => {
			const at = { x: wrap(c.x + dx), y: wrap(c.y + dy) };
			await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...at, level }, true);
			return at;
		};
		const holder = async (at: { x: number; y: number }) =>
			(await db.prepare('SELECT entity FROM world_map_tiles WHERE x = ? AND y = ?').bind(at.x, at.y).first<{ entity: string }>())?.entity;
		const reports = async (t: number) =>
			((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).map((a) => a.report!).filter(Boolean);
		return { p, c, camp, holder, reports };
	};

	it('only on the land of outer cities; five lanes won clears the camp, a lost battle leaves it', async () => {
		const { p, c, camp, holder, reports } = await setup();
		const near = await camp(2, 1, 1);
		const strong = await camp(-2, 0, 2);
		const far = await camp(5, 0, 1);
		const forms = async (at: { x: number; y: number }) =>
			((await p.views(T0, ['ui.forms'], { placement: 'tile', x: String(at.x), y: String(at.y) }))['ui.forms'] as ResolvedForm[]).map(
				(f) => f.command,
			);
		expect(await forms(near)).toContain('npc-camps.uproot');
		// A battle like an attack: the same formation editor (send options for battles).
		const shown = (await p.views(T0, ['ui.forms'], { placement: 'tile', x: String(near.x), y: String(near.y) }))[
			'ui.forms'
		] as ResolvedForm[];
		const widgets = (command: string) =>
			shown
				.find((f) => f.command === command)!
				.fields.filter((f) => f.type === 'widget')
				.map((f) => f.name);
		expect(widgets('armies.send').length).toBeGreaterThan(0);
		expect(widgets('npc-camps.uproot')).toEqual(widgets('armies.send'));
		expect(await forms(far)).not.toContain('npc-camps.uproot');
		expect(await forms(far)).toContain('armies.send');
		await expect(p.run(T0, 'npc-camps.uproot', { from: c.id, ...far, units: { 'cavalry-2': 50 } })).rejects.toMatchObject({
			text: { text: 'npc-camps.Only camps on the land of your outer cities can be uprooted' },
		});
		await expect(
			p.run(T0, 'npc-camps.uproot', { from: c.id, x: wrap(c.x + 2), y: wrap(c.y - 2), units: { 'cavalry-2': 50 } }),
		).rejects.toMatchObject({
			text: { text: 'npc-camps.Only NPC fortresses and outposts can be uprooted' },
		});

		// Behind a stockade too strong to beat: an ordinary (lost) battle, the camp stays.
		await p.run(T0, 'npc-camps.uproot', { from: c.id, ...strong, units: { 'cavalry-2': 50 } });
		await p.run(T0 + 1_500, 'armies.sync');
		expect((await reports(T0 + 1_500))[0]).toMatchObject({ outcome: 'defeat' });
		expect(await holder(strong)).toMatch(/^settlement:/);

		// Five lanes won: the camp is taken off the map (its level too), the troops it gives still come home.
		const before = await holder(near);
		await p.run(T0 + 5_000, 'npc-camps.uproot', { from: c.id, ...near, units: { 'cavalry-2': 250 } });
		await p.run(T0 + 6_500, 'armies.sync');
		const won = (await reports(T0 + 6_500)).find((r) => r.outcome === 'victory')!;
		expect(won.battle!.lanes.every((l) => l.winner === 'attacker')).toBe(true);
		expect(won.note).toEqual({ text: 'npc-camps.Uprooted: the land is free' });
		expect(Object.values(won.captured).reduce((a, b) => a + b, 0)).toBe(3);
		expect(await holder(near)).toBeUndefined();
		const id = before!.slice('settlement:'.length);
		expect(await db.prepare('SELECT id FROM settlements_settlements WHERE id = ?').bind(id).first()).toBeNull();
		expect(await db.prepare('SELECT level FROM npc_camps_levels WHERE settlement_id = ?').bind(id).first()).toBeNull();
	});

	it('clears a camp once when two armies arrive together, in parallel commands', async () => {
		const { p, c, camp, reports } = await setup();
		const near = await camp(2, 0, 1);
		await p.run(T0, 'npc-camps.uproot', { from: c.id, ...near, units: { 'cavalry-2': 200 } });
		await p.run(T0, 'npc-camps.uproot', { from: c.id, ...near, units: { 'cavalry-2': 200 } });
		await Promise.all([p.run(T0 + 1_500, 'armies.sync'), p.run(T0 + 1_500, 'armies.sync')]);
		const notes = (await reports(T0 + 1_500)).map((r) => r.note?.text).sort();
		expect(notes).toEqual(['npc-camps.The camp is gone', 'npc-camps.Uprooted: the land is free']);
	});
});
