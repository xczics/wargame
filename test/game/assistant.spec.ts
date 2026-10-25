/** The official assistant's server side (gameplay.md §15): a GM switch, its page shown only while on, and what the browser needs. */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import type { NpcCampLevels, UiLayout, UnitCatalog } from '../../src/shared/api';
import type { ResearchCatalog } from '../../src/shared/research';
import type { TreeData } from '../../src/shared/ui';
import { campLanes, laneTotals } from '../../web/plugins/assistant/camp-force';
import { planResearch, type TechNode } from '../../web/plugins/assistant/research-plan';
import { db, defaultKernel } from '../helpers';

const baked = (id: string, config: Record<string, unknown> = {}) =>
	defaultKernel.statics
		.find((x) => x.id === id)!
		.compute({ rules: { config: engineContext(defaultKernel, 'x', 0, config).config }, db } as never);

describe('assistant', () => {
	it('is off until the GM switches it on; its page is declared with that condition', async () => {
		expect(await baked('assistant.settings')).toEqual({ enabled: false, commandsPerScan: 5 });
		expect(await baked('assistant.settings', { 'assistant.enabled': 1, 'assistant.commandsPerScan': 8 })).toEqual({
			enabled: true,
			commandsPerScan: 8,
		});
		const layout = defaultKernel.meta.get('ui')!() as UiLayout;
		expect(layout.pages.find((p) => p.id === 'assistant')).toMatchObject({
			widget: 'assistant.page',
			when: { static: 'assistant.settings', field: 'enabled' },
			props: { views: ['heroes.list', 'realms.overview', 'research.state'] },
		});
	});

	it("knows each camp kind's garrison by level (a lane's worth by tier), as the GM's rule has it", async () => {
		const garrisons = (await baked('npc-camps.levels')) as NpcCampLevels;
		expect(Object.keys(garrisons)).toEqual(expect.arrayContaining(['npc-outpost', 'npc-fortress']));
		expect(Object.values(garrisons['npc-outpost']['1'].lane).every((n) => n > 0)).toBe(true);
		const tuned = (await baked('npc-camps.levels', {
			'npc-camps.levels': { 'npc-outpost': { 1: { lane: { 1: 7 } } } },
		})) as typeof garrisons;
		expect(tuned['npc-outpost']['1'].lane).toEqual({ 1: 7 });
	});

	describe('research plan (gameplay.md §15.2.1)', () => {
		const nodes: TechNode[] = [
			{ id: 'a', maxLevel: 5 },
			{ id: 'b', maxLevel: 5, requires: { a: 2 } },
			{ id: 'c', maxLevel: 3, requires: { b: 1, a: 3 } },
			{ id: 'x', maxLevel: 2, requires: { y: 1 } },
			{ id: 'y', maxLevel: 2, requires: { x: 1 } },
		];
		const tree = new Map(nodes.map((t) => [t.id, t]));
		const plain = (steps: { tech: string; level: number }[]) => steps.map((s) => `${s.tech}${s.level}`);

		it('expands a target into one level a step, prerequisites (and theirs) first, nothing already had', () => {
			const plan = planResearch([{ id: 't', tech: 'c', level: 2 }], tree, { a: 1 });
			expect(plain(plan.steps)).toEqual(['a2', 'b1', 'a3', 'c1', 'c2']);
			expect(plan.steps.every((s) => s.target === 't')).toBe(true);
			expect(plan.problems).toEqual({});
			expect(planResearch([{ id: 't', tech: 'b', level: 1 }], tree, { a: 5, b: 1 }).steps).toEqual([]);
		});

		it('does a level shared by several targets once, for the first of them', () => {
			const plan = planResearch(
				[
					{ id: 'one', tech: 'b', level: 2 },
					{ id: 'two', tech: 'c', level: 1 },
					{ id: 'three', tech: 'a', level: 2 },
				],
				tree,
				{},
			);
			expect(plain(plan.steps)).toEqual(['a1', 'a2', 'b1', 'b2', 'a3', 'c1']);
			expect(plan.steps.filter((s) => s.target === 'two').map((s) => `${s.tech}${s.level}`)).toEqual(['a3', 'c1']);
			expect(plan.steps.some((s) => s.target === 'three')).toBe(false);
		});

		it('plans nothing for a target past a cap, of an unknown tech or going round, and goes on with the next', () => {
			const plan = planResearch(
				[
					{ id: 'max', tech: 'c', level: 4 },
					{ id: 'unknown', tech: 'zzz', level: 1 },
					{ id: 'cycle', tech: 'x', level: 1 },
					{ id: 'ok', tech: 'a', level: 1 },
				],
				tree,
				{},
			);
			expect(plan.problems).toEqual({
				max: { tech: 'c', reason: 'max', level: 4, max: 3 },
				unknown: { tech: 'zzz', reason: 'unknown' },
				cycle: { tech: 'x', reason: 'cycle' },
			});
			// The capped target's prerequisites are not left behind either.
			expect(plain(plan.steps)).toEqual(['a1']);
		});

		it('works on the static tree as the browser has it: every step after its prerequisites', async () => {
			const catalog = ((await baked('research.techs')) as TreeData).data as ResearchCatalog;
			const techs = new Map(catalog.techs.map((t) => [t.id, t]));
			// The deepest tech of the tree, at its cap.
			const top = [...catalog.techs].sort((p, q) => (q.tier ?? 1) - (p.tier ?? 1))[0];
			const plan = planResearch([{ id: 't', tech: top.id, level: top.maxLevel }], techs, {});
			expect(plan.problems).toEqual({});
			const had: Record<string, number> = {};
			for (const s of plan.steps) {
				expect(s.level).toBe((had[s.tech] ?? 0) + 1);
				for (const [req, n] of Object.entries(techs.get(s.tech)!.requires ?? {})) expect(had[req] ?? 0).toBeGreaterThanOrEqual(n);
				had[s.tech] = s.level;
			}
			expect(had[top.id]).toBe(top.maxLevel);
		});
	});

	describe('raids by the garrison (camp-force)', () => {
		// The starter units' attack at the default rules, as the static view bakes it.
		const units = (defaultKernel.meta.get('units')!() as { id: string; family?: string; tier?: number }[]).filter((u) => u.family);
		const attackOf = async () =>
			Object.fromEntries(Object.entries((await baked('troops.units')) as UnitCatalog).map(([id, u]) => [id, u.attack]));
		const unit = (family: string, tier: number) => units.find((u) => u.family === family && u.tier === tier)!.id;
		const families = [...new Set(units.map((u) => u.family!))];

		it('every lane is the camp lane x the factor, of one family; families picked at random where the troops allow', async () => {
			const attack = await attackOf();
			const have = Object.fromEntries(families.map((f) => [unit(f, 1), 2000]));
			const plan = campLanes({ lane: { 1: 400 }, factor: 2, count: 5, lanes: 5, have, units, attack, shuffle: true })!;
			expect(plan).toHaveLength(5);
			for (const l of plan) expect(l.units).toEqual({ [unit(l.family, 1)]: 800 });
			// Nothing sent beyond what the settlement has.
			for (const [u, n] of Object.entries(laneTotals(plan))) expect(n).toBeLessThanOrEqual(have[u]);
		});

		it('three lanes in strength: three filled, two empty', async () => {
			const attack = await attackOf();
			const have = { [unit(families[0], 1)]: 5000 };
			const plan = campLanes({ lane: { 1: 400 }, factor: 2, count: 3, lanes: 5, have, units, attack, shuffle: false })!;
			expect(plan.filter((l) => Object.keys(l.units).length)).toHaveLength(3);
			expect(laneTotals(plan)).toEqual({ [unit(families[0], 1)]: 2400 });
		});

		it('a tier short is made up with higher tiers of the family bringing as much attack (no bonuses)', async () => {
			const attack = await attackOf();
			const f = families[0];
			const [t1, t2, t3] = [unit(f, 1), unit(f, 2), unit(f, 3)];
			// 500 of the 800 tier 1 wanted are missing: tier 2 first, then tier 3.
			const plan = campLanes({
				lane: { 1: 400 },
				factor: 2,
				count: 1,
				lanes: 1,
				have: { [t1]: 300, [t2]: 100, [t3]: 1000 },
				units,
				attack,
				shuffle: false,
			})!;
			const sent = plan[0].units;
			expect(sent[t1]).toBe(300);
			expect(sent[t2]).toBe(100);
			const missing = 500 * attack[t1] - 100 * attack[t2];
			expect(sent[t3]).toBe(Math.ceil(missing / attack[t3]));
			// What the lane brings is never less than the wanted attack.
			const brought = Object.entries(sent).reduce((a, [u, n]) => a + n * attack[u], 0);
			expect(brought).toBeGreaterThanOrEqual(800 * attack[t1]);
		});

		it('cannot fill the lanes: null, and lower tiers never stand in for higher ones', async () => {
			const attack = await attackOf();
			const f = families[0];
			expect(
				campLanes({ lane: { 1: 400 }, factor: 2, count: 5, lanes: 5, have: { [unit(f, 1)]: 3000 }, units, attack, shuffle: true }),
			).toBeNull();
			expect(
				campLanes({ lane: { 2: 10 }, factor: 1, count: 1, lanes: 1, have: { [unit(f, 1)]: 1e6 }, units, attack, shuffle: false }),
			).toBeNull();
		});
	});
});
