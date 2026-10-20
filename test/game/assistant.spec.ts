/** The official assistant's server side (gameplay.md §15): a GM switch, its page shown only while on, and what the browser needs. */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import type { UiLayout } from '../../src/shared/api';
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
			props: { views: ['heroes.list', 'realms.overview'] },
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
});
