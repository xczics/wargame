/** Hero rebirth (docs/design/gameplay.md §17.1): level 1 again, the talent grown, free points; one in N, sure after 2N. */
import { describe, expect, it } from 'vitest';
import type { HeroInfo, HeroesState, RebirthCardData, RebirthReborn, RebirthRules } from '../../src/shared/api';
import { expToNextOf, type HeroGrowth, reincarnated } from '../../src/shared/heroes';
import { fillTalents } from '../../src/plugins/rebirth';
import { realmText } from '../../src/shared/rebirth';
import { starred, stars } from '../../web/plugins/rebirth/parts';
import { T0, inner, player } from '../helpers';

const pill = 'rebirth-pill';

async function heroAt90(rules: Record<string, unknown> = {}) {
	const p = player({ 'buildings.speed': 1e6, ...rules });
	const c = await p.start();
	await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
	const at = T0 + 100_000;
	await p.grant(at, 'gold', 5000);
	await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
	const hero = async () => ((await p.views(at, ['heroes.roster']))['heroes.roster'] as HeroInfo[])[0];
	const toLevel = async (level: number) => {
		while ((await hero()).level < level) await p.run(at, 'heroes.grantExp', { hero: (await hero()).id, exp: 5_000_000 }, true);
	};
	await toLevel(90);
	const card = async () =>
		((await p.views(at, ['heroes.state'], { settlement: c.id }))['heroes.state'] as HeroesState).heroes[0].parts?.rebirth as
			RebirthCardData | undefined;
	return { p, c, at, hero, toLevel, card };
}

describe('rebirth', () => {
	it('starts a hero over: talent points off, spent free points into what it was born with, talent grown, 6 x N free points', async () => {
		const { p, at, hero, card } = await heroAt90();
		const before = await hero();
		// Some free points spent: they stay in the attributes (now as born with), no longer to be taken back.
		await p.run(at, 'heroes.allocate', { hero: before.id, points: { might: 10 } });
		const spent = await hero();
		expect(await card()).toBeUndefined();
		await p.run(at, 'items.grant', { item: pill, count: 1 }, true);
		const list = async () => ((await p.views(at, ['heroes.list']))['heroes.list'] as Omit<HeroInfo, 'bonus'>[])[0];
		const held = await list();
		const state = async () => (await p.views(at, ['heroes.state']))['heroes.state'] as HeroesState;
		const heldState = await state();
		const { reply } = await p.run(at, `items.use.${pill}`, { hero: before.id });
		// What it rolled comes with the answer; the browser rebirths the hero it holds the same way (2026-11-24).
		const growth = await p.static<HeroGrowth>(at, 'heroes.growth');
		const r = reply?.['rebirth.reborn'] as RebirthReborn;
		expect(r.hero).toBe(before.id);
		expect({ ...reincarnated(held, r), expToNext: expToNextOf(growth, 1) }).toEqual(await list());
		const { max } = await p.static<RebirthRules>(at, 'rebirth.rules');
		expect(starred(heldState, r.hero, max).heroes[0].parts).toEqual((await state()).heroes[0].parts);
		const after = await hero();
		expect(after).toMatchObject({ level: 1, exp: 0, alloc: {}, freePoints: spent.freePoints + 6 });
		for (const [a, n] of Object.entries(spent.attrs)) expect(after.attrs[a]).toBe(n - (before.talents![a] ?? 0) * (spent.level - 1));
		const grown = Object.values(after.talents!).reduce((x, y) => x + y, 0) - Object.values(before.talents!).reduce((x, y) => x + y, 0);
		expect(grown).toBeGreaterThanOrEqual(2);
		expect(grown).toBeLessThanOrEqual(6);
		expect(after.talent).toBe(before.talent + grown);
		expect(await card()).toEqual({ count: 1, max: 9 });
	});

	it('the Nth takes one time in N, sure after 2N failures in a row; not below level 90, not when busy, nine at most', async () => {
		const { p, at, hero, toLevel, card } = await heroAt90({ 'rebirth.rules': { max: 2 } });
		const id = (await hero()).id;
		await p.run(at, 'items.grant', { item: pill, count: 10 }, true);
		await p.run(at, `items.use.${pill}`, { hero: id });
		// Level 1 again: not yet.
		await expect(p.run(at, `items.use.${pill}`, { hero: id })).rejects.toThrow(/reborn from level/);
		await toLevel(90);
		// The second: 1 in 2, sure on the fifth try (after four failures).
		let tries = 0;
		while ((await card())!.count < 2) {
			await p.run(at, `items.use.${pill}`, { hero: id });
			tries++;
			expect(tries).toBeLessThanOrEqual(5);
		}
		expect((await hero()).level).toBe(1);
		// The most (here 2): no more.
		await toLevel(90);
		await expect(p.run(at, `items.use.${pill}`, { hero: id })).rejects.toThrow(/no more/);
	});

	it('fills the lowest talents first, ties at random', () => {
		const ids = ['might', 'leadership', 'strategy'];
		expect(fillTalents({ might: 3, leadership: 1, strategy: 1 }, ids, 3, () => 0)).toEqual({ leadership: 2, strategy: 1 });
		expect(fillTalents({ might: 2, leadership: 2, strategy: 2 }, ids, 3, () => 0.99)).toEqual({ might: 1, leadership: 1, strategy: 1 });
	});

	it('five stars for nine: half a star each for the first eight, the last whole one at the ninth', () => {
		expect(stars(1)).toEqual(['star-half', 'star-dim', 'star-dim', 'star-dim', 'star-dim']);
		expect(stars(2)).toEqual(['star', 'star-dim', 'star-dim', 'star-dim', 'star-dim']);
		expect(stars(8)).toEqual(['star', 'star', 'star', 'star', 'star-dim']);
		expect(stars(9)).toEqual(['star', 'star', 'star', 'star', 'star']);
	});

	it('a realm for each rebirth: a mortal, Qi Refining, Foundation Building … the ninth Tribulation, the last past it', () => {
		expect(realmText(0)).toEqual({ text: 'rebirth.realm:0' });
		expect(realmText(1)).toEqual({ text: 'rebirth.realm:1' });
		expect(realmText(2)).toEqual({ text: 'rebirth.realm:2' });
		expect(realmText(12)).toEqual({ text: 'rebirth.realm:9' });
	});
});
