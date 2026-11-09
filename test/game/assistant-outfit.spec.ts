/** The assistant's equipment steward (gameplay.md §15.4.2): who wears what, in the group's order, and the steps to it. Pure, no server. */
import { describe, expect, it } from 'vitest';
import type { HeroStatsTable } from '../../src/shared/realms';
import { numbersWith, outfit, type OutfitHero, type OutfitPiece, referenceOf, worth } from '../../web/plugins/assistant/outfit';

const hero = (id: string, attrs: Record<string, number> = {}, level = 10, accessories = 1): OutfitHero => ({
	id,
	level,
	gender: 'm',
	attrs,
	accessories,
});
const piece = (
	id: string,
	slot: string,
	stats: Record<string, number>,
	hero: string | null = null,
	extra: Partial<OutfitPiece> = {},
): OutfitPiece => ({
	id,
	slot,
	minLevel: 1,
	stats,
	hero,
	...extra,
});
const might = () => [{ target: 'attr:might' }];

describe('assistant equipment steward', () => {
	it('adds what is worn to attributes and lane numbers', () => {
		const h = hero('a', { might: 10 });
		const n = numbersWith(h, [piece('s', 'weapon', { 'attr.might': 5, 'battle.attack': 30 })], {}, [
			{ target: 'attr:might' },
			{ target: 'flat:attack' },
		]);
		expect(n).toEqual({ 'attr:might': 15, 'flat:attack': 30 });
	});

	it('counts every number in attribute points: what one point of the attribute serving it best gives', () => {
		// Adventure attack: 3 a point of might, 0.5 of leadership; defence 1.5 of leadership.
		const adventure: HeroStatsTable = { attack: { base: 10, might: 3, leadership: 0.5 }, defense: { base: 5, leadership: 1.5 } };
		expect(referenceOf('adv:attack', 10, { adventure })).toBe(3);
		expect(referenceOf('adv:defense', 10, { adventure })).toBe(1.5);
		expect(referenceOf('attr:might', 10, { adventure })).toBe(1);
		expect(referenceOf('flat:attack', 10, {})).toBe(1); // nothing baked: as it is
		// +30 adventure attack is worth 10 points; +3 might is worth 3 (itself) plus its 9 attack's 3.
		const h = hero('a');
		expect(worth(h, piece('w', 'weapon', { 'adv.attack': 30 }), { adventure }, [{ target: 'adv:attack' }])).toBeCloseTo(10);
		expect(
			worth(h, piece('w', 'weapon', { 'attr.might': 3 }), { adventure }, [{ target: 'attr:might' }, { target: 'adv:attack' }]),
		).toBeCloseTo(6);
		// Weights count as they are.
		expect(worth(h, piece('w', 'weapon', { 'adv.attack': 30 }), { adventure }, [{ target: 'adv:attack', weight: 2 }])).toBeCloseTo(20);
	});

	it('the first hero picks first, from storage and from those after it; those after take what is left', () => {
		const heroes = [hero('a'), hero('b')];
		const pieces = [piece('big', 'weapon', { 'attr.might': 9 }, 'b'), piece('small', 'weapon', { 'attr.might': 3 })];
		expect(outfit(heroes, pieces, might, {})).toEqual({
			steps: [
				{ piece: 'big', hero: 'a' },
				{ piece: 'small', hero: 'b' },
			],
			skipped: [],
		});
	});

	it('keeps what is better already, skips pieces above its level, and leaves heroes with no wants alone', () => {
		const pieces = [
			piece('worn', 'weapon', { 'attr.might': 5 }, 'a'),
			piece('weak', 'weapon', { 'attr.might': 2 }),
			piece('high', 'weapon', { 'attr.might': 50 }, null, { minLevel: 99 }),
			piece('kept', 'armor', { 'attr.wit': 1 }, 'b'),
		];
		expect(outfit([hero('a'), hero('b')], pieces, (id) => (id === 'a' ? might() : []), {}).steps).toEqual([]);
	});

	it('as few steps as it takes: what a better piece pushes off goes to storage with no step of its own', () => {
		const pieces = [piece('old', 'weapon', { 'attr.might': 1 }, 'a'), piece('new', 'weapon', { 'attr.might': 5 })];
		expect(outfit([hero('a')], pieces, might, {}).steps).toEqual([{ piece: 'new', hero: 'a' }]);
	});

	it('accessories: the best kinds up to the limit, a weaker kind taken off for a better one', () => {
		const pieces = [
			piece('ring', 'ring', { 'attr.might': 3 }, 'a', { group: 'accessory' }),
			piece('amulet', 'amulet', { 'attr.might': 9 }, null, { group: 'accessory' }),
		];
		// One allowed: the ring off first (no room for a second kind), then the amulet on.
		expect(outfit([hero('a', {}, 10, 1)], pieces, might, {}).steps).toEqual([
			{ piece: 'ring', hero: null },
			{ piece: 'amulet', hero: 'a' },
		]);
		// Two allowed: both.
		expect(outfit([hero('a', {}, 10, 2)], pieces, might, {}).steps).toEqual([{ piece: 'amulet', hero: 'a' }]);
	});

	it('in an order the storage allows at every step; what none allows is skipped', () => {
		// a takes b's better sword, b gets a's: the first step pushes one into storage (it needs a free place), the second
		// takes it out again.
		const heroes = [hero('a'), hero('b')];
		const pieces = [piece('x', 'weapon', { 'attr.might': 1 }, 'a'), piece('y', 'weapon', { 'attr.might': 9 }, 'b')];
		expect(outfit(heroes, pieces, might, {}, { stored: 0, capacity: 1 })).toEqual({
			steps: [
				{ piece: 'x', hero: 'b' },
				{ piece: 'y', hero: 'a' },
			],
			skipped: [],
		});
		expect(outfit(heroes, pieces, might, {}, { stored: 0, capacity: 0 })).toEqual({ steps: [], skipped: ['x', 'y'] });
		// From storage first, so the storage has room for what comes off later.
		const more = [...pieces, piece('z', 'armor', { 'attr.might': 2 })];
		const full = outfit(heroes, more, might, {}, { stored: 1, capacity: 1 });
		expect(full.steps[0]).toEqual({ piece: 'z', hero: 'a' });
		expect(full.skipped).toEqual([]);
	});
});
