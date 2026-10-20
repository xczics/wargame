/** The official assistant's server side (gameplay.md §15): a GM switch, its page shown only while on, and what the browser needs. */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import type { UiLayout } from '../../src/shared/api';
import type { ResearchCatalog } from '../../src/shared/research';
import type { TreeData } from '../../src/shared/ui';
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
		const garrisons = (await baked('npc-camps.garrisons')) as Record<string, Record<string, { lane: Record<string, number> }>>;
		expect(Object.keys(garrisons)).toEqual(expect.arrayContaining(['npc-outpost', 'npc-fortress']));
		expect(Object.values(garrisons['npc-outpost']['1'].lane).every((n) => n > 0)).toBe(true);
		const tuned = (await baked('npc-camps.garrisons', {
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
});
